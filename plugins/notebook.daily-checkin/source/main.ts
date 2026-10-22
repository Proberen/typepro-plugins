import { ActivityTracker } from "./tracker";

import type { TypeProSDK } from "../../../sdk/typepro";
const notebook = (globalThis as unknown as {notebook: TypeProSDK}).notebook;

// Fallback only for non-editor human changes. Editor supplies a structural plain-text projection.
export function visibleText(markdown: string) {
  return markdown.replace(/<!--[^]*?-->/g, "").replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)/gm, "")
    .replace(/[`*_~]/g, "").replace(/\s/g, "");
}

export default async function init() {
  let time = new Date();
  const tracker = new ActivityTracker(() => time);
  let pending = Promise.resolve();
  await notebook.events.on("document.changed", event => {
    // Serialize read-modify-write and undo attribution in event order.
    const task = pending.then(async () => {
      if (event.origin !== "human") { tracker.reset(event.documentId); return; }
      time = new Date(event.timestamp);
      if (!Number.isFinite(time.getTime())) time = new Date();
      const before = (event.beforePlain ?? visibleText(event.beforeMarkdown)).replace(/\s/g, "");
      const after = (event.afterPlain ?? visibleText(event.afterMarkdown)).replace(/\s/g, "");
      for (const delta of tracker.record(event.documentId, before, after, event.history)) {
        const key = `activity.${delta.day}.${event.documentId}.${notebook.context.deviceId}`;
        const value = await notebook.storage.get(key) as {added?: number; removed?: number} | null;
        await notebook.storage.set(key, {day: delta.day, documentId: event.documentId, title: event.title,
          added: Math.max(0, (Number.isSafeInteger(value?.added) ? value!.added! : 0) + delta.added),
          removed: Math.max(0, (Number.isSafeInteger(value?.removed) ? value!.removed! : 0) + delta.removed)});
      }
    });
    pending = task.catch(() => {});
    return task;
  });
  await notebook.ui.register({id: "daily", slot: "home.widget", title: "每日打卡", script: "ui.js", styles: ["ui.css"], height: 330, icon: "calendar"});
}
