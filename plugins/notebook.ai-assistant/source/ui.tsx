import "./base.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import AssistantPage from "./AssistantPage";
import { notebook } from "./sdk";
import type { JsonValue } from "../../../sdk/typepro";
import type { AssistantAdapter } from "./types";

function Page() {
  const [adapter, setAdapter] = useState<AssistantAdapter | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true, generation = 0;
    const cache = new Map<string, unknown>();
    const reload = async () => {
      const current = ++generation;
      const entries = await notebook.storage.list();
      if (!alive || current !== generation) return;
      cache.clear(); for (const entry of entries) cache.set(entry.key, entry.value);
      const next: AssistantAdapter = {
        listNotes: () => notebook.notes.list(), searchNotes: (query, limit) => notebook.notes.search(query, {limit}), readNote: id => notebook.notes.get(id), activeNote: () => notebook.notes.active(),
        reviewChanges: (proposal, signal) => notebook.dialogs.reviewChanges(proposal, {signal}),
        getData: key => cache.get(key), listData: prefix => [...cache.entries()].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value})),
        setData: async (key, value) => { await notebook.storage.set(key, value as JsonValue); cache.set(key, value); },
      };
      setAdapter(next);
    };
    let unsubscribe: (() => Promise<void>) | undefined;
    // Subscribe before initial snapshot to avoid losing a sync between read and subscription.
    void notebook.events.on("storage.changed", () => reload()).then(async stop => { unsubscribe = stop; if (alive) await reload(); else await stop(); }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; generation++; void unsubscribe?.(); };
  }, []);
  if (error) return <p className="plugin-error" role="alert">{error}</p>;
  if (!adapter) return <p className="plugin-loading">正在加载…</p>;
  return <AssistantPage pluginId={notebook.context.pluginId} title="AI 助手" adapter={adapter} settingsOnly={notebook.context.slot === "plugin.settings"} onOpenDocument={id => void notebook.notes.open(id).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))} />;
}

createRoot(document.getElementById("root")!).render(<Page />);
