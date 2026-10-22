# AI 助手 1.2.0 · Plugin API 3

插件独立实现 DeepSeek / OpenAI-compatible 模型协议、SSE 流式解析、模型选择、多会话、全局提示词、Skill 导入、笔记工具与全部页面。宿主只提供获准的 HTTPS 传输、设备安全凭据、笔记访问、同步存储和通用界面挂载。

- `source/main.ts`: 优先注册 `editor.sidebar` 正文侧栏和插件设置页；侧栏入口由通用宿主生成，支持侧栏的宿主不注册独立会话页面或首页入口。旧 API 3 宿主以 `INVALID_ARGUMENT`／`UNSUPPORTED_API` 拒绝侧栏位置时，插件回退到 `app.page` 并注册原有打开命令；其他错误原样抛出。插件管理中的设置入口仅呈现设置，关闭后返回原管理上下文，不显示独立会话页。
- `source/ui.tsx`: 插件自己的 React 侧栏及 SDK 适配。
- `source/native.ts`: 插件自己的模型协议，无原生/宿主模块依赖。
- `source/tools.ts`: 只读笔记工具与受审阅的写入工具。写入通过通用宿主 `dialogs.reviewChanges` 一次预览后原子应用；取消和正文冲突均停止写入。
- `source/skills.ts`: 导入指令和文本参考文件，不执行附带程序。

发布流水线将 `source/main.ts` 打包为 `main.js`，`source/ui.tsx` 打包为 `files/ui.js` / `files/ui.css`。不提交生成包，不把插件源文件编进 TypePro。发布后只需更新插件即可更新业务和页面。

保留原插件 ID 和存储键：settings、skill.*、conversation.*、message.*、conversation-deleted.*。这些业务数据继续同步。原 API 2 专用宿主密钥不跨命名空间静默迁移；更新后在此设备通过宿主安全输入框重新配置 Key，不进入插件脚本、同步 JSON 或会话。插件设置页不接收明文 Key。

侧栏使用单列对话布局，适应宿主调整后的实际 iframe 宽度。会话历史按需打开列表，顶部保留新会话、模型、Skill 和设置；宿主负责收起、宽度及手机抽屉，插件不重复绘制返回或关闭外层侧栏的按钮。切换正文文档或点击笔记来源沿用同一会话视图，提问时通过通用笔记接口读取当前文档。

TypePro 1.7.0 使用正文右侧侧栏，旧 TypePro 1.6.0 保留独立页面入口。宿主升级后重新启用插件或重启 App，初始化会自动采用侧栏；不需要迁移会话数据或更改权限。仍沿用 API 3 与现有 `catalog-v3.json`，通过固定版本同步恢复到旧设备时也可使用页面回退。

此处为 1.2.0 发布源码；是否已发布以 GitHub Actions 和市场目录回执为准，不能将此前 AI 1.1.1 市场包当作已包含此次交互。
