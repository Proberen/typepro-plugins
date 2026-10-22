# TypePro 插件市场

公开插件源码、通用 SDK 和独立发布流程。TypePro 1.6.0 提供 API 3 通用宿主，此后已有接口范围内的插件业务和界面可独立发布，无需升级 App；新增宿主能力或不兼容接口才需要升级 App。每日打卡 1.1.0 和 AI 助手 1.1.1 已发布，并通过原生市场模块的真实下载校验。AI 1.1.1 仅修复插件样式导入顺序造成的桌面按钮显示问题，App 1.6.0 DMG／APK 保持不变。

## 仓库结构

```text
sdk/typepro.d.ts                  通用 API 3 类型
plugins/<id>/manifest.json        版本、权限、目标来源
plugins/<id>/source/main.ts       Worker 初始化、业务事件和命令
plugins/<id>/source/ui.tsx        插件自己的页面
plugins/<id>/source/*.css         插件自己的样式
scripts/build-plugins.mjs         GitHub 发布工作流的打包入口
scripts/publish.py                校验、不可变 Release 与版本化市场目录
```

API 1 的简单插件仍可直接维护 manifest.json 和 main.js。API 3 源码插件由发布工作流生成 main.js 与 files/ui.js、files/ui.css，安装包不携带 source 或 node_modules。发布前在插件目录修改源文件及 Manifest 版本，提交到 main；查看 Actions 中 Publish plugins 的结果，客户端进入市场或刷新后获取。

| 插件 | 业务位置 | 宿主要求 |
| --- | --- | --- |
| 日期与字数 | plugins/notebook.date-and-count/main.js | API 1 |
| 每日打卡 1.1.0 | plugins/notebook.daily-checkin/source | API 3 |
| AI 助手 1.1.1 | plugins/notebook.ai-assistant/source | API 3 |

## 通用能力

宿主接口覆盖笔记、编辑器、文档事件、按插件隔离的同步 JSON、HTTPS/流式传输、设备凭据、文件选择/导出、可信确认与差异审阅。界面挂载点为首页组件、独立页面和插件设置；命令可出现在应用菜单及首页/编辑器工具区。插件不能访问父窗口、Tauri、任意本地路径或外部进程；联网通过声明及用户批准的精确 HTTPS 来源进行。

规范权威入口是 TypePro 源码 docs/PLUGIN-SPEC.md；类型见 sdk/typepro.d.ts。打卡算法、热力图、模型协议、SSE、会话、Skill 和工具调用均不在 App 中。

## 数据

普通业务数据使用 notebook.storage，以插件 ID 隔离，随用户的私有笔记仓库同步。安装清单、版本和本地导入包的 JS/CSS 资源同样同步。同步到新设备后需要单独授权；启用状态和权限不跨设备复制。

密钥由 notebook.secrets.configure 打开宿主输入框，Keychain/Keystore 本机保存；插件不接收明文，只能在获准来源的网络请求中引用凭据。API Key 每台设备单独配置，不进入 GitHub。API 2 旧 AI 密钥需要在各设备重新配置一次；原插件 ID 和普通业务数据键不变。跨设备同步 API 3 插件前，Mac 与 Android 均应升级到 1.6.0。

## 发布与兼容

- 已发布版本不可变，修改需递增版本。Release tag 根据 id 与版本生成，客户端验证包大小和 SHA-256。
- catalog.json 保留 API 1；catalog-v2.json 保留 API 1/2 最后兼容版本；catalog-v3.json 包含当前 API 1/2/3 插件。API 3 不覆盖旧设备仍需的 API 2 目录条目。
- 所有资源校验通过并成功发布后，在一次提交中更新市场目录；失败时不发布部分目录。
- 包最多 8 MiB、128 个文件，main.js 最多 512 KiB，单个资源最多 4 MiB，Manifest 最多 16 KiB。资源路径和 UTF-8 类型由发布器及客户端共同校验。
- 新权限和新来源需要用户确认。插件更新由用户手动发起，网络失败保留旧插件。
- 进入市场立即检查、可手动刷新，页面前台每分钟检查。实际到达时间取决于网络和 GitHub 缓存。

本轮独立插件测试 17 项通过（打卡 7、AI 数据／Skill／工具 7、SSE 3），分发检查 35 项通过。宿主类型检查、Rust 41 项、SDK 8 项及独立 WKWebView CSP 9 项检查由 App 交付记录维护；WebView 检查不是打包 App UI 验收。

[Publish plugins #7](https://github.com/Proberen/typepro-plugins/actions/runs/39759657722) 在源提交 `218ec1d6cc2a3ae573de860e0d83cc645d73e588` 上成功。首次发布的 `catalog-v3.json` 更新时间为 `2026-10-22T09:59:40Z`；实际 App 原生市场模块读取目录、下载全部三个包并校验大小／SHA-256，ZIP CRC 和 Manifest／JS／CSS 资源结构核对通过，未执行下载的插件代码。API 1／2 旧目录条目与冻结基线完全一致。

[Publish plugins #8](https://github.com/Proberen/typepro-plugins/actions/runs/39761719863) 在源提交 `9a0d4b3b3398d699e84f53bad31239d65101c536` 上成功，AI 助手 1.1.1 已由原生市场模块真实下载并通过大小、SHA-256、ZIP CRC 和资源结构校验。最新 `catalog-v3.json` 更新时间为 `2026-10-22T10:15:38Z`；v1／v2 以及 v3 的其他条目保持不变。

| 插件 | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| AI 助手 | 1.1.1 | 300248 | `f9c3ffc4e2614ee17b585eb4aebc9f0bdeb164b4d4fdbfa720466bc0b7b89599` |
| 每日打卡 | 1.1.0 | 237939 | `644ca726105fb7fa779175c0a5ab0fec305a00afc95f345a7dc59ae5aaf186e0` |

当前发布版本的视图资源在独立 WKWebView 与模拟 RPC 中完成 61 项检查：每日打卡 1.1.0 共 13 项，AI 助手 1.1.1 桌面 15 项、设置 16 项、窄屏 17 项。窄屏历史栏 fixture 以 `transition: none` 模拟 reduced-motion，默认动画时序未验证。

本轮未验收打包 App UI、物理手机、真实模型服务或两台设备联网同步恢复。插件发布和下载校验不代替这些端到端验收。
