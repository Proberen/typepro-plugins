// Provider protocol belongs to this plugin. The shell transports raw HTTPS bytes only.
import { notebook } from "./sdk";
import { validBaseUrl } from "./data";
import type { AiEvent, AiMessage, AiResponse, ToolCall } from "./types";

const abort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("会话已停止", "AbortError"); };
const credentialId = (provider: string) => `model.${provider}`;
const checkStatus = (status: number) => {
  if (status === 401 || status === 403) throw new Error("模型服务拒绝授权，请检查当前设备的 Key 和账号权限");
  if (status === 429) throw new Error("模型服务请求过于频繁或额度不足，请稍后重试");
  if (status < 200 || status >= 300) throw new Error(`模型服务请求失败（${status}）`);
};

/** Handles fragmented/multiline SSE and fragmented function-call arguments. */
export function responseStream(onDelta: (event: AiEvent) => void) {
  let pending = "", data: string[] = [], content = "", reasoning = "", finishReason: string | undefined;
  let ended = false, decoded = false, outputSize = 0;
  const calls = new Map<number, ToolCall>();
  const frame = () => {
    if (!data.length || ended) { data = []; return; }
    const value = data.join("\n"); data = [];
    if (value.trim() === "[DONE]") { ended = true; return; }
    let json: Record<string, unknown>;
    try { json = JSON.parse(value); } catch { throw new Error("模型返回的流式内容无效"); }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("模型流式消息格式无效");
    if (json.error) throw new Error("模型服务返回错误，请检查模型配置或账号额度");
    decoded = true;
    const choices = json.choices;
    if (!Array.isArray(choices) || !choices[0]) return;
    const choice = choices[0];
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta || typeof delta !== "object") return;
    if (typeof delta.content === "string") { content += delta.content; outputSize += delta.content.length; onDelta({type: "delta", text: delta.content}); }
    if (typeof delta.reasoning_content === "string") { reasoning += delta.reasoning_content; outputSize += delta.reasoning_content.length; onDelta({type: "reasoning", text: delta.reasoning_content}); }
    if (Array.isArray(delta.tool_calls)) for (const fragment of delta.tool_calls) {
      const index = fragment?.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 32) throw new Error("模型返回的工具调用索引无效");
      const call: ToolCall = calls.get(index) || {id: "", type: "function", function: {name: "", arguments: ""}};
      if (typeof fragment.id === "string") call.id += fragment.id;
      if (fragment.type !== undefined && fragment.type !== "function") throw new Error("模型返回了不支持的工具类型");
      if (typeof fragment.function?.name === "string") call.function.name += fragment.function.name;
      if (typeof fragment.function?.arguments === "string") { call.function.arguments += fragment.function.arguments; outputSize += fragment.function.arguments.length; }
      if (call.id.length > 200 || call.function.name.length > 64 || call.function.arguments.length > 600000) throw new Error("模型工具调用超出内容限制");
      calls.set(index, call);
    }
    if (outputSize > 1500000) throw new Error("模型回复超过内容限制，请分步继续");
  };
  const line = (value: string) => {
    if (!value) frame();
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  return {
    push(chunk: string) {
      if (ended) return;
      pending += chunk;
      if (pending.length > 2 * 1024 * 1024) throw new Error("模型流式消息过长");
      for (;;) {
        const match = /\r\n|\n|\r/.exec(pending);
        if (!match || (match[0] === "\r" && match.index === pending.length - 1)) break;
        line(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length);
      }
    },
    finish(): AiResponse {
      if (pending) line(pending.replace(/\r$/, ""));
      frame();
      if (!decoded) throw new Error("模型未返回可读取的流式回复");
      if (!ended && !finishReason) throw new Error("模型连接提前中断，请重试");
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (toolCalls.some(call => !call.id || !call.function.name)) throw new Error("模型返回的工具调用不完整");
      onDelta({type: "done"});
      return {content, ...(reasoning ? {reasoningContent: reasoning} : {}), ...(toolCalls.length ? {toolCalls} : {}), ...(finishReason ? {finishReason} : {})};
    },
  };
}

export const aiNative = {
  keyStatus(providerId: string, baseUrl: string) {
    return notebook.secrets.status(credentialId(providerId), {origin: new URL(validBaseUrl(baseUrl)).origin});
  },
  async saveKey(providerId: string, baseUrl: string) {
    const origin = new URL(validBaseUrl(baseUrl)).origin;
    if (!await notebook.network.authorize(origin)) return {configured: false};
    return notebook.secrets.configure(credentialId(providerId), {label: "模型服务 API Key", origin});
  },
  removeKey(providerId: string) { return notebook.secrets.remove(credentialId(providerId)); },
  async models(providerId: string, baseUrl: string) {
    const response = await notebook.network.request({url: `${validBaseUrl(baseUrl)}/models`, credential: {id: credentialId(providerId)}});
    checkStatus(response.status);
    let value: unknown;
    try { value = JSON.parse(response.body); } catch { throw new Error("模型列表格式无效，可手动填写模型名称"); }
    const data = (value as {data?: unknown})?.data;
    if (!Array.isArray(data)) throw new Error("模型列表格式无效，可手动填写模型名称");
    return data.flatMap(item => item && typeof item.id === "string" && item.id.length <= 200 ? [{id: item.id, ...(typeof item.name === "string" ? {name: item.name.slice(0,200)} : {})}] : []).slice(0,500);
  },
  async chat(request: {providerId: string; baseUrl: string; model: string; messages: AiMessage[]; tools?: unknown[]; thinking?: boolean}, onDelta: (event: AiEvent) => void, signal: AbortSignal): Promise<AiResponse> {
    abort(signal);
    const stream = responseStream(value => { abort(signal); onDelta(value); });
    const response = await notebook.network.stream({
      url: `${validBaseUrl(request.baseUrl)}/chat/completions`, method: "POST",
      headers: {"Content-Type": "application/json", Accept: "text/event-stream"}, credential: {id: credentialId(request.providerId)},
      body: JSON.stringify({model: request.model, messages: request.messages, stream: true, ...(request.tools?.length ? {tools: request.tools} : {}), ...(request.thinking === undefined ? {} : {thinking: {type: request.thinking ? "enabled" : "disabled"}})}),
    }, chunk => { abort(signal); stream.push(chunk); }, {signal});
    abort(signal); checkStatus(response.status);
    return stream.finish();
  },
};
