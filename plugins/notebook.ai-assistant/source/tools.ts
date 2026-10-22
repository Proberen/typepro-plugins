import type { AssistantAdapter, AssistantNote, AssistantSkill, NoteSource, ToolCall } from "./types";

const string = { type: "string" };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
export const assistantTools = [
  definition("list_notes", "列出笔记本和文档标题。分页读取，不返回正文。", { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  definition("search_notes", "按关键词搜索所有本地笔记的标题和正文，返回简短命中片段。", { query: string, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
  definition("read_note", "按文档 id 读取 Markdown，长文档使用 offset/length 分段读取。", { id: string, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 40000 } }, ["id"]),
  definition("read_current_note", "读取用户当前正在编辑的笔记，包含尚未切换的最新正文。", { offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 40000 } }),
  definition("create_note", "向已有笔记本创建文档。必须由用户在差异预览中确认后才会写入。", { notebookId: string, title: string, markdown: string }, ["notebookId", "title", "markdown"]),
  definition("update_note", "替换文档正文。必须先完整读取当前文档；宿主展示差异并经用户确认，且正文未变化，才会写入。", { id: string, markdown: string }, ["id", "markdown"]),
  definition("read_skill_reference", "读取当前选中 Skill 的一份文本参考资料，不执行任何代码。", { path: string, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 20000 } }, ["path"]),
];

function args(call: ToolCall, keys: string[]) {
  if (call.function.arguments.length > 600000) throw new Error("工具参数过长");
  const value: unknown = JSON.parse(call.function.arguments);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("工具参数格式无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(`${name}无效或过长`);
  return value;
}
function id(value: unknown) {
  const result = text(value, "文档 id", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new Error("文档 id 无效");
  return result;
}
function integer(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("分页参数无效");
  return value as number;
}
function abort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("会话已停止", "AbortError");
}

export function createToolRunner(options: {
  adapter: () => AssistantAdapter;
  skill: AssistantSkill | undefined;
  signal: AbortSignal;
  source: (source: NoteSource) => void;
  progress: (label: string) => void;
}) {
  // Updates require a snapshot actually read in this turn, never a guessed old body.
  const snapshots = new Map<string, { markdown: string; ranges: [number, number][] }>();
  const declined = new Set<string>();
  let reads = 0;
  const readSlice = (note: AssistantNote | null, parameters: Record<string, unknown>) => {
    if (!note) return { found: false };
    const offset = integer(parameters.offset, 0, 0, note.markdown.length);
    const length = integer(parameters.length, 20000, 1, 40000);
    reads += Math.min(length, note.markdown.length - offset);
    if (reads > 300000) throw new Error("本轮已读取较多笔记，请缩小范围后继续");
    const previous = snapshots.get(note.id);
    const current = previous?.markdown === note.markdown ? previous : { markdown: note.markdown, ranges: [] };
    current.ranges.push([offset, Math.min(offset + length, note.markdown.length)]);
    snapshots.set(note.id, current);
    options.source({ id: note.id, title: note.title });
    return { id: note.id, title: note.title, markdown: note.markdown.slice(offset, offset + length), offset, totalLength: note.markdown.length, hasMore: offset + length < note.markdown.length, citation: `typepro://note/${note.id}` };
  };
  return async (call: ToolCall): Promise<string> => {
    abort(options.signal);
    try {
      const adapter = options.adapter();
      let result: unknown;
      switch (call.function.name) {
        case "list_notes": {
          options.progress("浏览笔记目录");
          const input = args(call, ["offset", "limit"]);
          const documents = (await adapter.listNotes()).flatMap(book => book.documents.map(note => ({ notebookId: book.id, notebook: book.name, ...note })));
          const offset = integer(input.offset, 0, 0, documents.length), limit = integer(input.limit, 50, 1, 100);
          result = { documents: documents.slice(offset, offset + limit), total: documents.length, hasMore: offset + limit < documents.length };
          break;
        }
        case "search_notes": {
          options.progress("搜索笔记");
          const input = args(call, ["query", "limit"]), query = text(input.query, "搜索词", 200).trim().toLocaleLowerCase();
          if (!query) throw new Error("搜索词不能为空");
          const limit = integer(input.limit, 10, 1, 20);
          const found = await adapter.searchNotes(query, limit);
          abort(options.signal);
          for (const note of found.results) options.source({id: note.id, title: note.title});
          result = {matches: found.results.map(note => ({...note, citation: `typepro://note/${note.id}`})), limited: found.hasMore};
          break;
        }
        case "read_note": {
          options.progress("读取笔记");
          const input = args(call, ["id", "offset", "length"]);
          result = readSlice(await adapter.readNote(id(input.id)), input);
          break;
        }
        case "read_current_note": {
          options.progress("读取当前笔记");
          const input = args(call, ["offset", "length"]);
          result = readSlice(await adapter.activeNote(), input);
          break;
        }
        case "create_note": {
          const input = args(call, ["notebookId", "title", "markdown"]), notebookId = id(input.notebookId);
          const title = text(input.title, "标题", 160).trim(), markdown = text(input.markdown, "正文", 150000);
          if (!title || !(await adapter.listNotes()).some(book => book.id === notebookId)) throw new Error("目标笔记本不存在或标题为空");
          const signature = JSON.stringify(["create", notebookId, title, markdown]);
          if (declined.has(signature)) throw new Error("用户已拒绝此修改，不得重复请求");
          options.progress("等待确认新建文档");
          const applied = await adapter.reviewChanges({ notebookId, title, markdown }, options.signal);
          abort(options.signal);
          if (!applied.applied) declined.add(signature);
          result = applied.applied ? { created: true, documentId: applied.documentId } : { cancelled: true, message: "用户未批准写入，不得重试相同修改" };
          break;
        }
        case "update_note": {
          const input = args(call, ["id", "markdown"]), documentId = id(input.id), markdown = text(input.markdown, "正文", 150000);
          const note = await adapter.readNote(documentId), snapshot = snapshots.get(documentId);
          if (!note || !snapshot || snapshot.markdown !== note.markdown) throw new Error("文档尚未读取或内容已变化，请重新读取完整正文");
          let covered = 0;
          for (const [start, end] of [...snapshot.ranges].sort((a, b) => a[0] - b[0])) { if (start > covered) break; covered = Math.max(covered, end); }
          if (covered < note.markdown.length) throw new Error("尚未读取完整文档，不能替换全文");
          if (markdown === note.markdown) { result = { unchanged: true }; break; }
          const signature = JSON.stringify(["update", documentId, markdown]);
          if (declined.has(signature)) throw new Error("用户已拒绝此修改，不得重复请求");
          options.progress("等待确认修改");
          const applied = await adapter.reviewChanges({ documentId, title: note.title, markdown, expectedMarkdown: note.markdown }, options.signal);
          abort(options.signal);
          if (!applied.applied) declined.add(signature);
          result = applied.applied ? { updated: true, documentId: applied.documentId } : { cancelled: true, message: "用户未批准写入，不得重试相同修改" };
          break;
        }
        case "read_skill_reference": {
          const input = args(call, ["path", "offset", "length"]), path = text(input.path, "参考资料路径", 512);
          const reference = options.skill?.references.find(file => file.path === path);
          if (!reference) throw new Error("当前 Skill 中没有此参考资料");
          const offset = integer(input.offset, 0, 0, reference.text.length), length = integer(input.length, 10000, 1, 20000);
          result = { path, text: reference.text.slice(offset, offset + length), offset, totalLength: reference.text.length, hasMore: offset + length < reference.text.length };
          break;
        }
        default: throw new Error("不支持的工具");
      }
      abort(options.signal);
      return JSON.stringify(result);
    } catch (error) {
      if (options.signal.aborted) throw error;
      return JSON.stringify({ error: error instanceof Error ? error.message : "工具调用失败" });
    }
  };
}

