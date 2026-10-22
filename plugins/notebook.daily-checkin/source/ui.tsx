import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityHeatmap } from "./ActivityHeatmap";
import type { ActivityEntry } from "./data";
import "./base.css";

import type { TypeProSDK } from "../../../sdk/typepro";
const notebook = (globalThis as unknown as {notebook: TypeProSDK}).notebook;

function Widget() {
  const content = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]), [error, setError] = useState("");
  useEffect(() => {
    let alive = true, generation = 0;
    const reload = async () => {
      const current = ++generation, next = await notebook.storage.list("activity.");
      if (alive && current === generation) {setEntries(next); setError("");}
    };
    let stop: (() => Promise<void>) | undefined;
    void notebook.events.on("storage.changed", () => reload()).then(async unsubscribe => { stop = unsubscribe; if (alive) await reload(); else await unsubscribe(); }).catch(cause => {if (alive) setError(cause instanceof Error ? cause.message : String(cause));});
    const observer = new ResizeObserver(() => {void notebook.ui.resize(Math.min(600, Math.max(100, Math.ceil(content.current?.getBoundingClientRect().height || 100)))).catch(() => {});});
    if (content.current) observer.observe(content.current);
    return () => {alive = false; generation++; observer.disconnect(); void stop?.();};
  }, []);
  return <div ref={content}>{error ? <p role="alert">{error}</p> : <ActivityHeatmap title="每日打卡" entries={entries} />}</div>;
}

createRoot(document.getElementById("root")!).render(<Widget />);
