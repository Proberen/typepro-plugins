import { notebook } from "./sdk";

export default async function init() {
  try {
    await notebook.ui.register({id: "assistant", slot: "editor.sidebar", title: "AI 助手", script: "ui.js", styles: ["ui.css"], icon: "sparkles"});
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code !== "INVALID_ARGUMENT" && code !== "UNSUPPORTED_API") throw cause;
    await notebook.ui.register({id: "assistant", slot: "app.page", title: "AI 助手", script: "ui.js", styles: ["ui.css"], icon: "sparkles"});
    await notebook.commands.register("open-assistant", "AI 助手", () => notebook.ui.open("assistant"), {locations: ["app.menu", "home.toolbar", "editor.toolbar"], icon: "sparkles"});
  }
  await notebook.ui.register({id: "settings", slot: "plugin.settings", title: "AI 设置", script: "ui.js", styles: ["ui.css"], icon: "settings"});
}
