import { assistantDefaultPrompt, builtinSkills } from "./skills.ts";
import type { AssistantAdapter, AssistantSettings, AssistantSkill, ChatMessage, Conversation } from "./types";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown): value is string => typeof value === "string" && value.length < 40 && Number.isFinite(Date.parse(value));

export function validBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("接口地址需要使用不含账号、查询参数或片段的 HTTPS URL");
  return url.href.replace(/\/+$/, "");
}

export function readSettings(adapter: AssistantAdapter, prompt = assistantDefaultPrompt): AssistantSettings {
  const value = adapter.getData("settings");
  const initial: AssistantSettings = { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "", systemPrompt: prompt, thinking: false };
  if (!record(value)) return initial;
  const provider = value.provider === "custom" ? "custom" : "deepseek";
  let baseUrl = "https://api.deepseek.com";
  if (provider === "custom" && typeof value.baseUrl === "string" && value.baseUrl.length < 2048) { try { baseUrl = validBaseUrl(value.baseUrl); } catch { return initial; } }
  return { provider, baseUrl, model: typeof value.model === "string" ? value.model.slice(0, 200) : "", systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt.slice(0, 20000) : prompt, thinking: value.thinking === true };
}

export function readConversations(adapter: AssistantAdapter): Conversation[] {
  // Keep deletion separate from mutable titles/timestamps: an offline continuation
  // must not resurrect a conversation another device deleted.
  const deleted = new Set(adapter.listData("conversation-deleted.").flatMap(({ key, value }) =>
    record(value) && uuid(value.id) && value.deleted === true && key === `conversation-deleted.${value.id}` ? [value.id] : []));
  return adapter.listData("conversation.").flatMap(({ key, value }) => {
    if (!record(value) || value.deleted || !uuid(value.id) || deleted.has(value.id) || key !== `conversation.${value.id}` || typeof value.title !== "string" || !date(value.createdAt) || !date(value.updatedAt)) return [];
    return [{ id: value.id, title: value.title.slice(0, 120), createdAt: value.createdAt, updatedAt: value.updatedAt, ...(typeof value.skillId === "string" ? { skillId: value.skillId.slice(0, 100) } : {}) }];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function readMessages(adapter: AssistantAdapter, conversationId: string): ChatMessage[] {
  return adapter.listData(`message.${conversationId}.`).flatMap(({ key, value }) => {
    if (!record(value) || !uuid(value.id) || key !== `message.${conversationId}.${value.id}` || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string" || value.content.length > 400000 || !date(value.createdAt)) return [];
    const sources = Array.isArray(value.sources) ? value.sources.flatMap(source => record(source) && uuid(source.id) && typeof source.title === "string" ? [{ id: source.id, title: source.title.slice(0, 160) }] : []).slice(0, 100) : [];
    const status = value.status === "stopped" || value.status === "error" ? value.status : "complete";
    return [{ id: value.id, role: value.role, content: value.content, createdAt: value.createdAt, status, sources } as ChatMessage];
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function readSkills(adapter: AssistantAdapter): AssistantSkill[] {
  const imported = adapter.listData("skill.").flatMap(({ key, value }) => {
    if (!record(value) || value.deleted || !uuid(value.id) || key !== `skill.${value.id}` || typeof value.name !== "string" || typeof value.instructions !== "string" || value.instructions.length > 65536) return [];
    const references = Array.isArray(value.references) ? value.references.flatMap(reference => record(reference) && typeof reference.path === "string" && reference.path.length < 512 && typeof reference.text === "string" && reference.text.length <= 131072 ? [{ path: reference.path, text: reference.text }] : []).slice(0, 128) : [];
    return [{ id: value.id, name: value.name.slice(0, 80), description: typeof value.description === "string" ? value.description.slice(0, 300) : "", instructions: value.instructions, references }];
  });
  return [...builtinSkills, ...imported];
}
