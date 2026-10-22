import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { readConversations, readMessages, readSettings } from './data.ts';
import { parseSkill } from './skills.ts';
import { createToolRunner } from './tools.ts';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = number => `2026-10-22T12:00:0${number}.000Z`;
const pluginId = 'test.assistant';
const record = (key, value, number = 1, device = 1) => ({ pluginId, key, value, updatedAt: time(number), deviceId: id(device) });
function storage(entries) {
  return {
    getData: key => entries.find(entry => entry.key === key && !entry.deleted)?.value,
    listData: prefix => entries.filter(entry => entry.key.startsWith(prefix) && !entry.deleted).map(({ key, value }) => ({ key, value })),
  };
}
const conversation = (updated = 1) => ({ id: id(1), title: '会话', createdAt: time(1), updatedAt: time(updated) });
const message = (number, role, content, created = number) => record(`message.${id(1)}.${id(number)}`, { id: id(number), role, content, createdAt: time(created) }, created);

test('separate device message records remain visible while a deletion prevents chat resurrection', () => {
  const entries = [record(`conversation.${id(1)}`, conversation(7), 7, 2), message(2, 'user', 'Mac 问题'), message(3, 'assistant', 'Mac 答复'), message(5, 'user', '安卓问题'), message(6, 'assistant', '安卓答复'), record(`conversation-deleted.${id(1)}`, { id: id(1), deleted: true, deletedAt: time(4) }, 4)];
  const adapter = storage(entries);
  assert.deepEqual(readMessages(adapter, id(1)).map(item => item.content), ['Mac 问题', 'Mac 答复', '安卓问题', '安卓答复']);
  assert.deepEqual(readConversations(adapter), []);
});

test('synchronized settings expose only model preferences and never restore credentials into writable settings', () => {
  const settings = readSettings(storage([record('settings', { provider: 'custom', baseUrl: 'https://example.com/v1/', model: 'model-id', systemPrompt: '简洁回答', thinking: true, apiKey: 'secret', key: 'secret', accessToken: 'secret' })]));
  assert.deepEqual(settings, { provider: 'custom', baseUrl: 'https://example.com/v1', model: 'model-id', systemPrompt: '简洁回答', thinking: true });
  assert.equal(JSON.stringify(settings).includes('secret'), false);
});

function toolHarness(approve = async () => true) {
  const controller = new AbortController(), approvals = [], writes = [];
  const note = { id: id(2), title: '文档', markdown: '第一段\n第二段\n结尾', updatedAt: time(1) };
  const adapter = {
    listNotes: async () => [{ id: id(3), name: '笔记本', documents: [{ id: note.id, title: note.title, updatedAt: note.updatedAt }] }],
    readNote: async requested => requested === note.id ? { ...note } : null,
    activeNote: async () => ({ ...note }),
    reviewChanges: async (proposal, signal) => {
      approvals.push(proposal);
      const accepted = await approve(proposal, {note, controller});
      if (signal.aborted) throw new DOMException('会话已停止', 'AbortError');
      if (!accepted) return {applied: false};
      writes.push({kind: proposal.documentId ? 'update' : 'create', ...proposal});
      if (proposal.documentId && note.markdown !== proposal.expectedMarkdown) throw new Error('文档已发生变化');
      if (proposal.documentId) note.markdown = proposal.markdown;
      return {applied: true, documentId: proposal.documentId || id(4)};
    },
  };
  const run = createToolRunner({adapter: () => adapter, signal: controller.signal, skill: undefined, source: () => {}, progress: () => {}});
  return { note, controller, approvals, writes,
    call: async (name, parameters) => JSON.parse(await run({ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(parameters) } })),
  };
}

test('replacing a note requires complete current content, including all pages, before confirmation is offered', async () => {
  const h = toolHarness(), original = h.note.markdown;
  assert.match((await h.call('update_note', { id: h.note.id, markdown: '改写' })).error, /尚未读取/);
  await h.call('read_note', { id: h.note.id, offset: 0, length: 3 });
  assert.match((await h.call('update_note', { id: h.note.id, markdown: '改写' })).error, /完整文档/);
  assert.equal(h.approvals.length, 0);
  await h.call('read_note', { id: h.note.id, offset: 3, length: original.length - 3 });
  assert.equal((await h.call('update_note', { id: h.note.id, markdown: '改写' })).updated, true);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.writes[0].expectedMarkdown, original);
});

test('a rejected proposal cannot prompt again in the same turn and cancellation never writes', async () => {
  const denied = toolHarness(async () => false), parameters = { notebookId: id(3), title: '新文档', markdown: '正文' };
  assert.equal((await denied.call('create_note', parameters)).cancelled, true);
  assert.match((await denied.call('create_note', parameters)).error, /已拒绝/);
  assert.equal(denied.approvals.length, 1);
  assert.deepEqual(denied.writes, []);
  const cancelled = toolHarness(async (_, { controller }) => { controller.abort(); return true; });
  await assert.rejects(cancelled.call('create_note', parameters), { name: 'AbortError' });
  assert.deepEqual(cancelled.writes, []);
  await assert.rejects(cancelled.call('read_current_note', {}), { name: 'AbortError' });
});

test('approval retains the reviewed snapshot so a concurrent edit is rejected by the host contract', async () => {
  const h = toolHarness(async (_, { note }) => { note.markdown = '其他设备的新内容'; return true; });
  const original = h.note.markdown;
  await h.call('read_current_note', {});
  const result = await h.call('update_note', { id: h.note.id, markdown: 'AI 改写' });
  assert.match(result.error, /已发生变化/);
  assert.equal(h.writes[0].expectedMarkdown, original);
  assert.equal(h.note.markdown, '其他设备的新内容');
});

const zip = files => zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])));
test('Skill ZIP rejects unsafe paths, multiple instructions, and oversized decompressed files', () => {
  for (const path of ['../SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'nested/../SKILL.md', 'nested\\SKILL.md']) {
    assert.throws(() => parseSkill('skill.zip', zip({ [path]: '# Skill' }), () => id(1)), /不安全路径/);
  }
  assert.throws(() => parseSkill('skill.zip', zip({ 'SKILL.md': '# 一', 'nested/SKILL.md': '# 二' }), () => id(1)), /只能有一份/);
  assert.throws(() => parseSkill('skill.zip', zip({ 'SKILL.md': '# Skill', 'large.txt': 'a'.repeat(128 * 1024 + 1) }), () => id(1)), /容量限制/);
});

test('Skill imports instructions and scoped text references while excluding scripts, images, and sibling files', () => {
  const result = parseSkill('skill.zip', zip({ 'example/SKILL.md': '# 测试 Skill\n\n整理笔记。', 'example/references/context.md': '参考正文', 'example/run.py': 'print("never run")', 'example/image.png': 'not an image', 'outside.txt': '不属于此 Skill' }), () => id(1));
  assert.equal(result.skill.name, '测试 Skill');
  assert.deepEqual(result.skill.references, [{ path: 'references/context.md', text: '参考正文' }]);
  assert.equal(result.ignored, 3);
});
