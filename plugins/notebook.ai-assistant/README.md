# AI 助手 · Plugin API 3

插件独立实现 DeepSeek / OpenAI-compatible 模型协议、SSE 流式解析、模型选择、多会话、全局提示词、Skill 导入、笔记工具与全部页面。宿主只提供获准的 HTTPS 传输、设备安全凭据、笔记访问、同步存储和通用界面挂载。

- `source/main.ts`: 注册应用页面、设置页和通用命令。
- `source/ui.tsx`: 插件自己的 React 页面及 SDK 适配。
- `source/native.ts`: 插件自己的模型协议，无原生/宿主模块依赖。
- `source/tools.ts`: 只读笔记工具与受审阅的写入工具。写入通过通用宿主 `dialogs.reviewChanges` 一次预览后原子应用；取消和正文冲突均停止写入。
- `source/skills.ts`: 导入指令和文本参考文件，不执行附带程序。

发布流水线将 `source/main.ts` 打包为 `main.js`，`source/ui.tsx` 打包为 `files/ui.js` / `files/ui.css`。不提交生成包，不把插件源文件编进 TypePro。发布后只需更新插件即可更新业务和页面。

保留原插件 ID 和存储键：settings、skill.*、conversation.*、message.*、conversation-deleted.*。这些业务数据继续同步。原 API 2 专用宿主密钥不跨命名空间静默迁移；更新后在此设备通过宿主安全输入框重新配置 Key，不进入插件脚本、同步 JSON 或会话。插件设置页不接收明文 Key。
