import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown, FileText, LoaderCircle, Menu, Plus, Settings, Sparkles, Square, Trash2, Upload, X } from "lucide-react";
import Modal from "./Modal";
import { notebook, uuid } from "./sdk";
import { readConversations, readMessages, readSettings, readSkills, validBaseUrl } from "./data";
import { aiNative } from "./native";
import { assistantDefaultPrompt, assistantSafetyPrompt, parseSkill } from "./skills";
import { assistantTools, createToolRunner } from "./tools";
import MarkdownText from "./MarkdownText";
import type { AiMessage, AssistantAdapter, AssistantSettings, AssistantSkill, ChatMessage, Conversation, NoteSource } from "./types";
import "./assistant.css";

export interface AssistantPageProps {
  pluginId: string;
  title: string;
  defaultSystemPrompt?: string;
  adapter: AssistantAdapter;
  initiallyOpenSettings?: boolean;
  onBack(): void;
  onOpenDocument(id: string): void;
}

const messageText = (error: unknown) => error instanceof Error ? error.message : String(error);
const messageKey = (conversationId: string, id: string) => `message.${conversationId}.${id}`;

async function chooseSkillFile() {
  const file = await notebook.files.pick({ extensions: ["md", "zip"] });
  return file ? { name: file.name, bytes: new Uint8Array(file.bytes) } : null;
}

export default function AssistantPage({ pluginId, title, defaultSystemPrompt = assistantDefaultPrompt, adapter, initiallyOpenSettings = false, onBack, onOpenDocument }: AssistantPageProps) {
  const adapterRef = useRef(adapter); adapterRef.current = adapter;
  const [conversations, setConversations] = useState(() => readConversations(adapter));
  const [selectedId, setSelectedId] = useState<string | null>(() => readConversations(adapter)[0]?.id || null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => { const id = readConversations(adapter)[0]?.id; return id ? readMessages(adapter, id) : []; });
  const [skills, setSkills] = useState(() => readSkills(adapter));
  const [skillId, setSkillId] = useState(() => readConversations(adapter)[0]?.skillId || "builtin.question");
  const [settings, setSettings] = useState(() => readSettings(adapter, defaultSystemPrompt));
  const [draftSettings, setDraftSettings] = useState(settings);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(initiallyOpenSettings);
  const [settingsTab, setSettingsTab] = useState<"model" | "prompt" | "skills">("model");
  const [mobileHistory, setMobileHistory] = useState(false);
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  const [keyReady, setKeyReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const activeRun = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const scroll = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const settingsRef = useRef(settings); settingsRef.current = settings;

  const refresh = useCallback(() => {
    const next = readConversations(adapterRef.current);
    setConversations(next); setSkills(readSkills(adapterRef.current));
    const selection = selectedRef.current;
    if (selection && !next.some(item => item.id === selection)) {
      activeRun.current?.abort();
      selectedRef.current = null; setSelectedId(null); setMessages([]);
    }
    else if (activeRun.current) return;
    else if (selection) setMessages(readMessages(adapterRef.current, selection));
  }, []);

  useEffect(() => { refresh(); }, [adapter, refresh]);
  useEffect(() => {
    if (!activeRun.current && !settingsOpen) setSettings(readSettings(adapterRef.current, defaultSystemPrompt));
  }, [adapter, defaultSystemPrompt, settingsOpen]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRun.current?.abort(); };
  }, []);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, progress]);
  useEffect(() => {
    let alive = true;
    setKeyReady(false); setModels([]);
    void aiNative.keyStatus(settings.provider, settings.baseUrl).then(async ready => {
      if (!alive) return;
      setKeyReady(ready);
      if (ready) {
        try { const found = await aiNative.models(settings.provider, settings.baseUrl); if (alive) setModels(found); }
        catch { /* A compatible server may use manually entered model ids. */ }
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [settings.provider, settings.baseUrl]);

  function stop() { activeRun.current?.abort(); }
  function leave() { stop(); onBack(); }
  function openSettings(tab: typeof settingsTab = "model") {
    setDraftSettings(settingsRef.current); setSettingsTab(tab); setSettingsOpen(true); setError(""); setNotice("");
  }
  function pickConversation(conversation: Conversation) {
    if (activeRun.current) return;
    setSelectedId(conversation.id); selectedRef.current = conversation.id;
    setMessages(readMessages(adapterRef.current, conversation.id)); setSkillId(conversation.skillId || "builtin.question");
    setMobileHistory(false); setError(""); setNotice("");
  }
  function newConversation() {
    if (activeRun.current) return;
    setSelectedId(null); selectedRef.current = null; setMessages([]); setInput(""); setMobileHistory(false); setError("");
    inputRef.current?.focus();
  }
  async function removeConversation(conversation: Conversation) {
    if (activeRun.current) return;
    try {
      await adapterRef.current.setData(`conversation-deleted.${conversation.id}`, { id: conversation.id, deleted: true, deletedAt: new Date().toISOString() });
      if (selectedRef.current === conversation.id) { selectedRef.current = null; setSelectedId(null); setMessages([]); }
      refresh();
    } catch (cause) { setError(messageText(cause)); }
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next: AssistantSettings = { ...draftSettings, baseUrl: draftSettings.provider === "deepseek" ? "https://api.deepseek.com" : validBaseUrl(draftSettings.baseUrl), model: draftSettings.model.trim() };
      if (next.model.length > 200 || next.systemPrompt.length > 20000) throw new Error("模型名称或系统提示词过长");
      if (!await notebook.network.authorize(new URL(next.baseUrl).origin)) throw new Error("尚未允许访问此模型服务");
      await adapterRef.current.setData("settings", next);
      settingsRef.current = next; setSettings(next); setDraftSettings(next);
      const ready = await aiNative.keyStatus(next.provider, next.baseUrl);
      setKeyReady(ready);
      if (ready) {
        try {
          const found = await aiNative.models(next.provider, next.baseUrl); setModels(found);
          if (!next.model && found[0]) {
            const selected = { ...next, model: found[0].id };
            await adapterRef.current.setData("settings", selected); settingsRef.current = selected; setSettings(selected); setDraftSettings(selected);
          }
        } catch (cause) { setNotice(`设置已保存，模型列表读取失败，可手动填写模型名称。${messageText(cause)}`); return; }
      }
      setNotice(ready ? "设置已保存" : "设置已保存，请为当前设备填写 API Key");
    } catch (cause) { setError(messageText(cause)); }
    finally { setBusy(false); }
  }
  async function configureKey() {
    if (busy || working) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const baseUrl = draftSettings.provider === "deepseek" ? "https://api.deepseek.com" : validBaseUrl(draftSettings.baseUrl);
      const result = await aiNative.saveKey(draftSettings.provider, baseUrl);
      if (!result.configured) return;
      const next = { ...draftSettings, baseUrl };
      await adapterRef.current.setData("settings", next);
      settingsRef.current = next; setSettings(next); setDraftSettings(next); setKeyReady(true);
      let found: {id: string; name?: string}[];
      try { found = await aiNative.models(next.provider, next.baseUrl); setModels(found); }
      catch (cause) { setNotice(`本机 Key 已保存，模型列表读取失败，可手动填写模型名称。${messageText(cause)}`); return; }
      if (!next.model && found[0]) {
        const selected = { ...next, model: found[0].id };
        await adapterRef.current.setData("settings", selected); settingsRef.current = selected; setSettings(selected); setDraftSettings(selected);
      }
      setNotice("本机 Key 已配置");
    } catch (cause) { setError(messageText(cause)); }
    finally { setBusy(false); }
  }
  async function changeModel(model: string) {
    if (working || busy) return;
    const next = { ...settingsRef.current, model };
    try { await adapterRef.current.setData("settings", next); settingsRef.current = next; setSettings(next); }
    catch (cause) { setError(messageText(cause)); }
  }
  async function importSkill() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const file = await chooseSkillFile(); if (!file) return;
      if (readSkills(adapterRef.current).filter(skill => !skill.builtin).length >= 16) throw new Error("最多导入 16 个 Skill");
      const { skill, ignored } = parseSkill(file.name, file.bytes, uuid);
      await adapterRef.current.setData(`skill.${skill.id}`, skill); setSkills(readSkills(adapterRef.current));
      setNotice(ignored ? `已导入 ${skill.name}，忽略 ${ignored} 个非文本参考文件或程序文件` : `已导入 ${skill.name}`);
    } catch (cause) { setError(messageText(cause)); }
    finally { setBusy(false); }
  }
  async function removeSkill(skill: AssistantSkill) {
    if (busy || skill.builtin) return;
    setBusy(true);
    try {
      await adapterRef.current.setData(`skill.${skill.id}`, { ...skill, deleted: true });
      setSkills(readSkills(adapterRef.current)); if (skillId === skill.id) setSkillId("builtin.question");
    } catch (cause) { setError(messageText(cause)); }
    finally { setBusy(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const question = input.trim();
    if (!question || activeRun.current || busy) return;
    if (question.length > 20000) { setError("单条问题不能超过 20000 字符"); return; }
    const config = settingsRef.current;
    if (!config.model || !keyReady) { openSettings(); return; }
    const controller = new AbortController(); activeRun.current = controller;
    setWorking(true); setError(""); setNotice(""); setProgress("连接模型");
    const sourceMap = new Map<string, NoteSource>();
    const userMessage: ChatMessage = { id: uuid(), role: "user", content: question, createdAt: new Date().toISOString() };
    const assistantMessage: ChatMessage = { id: uuid(), role: "assistant", content: "", createdAt: new Date(Date.now() + 1).toISOString(), status: "complete", sources: [] };
    let conversationId = selectedRef.current, persistedUser = false;
    let answer = "", completed = false, paintFrame = 0, outputLimitReached = false;
    const skill = skills.find(item => item.id === skillId);
    const paint = () => {
      if (!mounted.current) return;
      setMessages(previous => {
        const message = { ...assistantMessage, content: answer, sources: [...sourceMap.values()] };
        return previous.some(item => item.id === message.id) ? previous.map(item => item.id === message.id ? message : item) : [...previous, message];
      });
    };
    try {
      if (!await aiNative.keyStatus(config.provider, config.baseUrl)) throw new Error("当前设备尚未配置此接口的 API Key");
      if (controller.signal.aborted) throw new DOMException("会话已停止", "AbortError");
      if (!conversationId) {
        conversationId = uuid();
        const now = new Date().toISOString();
        const conversation: Conversation = { id: conversationId, title: question.replace(/\s+/g, " ").slice(0, 60), createdAt: now, updatedAt: now, skillId };
        await adapterRef.current.setData(`conversation.${conversationId}`, conversation);
        selectedRef.current = conversationId; if (mounted.current) setSelectedId(conversationId);
      }
      const metadata = readConversations(adapterRef.current).find(item => item.id === conversationId);
      if (!metadata) throw new Error("会话已在其他设备删除，请新建会话");
      await adapterRef.current.setData(messageKey(conversationId, userMessage.id), userMessage); persistedUser = true;
      if (mounted.current) { setMessages([...readMessages(adapterRef.current, conversationId), assistantMessage]); setInput(""); }
      const current = await adapterRef.current.activeNote();
      const system: AiMessage = { role: "system", content: [assistantSafetyPrompt, config.systemPrompt || defaultSystemPrompt, `当前时间：${new Date().toISOString()}。当前打开文档：${current ? `${current.title}（id: ${current.id}）` : "未打开文档"}。`, ...(skill ? [`当前 Skill：${skill.name}\n<skill>\n${skill.instructions}\n</skill>`, `当前 Skill 参考资料路径：${skill.references.map(file => file.path).join("、") || "无"}。需要时使用 read_skill_reference 读取。`] : [])].join("\n\n") };
      const history = readMessages(adapterRef.current, conversationId);
      let size = 0;
      const recent: AiMessage[] = [];
      for (const item of [...history].reverse()) {
        if (item.status === "error" || !item.content) continue;
        if (size + item.content.length > 70000 || recent.length >= 160) break;
        size += item.content.length; recent.unshift({ role: item.role, content: item.content });
      }
      while (recent[0]?.role === "assistant") recent.shift();
      const wire: AiMessage[] = [system, ...recent];
      const runTool = createToolRunner({ adapter: () => adapterRef.current, skill, signal: controller.signal,
        source: source => { sourceMap.set(source.id, source); }, progress: label => { if (mounted.current) setProgress(label); },
      });
      let toolCount = 0;
      for (let round = 0; round < 10; round++) {
        if (controller.signal.aborted) throw new DOMException("会话已停止", "AbortError");
        if (mounted.current) setProgress("正在思考");
        const prefix = answer ? `${answer}\n\n` : "";
        let deltaText = "";
        const response = await aiNative.chat({ providerId: config.provider, baseUrl: config.baseUrl, model: config.model, messages: wire, tools: assistantTools, ...(config.provider === "deepseek" ? { thinking: config.thinking } : {}) }, value => {
          if (value.type === "delta" && typeof value.text === "string") {
            deltaText += value.text;
            if (prefix.length + deltaText.length > 300000) { answer = (prefix + deltaText).slice(0, 300000); outputLimitReached = true; controller.abort(); return; }
            answer = prefix + deltaText;
            if (!paintFrame) paintFrame = requestAnimationFrame(() => { paintFrame = 0; paint(); });
          } else if (value.type === "reasoning" && mounted.current) setProgress("正在思考");
        }, controller.signal);
        if (paintFrame) { cancelAnimationFrame(paintFrame); paintFrame = 0; }
        answer = prefix + response.content;
        if (answer.length > 300000) { answer = answer.slice(0, 300000); throw new Error("回复已达到内容长度上限，请分步继续"); }
        paint();
        if (!response.toolCalls?.length) {
          if (response.finishReason === "length") throw new Error("回复达到模型长度上限，可以继续追问");
          if (!answer.trim()) throw new Error("模型没有返回内容，请重试");
          completed = true; break;
        }
        toolCount += response.toolCalls.length;
        if (toolCount > 24) throw new Error("本轮工具调用已达上限，请缩小任务范围后继续");
        wire.push({ role: "assistant", content: response.content || null, tool_calls: response.toolCalls, ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}) });
        for (const call of response.toolCalls) wire.push({ role: "tool", tool_call_id: call.id, content: await runTool(call) });
      }
      if (!completed) throw new Error("本轮已达到 10 次模型往返，请分步继续");
    } catch (cause) {
      if (outputLimitReached) { assistantMessage.status = "error"; if (mounted.current) setError("回复已达到内容长度上限，请分步继续"); }
      else if (controller.signal.aborted) assistantMessage.status = "stopped";
      else { assistantMessage.status = "error"; if (mounted.current) setError(messageText(cause)); }
    } finally {
      if (paintFrame) cancelAnimationFrame(paintFrame);
      if (persistedUser && conversationId) {
        try {
          const final: ChatMessage = { ...assistantMessage, content: answer || (assistantMessage.status === "stopped" ? "已停止" : "本次回复未完成"), sources: [...sourceMap.values()] };
          await adapterRef.current.setData(messageKey(conversationId, final.id), final);
          const current = readConversations(adapterRef.current).find(item => item.id === conversationId);
          if (current) await adapterRef.current.setData(`conversation.${conversationId}`, { ...current, updatedAt: new Date().toISOString(), skillId });
        } catch (cause) { if (mounted.current) setError(`会话保存失败：${messageText(cause)}`); }
      }
      activeRun.current = null;
      if (mounted.current) { setWorking(false); setProgress(""); refresh(); }
    }
  }

  const selectedSkill = skills.find(skill => skill.id === skillId);

  return <main className="assistant-page" data-plugin-id={pluginId}>
    <aside className={`assistant-history ${mobileHistory ? "assistant-history-open" : ""}`}>
      <header><button className="icon-button" aria-label="返回笔记" title="返回笔记" onClick={leave}><ArrowLeft size={19} /></button><span>{title}</span><button className="icon-button assistant-history-close" aria-label="关闭会话列表" onClick={() => setMobileHistory(false)}><X size={18} /></button></header>
      <button className="btn assistant-new" onClick={newConversation} disabled={working}><Plus size={17} />新会话</button>
      <nav aria-label="会话列表">{conversations.length ? conversations.map(conversation => <div className={`assistant-history-item ${conversation.id === selectedId ? "selected" : ""}`} key={conversation.id}>
        <button className="assistant-history-select" disabled={working} onClick={() => pickConversation(conversation)} title={conversation.title}><span>{conversation.title}</span><time>{new Date(conversation.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time></button>
        <button className="icon-button assistant-delete" aria-label={`删除会话 ${conversation.title}`} title="删除会话" disabled={working} onClick={() => { void notebook.dialogs.confirm({ title: "删除会话", message: `删除「${conversation.title}」？此操作会同步到其他设备。` }).then(approved => { if (approved) void removeConversation(conversation); }).catch(cause => setError(messageText(cause))); }}><Trash2 size={14} /></button>
      </div>) : <p className="assistant-history-empty">还没有会话</p>}</nav>
      <footer><button onClick={() => openSettings("skills")} disabled={working}><BookOpen size={16} />Skill<span>{skills.length}</span></button><button onClick={() => openSettings()} disabled={working}><Settings size={16} />设置</button></footer>
    </aside>
    {mobileHistory && <button className="assistant-history-scrim" aria-label="关闭会话列表" onClick={() => setMobileHistory(false)} />}
    <section className="assistant-main">
      <header className="assistant-topbar">
        <button className="icon-button assistant-mobile-menu" aria-label="会话列表" onClick={() => setMobileHistory(true)}><Menu size={18} /></button>
        <span className="assistant-page-title">{title}</span>
        <div className="assistant-model"><select aria-label="选择 AI 模型" value={settings.model} disabled={working || busy} onChange={event => void changeModel(event.target.value)}><option value="">选择模型</option>{settings.model && !models.some(model => model.id === settings.model) && <option value={settings.model}>{settings.model}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select><ChevronDown size={13} /></div>
        <button className="icon-button" aria-label="AI 设置" title="AI 设置" disabled={working} onClick={() => openSettings()}><Settings size={18} /></button>
        <button className="icon-button assistant-mobile-back" aria-label="返回笔记" onClick={leave}><X size={18} /></button>
      </header>
      <div className="assistant-messages" ref={scroll} aria-live="polite" aria-relevant="additions text">
        <div className="assistant-conversation">
          {!messages.length && <div className="assistant-empty"><div className="assistant-empty-icon"><Sparkles size={27} /></div><h1>从笔记开始</h1><p>提问、整理，或继续你的想法。</p><div className="assistant-starters">{["总结正在编辑的笔记", "根据笔记整理本周进展", "帮我润色当前文档"].map(question => <button key={question} disabled={working} onClick={() => { setInput(question); inputRef.current?.focus(); }}>{question}<ArrowUp size={14} /></button>)}</div>{!keyReady && <button className="btn outline assistant-connect" onClick={() => openSettings()}>配置 AI 模型</button>}</div>}
          {messages.map(message => <article className={`assistant-message assistant-message-${message.role}`} key={message.id}>
            <div className="assistant-message-label">{message.role === "user" ? "你" : <><Sparkles size={14} />{title}</>}</div>
            <MarkdownText text={message.content} onOpenDocument={id => { if (!working) onOpenDocument(id); }} />
            {!!message.sources?.length && <div className="assistant-sources" aria-label="笔记来源">{message.sources.map(source => <button key={source.id} onClick={() => { if (!working) onOpenDocument(source.id); }} disabled={working}><FileText size={12} />{source.title}</button>)}</div>}
            {message.status === "stopped" && <span className="assistant-message-status">已停止</span>}{message.status === "error" && <span className="assistant-message-status">回复未完成</span>}
          </article>)}
          {working && <p className="assistant-progress"><LoaderCircle size={14} />{progress || "正在回复"}</p>}
        </div>
      </div>
      <div className="assistant-composer-area">
        {error && <p className="assistant-error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError("")}><X size={14} /></button></p>}
        {!settingsOpen && notice && <p className="assistant-notice">{notice}</p>}
        <form className="assistant-composer" onSubmit={event => void send(event)}>
          <textarea aria-label="输入问题" ref={inputRef} value={input} maxLength={20000} placeholder="与笔记聊聊…" rows={3} disabled={working} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="assistant-composer-tools"><label><BookOpen size={14} /><select aria-label="会话 Skill" value={skillId} disabled={working} onChange={event => setSkillId(event.target.value)}>{skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select><ChevronDown size={12} /></label><span className="assistant-composer-hint">{selectedSkill?.description}</span>{working ? <button type="button" className="assistant-send assistant-stop" aria-label="停止回复" title="停止回复" onClick={stop}><Square size={15} /></button> : <button type="submit" className="assistant-send" aria-label="发送" title="发送 · Enter" disabled={!input.trim() || busy}><ArrowUp size={18} /></button>}</div>
        </form>
        <p className="assistant-privacy">按需读取笔记 · 修改前确认 · Key 仅存于本机</p>
      </div>
    </section>
    {settingsOpen && <Modal title="AI 设置" onClose={() => { if (!busy) { setSettingsOpen(false); setError(""); setNotice(""); } }} wide>
      <div className="assistant-settings">
        <div className="assistant-settings-tabs" role="tablist" aria-label="AI 设置"><button role="tab" aria-selected={settingsTab === "model"} className={settingsTab === "model" ? "active" : ""} onClick={() => setSettingsTab("model")}>模型</button><button role="tab" aria-selected={settingsTab === "prompt"} className={settingsTab === "prompt" ? "active" : ""} onClick={() => setSettingsTab("prompt")}>系统提示词</button><button role="tab" aria-selected={settingsTab === "skills"} className={settingsTab === "skills" ? "active" : ""} onClick={() => setSettingsTab("skills")}>Skill</button></div>
        <form onSubmit={event => void saveSettings(event)}>
          {settingsTab === "model" && <div className="assistant-settings-fields">
            <label>模型服务<select value={draftSettings.provider} onChange={event => { const provider = event.target.value === "custom" ? "custom" : "deepseek"; setDraftSettings(previous => ({ ...previous, provider, baseUrl: provider === "deepseek" ? "https://api.deepseek.com" : "", model: "" })); }}><option value="deepseek">DeepSeek</option><option value="custom">自定义兼容接口</option></select></label>
            {draftSettings.provider === "custom" && <label>接口地址<input type="url" required placeholder="https://example.com/v1" value={draftSettings.baseUrl} onChange={event => setDraftSettings(previous => ({ ...previous, baseUrl: event.target.value }))} /></label>}
            <label>API Key<button type="button" className="btn outline" disabled={busy} onClick={() => void configureKey()}>{keyReady && draftSettings.provider === settings.provider && draftSettings.baseUrl === settings.baseUrl ? "重新配置本机 Key" : "配置本机 Key"}</button></label>
            <label>模型<input list="assistant-model-options" maxLength={200} placeholder="保存 Key 后自动读取，也可手动填写" value={draftSettings.model} onChange={event => setDraftSettings(previous => ({ ...previous, model: event.target.value }))} /><datalist id="assistant-model-options">{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</datalist></label>
            <label className="assistant-checkbox"><input type="checkbox" checked={draftSettings.thinking} onChange={event => setDraftSettings(previous => ({ ...previous, thinking: event.target.checked }))} />深度思考<span>需模型支持</span></label>
            <p className="muted">会话、模型设置和 Skill 随笔记同步。API Key 由每台设备单独保存。</p>
            {keyReady && draftSettings.provider === settings.provider && draftSettings.baseUrl === settings.baseUrl && <button type="button" className="assistant-remove-key" disabled={busy} onClick={() => { setBusy(true); void aiNative.removeKey(settings.provider).then(() => { setKeyReady(false); setNotice("已移除此设备的 API Key"); }, cause => setError(messageText(cause))).finally(() => setBusy(false)); }}>移除本机 Key</button>}
          </div>}
          {settingsTab === "prompt" && <div className="assistant-settings-fields"><label>全局系统提示词<textarea rows={10} maxLength={20000} value={draftSettings.systemPrompt} onChange={event => setDraftSettings(previous => ({ ...previous, systemPrompt: event.target.value }))} /></label><button type="button" className="assistant-text-button" onClick={() => setDraftSettings(previous => ({ ...previous, systemPrompt: defaultSystemPrompt }))}>恢复默认</button><p className="muted">保存后从下一次提问生效，当前选择的 Skill 会一起传给模型。</p></div>}
          {settingsTab === "skills" && <div className="assistant-skill-settings"><div className="assistant-skill-toolbar"><span>会话中选择 Skill</span><button type="button" className="btn outline" disabled={busy} onClick={() => void importSkill()}><Upload size={14} />导入 Skill</button></div>{skills.map(skill => <div className="assistant-skill-row" key={skill.id}><BookOpen size={16} /><div><b>{skill.name}</b><p>{skill.description}</p></div>{skill.builtin ? <span>内置</span> : <button type="button" className="icon-button" disabled={busy} aria-label={`移除 Skill ${skill.name}`} onClick={() => void removeSkill(skill)}><Trash2 size={15} /></button>}</div>)}<p className="muted">支持 SKILL.md 或含参考资料的 ZIP，仅加载文本，不执行程序。</p></div>}
          {error && <p className="assistant-error" role="alert">{error}</p>}{notice && <p className="assistant-notice">{notice}</p>}
          <div className="form-actions"><button className="btn outline" type="button" disabled={busy} onClick={() => { setSettingsOpen(false); setError(""); setNotice(""); }}>完成</button>{settingsTab !== "skills" && <button className="btn primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} /> : <Check size={15} />}保存</button>}</div>
        </form>
      </div>
    </Modal>}
  </main>;
}
