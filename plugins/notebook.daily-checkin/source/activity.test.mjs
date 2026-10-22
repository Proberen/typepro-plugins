import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityTracker, countChanges, localDay } from './tracker.ts';
import { activityCalendar, activityDays, parseCalendarDay } from './data.ts';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const record = (day, document, device, added, removed, title = '正文') => ({
  key: `activity.${day}.${id(document)}.${id(device)}`,
  value: { day, documentId: id(document), title, added, removed },
});

test('character changes count Unicode code points and preserve matching text inside a replacement', () => {
  assert.deepEqual(countChanges('中文😀正文', '中文😃正文加'), { added: 2, removed: 1 });
  assert.deepEqual(countChanges('abc', 'acb'), { added: 1, removed: 1 });
  assert.deepEqual(countChanges('😀', ''), { added: 0, removed: 1 });
  assert.deepEqual(countChanges('正文', '正文'), { added: 0, removed: 0 });
  const before = '甲'.repeat(700) + '😀'.repeat(700) + '乙'.repeat(700);
  const after = '首' + before.slice(0, 700) + '中' + before.slice(700) + '尾';
  assert.deepEqual(countChanges(before, after), { added: 3, removed: 0 });
  assert.deepEqual(countChanges(after, before), { added: 0, removed: 3 });
});

test('short diffs agree with a reference Unicode longest-common-subsequence calculation', () => {
  let seed = 21;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const alphabet = ['甲', '乙', '😀', '😃', 'a'];
  const make = () => Array.from({ length: Math.floor(random() * 18) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  for (let iteration = 0; iteration < 150; iteration++) {
    const before = make(), after = make(), a = Array.from(before), b = Array.from(after);
    const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let x = 1; x <= a.length; x++) for (let y = 1; y <= b.length; y++) rows[x][y] = a[x - 1] === b[y - 1] ? rows[x - 1][y - 1] + 1 : Math.max(rows[x - 1][y], rows[x][y - 1]);
    const common = rows[a.length][b.length];
    assert.deepEqual(countChanges(before, after), { added: b.length - common, removed: a.length - common });
  }
});

test('grouped undo cancels the original calendar days and redo restores them', () => {
  let clock = new Date(2026, 9, 20, 23, 59);
  const tracker = new ActivityTracker(() => clock);
  assert.deepEqual(tracker.record(id(1), '', '甲'), [{ day: '2026-10-20', added: 1, removed: 0 }]);
  clock = new Date(2026, 9, 21, 0, 1);
  tracker.record(id(1), '甲', '甲😀');
  clock = new Date(2026, 9, 22, 12);
  tracker.record(id(1), '甲😀', '甲😀乙');
  const expected = [{ day: '2026-10-21', added: 1, removed: 0 }, { day: '2026-10-22', added: 1, removed: 0 }];
  assert.deepEqual(tracker.record(id(1), '甲😀乙', '甲', 'undo'), expected.map(delta => ({ ...delta, added: -delta.added })));
  assert.deepEqual(tracker.record(id(1), '甲', '甲😀乙', 'redo'), expected);
});

test('external resets, unknown history, and no-op updates cannot count machine writes as edits', () => {
  const tracker = new ActivityTracker(() => new Date(2026, 9, 22));
  tracker.record(id(1), '', '甲');
  tracker.reset(id(1));
  assert.deepEqual(tracker.record(id(1), 'AI 正文', '旧正文', 'undo'), []);
  assert.deepEqual(tracker.record(id(1), '旧正文', 'AI 正文', 'redo'), []);
  assert.deepEqual(tracker.record(id(1), '新的外部正文', '新的外部正文'), []);
  for (let number = 2; number < 30; number++) tracker.record(id(number), '无变化', '无变化');
  assert.equal(tracker.sessions.size, 0);
});

test('history has step and byte bounds; large documents keep only the current baseline', () => {
  const tracker = new ActivityTracker(() => new Date(2026, 9, 22));
  let value = '';
  for (let step = 0; step < 150; step++) { tracker.record(id(1), value, value + '甲'); value += '甲'; }
  assert.ok(tracker.sessions.get(id(1)).undo.length <= 64);
  const bytes = session => 2 * (session.current.length + [...session.undo, ...session.redo].reduce((sum, step) => sum + step.before.length + step.after.length, 0));
  const large = '甲'.repeat(700000);
  for (let document = 1; document <= 12; document++) tracker.record(id(document), '', large);
  assert.ok(tracker.sessions.size <= 8);
  assert.ok([...tracker.sessions.values()].reduce((sum, session) => sum + bytes(session), 0) <= 4 * 1024 * 1024);
  for (const session of tracker.sessions.values()) {
    assert.equal(session.current, large);
    assert.equal(session.undo.length + session.redo.length, 0);
  }
});

test('heatmap combines per-device and per-document records without showing invalid or negative data', () => {
  const day = '2026-10-22';
  const entries = [record(day, 1, 1, 12, 3, '一'), record(day, 1, 2, 8, 4, '一'), record(day, 2, 2, 5, 0, '二'), record(day, 3, 1, -1, 0), record('2026-02-30', 4, 1, 9, 0), { key: 'settings', value: { added: 99 } }];
  const days = activityDays(entries), value = days.get(day);
  assert.equal(days.size, 1);
  assert.equal(value.added, 25);
  assert.equal(value.removed, 7);
  assert.deepEqual(value.documents.map(document => [document.title, document.added, document.removed]), [['一', 20, 7], ['二', 5, 0]]);
  assert.equal(activityDays([{ ...record(day, 1, 1, 1, 0), key: `activity.${day}.${id(1)}.bad-device` }]).size, 0);
  assert.equal(activityDays([record(day, 1, 1, 0, 0)]).get(day).added, 0);
});

test('the annual calendar contains 365 real dates on Sunday-first weeks across leap years and local DST', () => {
  for (const today of ['2026-10-22', '2024-03-10', '2024-11-03', '2024-02-29']) {
    const calendar = activityCalendar(today);
    const visible = calendar.days.filter(day => day && day >= calendar.start);
    assert.equal(visible.length, 365);
    assert.equal(visible.at(-1), today);
    assert.equal(new Set(visible).size, 365);
    assert.equal(calendar.days.length % 7, 0);
    assert.equal(parseCalendarDay(calendar.days[0]).getDay(), 0);
    assert.ok(visible.every(day => localDay(parseCalendarDay(day)) === day));
  }
  assert.equal(parseCalendarDay('2026-02-30'), null);
  assert.deepEqual(activityCalendar('invalid'), { days: [], weeks: 0, start: 'invalid' });
});
