# TypePro 插件市场

公开插件源码、通用 SDK 和独立发布流程。App 是通用宿主，插件自行实现业务及界面；日常修改插件无需修改 App。当前 API 3 改造为源码状态，未发布新安装包。

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
| AI 助手 1.1.0 | plugins/notebook.ai-assistant/source | API 3 |

## 通用能力

宿主接口覆盖笔记、编辑器、文档事件、按插件隔离的同步 JSON、HTTPS/流式传输、设备凭据、文件选择/导出、可信确认与差异审阅。界面挂载点为首页组件、独立页面和插件设置；命令可出现在应用菜单及首页/编辑器工具区。插件不能访问父窗口、Tauri、任意本地路径或外部进程；联网通过声明及用户批准的精确 HTTPS 来源进行。

规范权威入口是 TypePro 源码 docs/PLUGIN-SPEC.md；类型见 sdk/typepro.d.ts。打卡算法、热力图、模型协议、SSE、会话、Skill 和工具调用均不在 App 中。

## 数据

普通业务数据使用 notebook.storage，以插件 ID 隔离，随用户的私有笔记仓库同步。安装清单、版本和本地导入包的 JS/CSS 资源同样同步。同步到新设备后需要单独授权；启用状态和权限不跨设备复制。

密钥由 notebook.secrets.configure 打开宿主输入框，Keychain/Keystore 本机保存；插件不接收明文，只能在获准来源的网络请求中引用凭据。API 2 旧 AI 密钥需要重新配置一次；原插件 ID 和普通业务数据键不变。

## 发布与兼容

- 已发布版本不可变，修改需递增版本。Release tag 根据 id 与版本生成，客户端验证包大小和 SHA-256。
- catalog.json 保留 API 1；catalog-v2.json 保留 API 1/2 最后兼容版本；catalog-v3.json 包含当前 API 1/2/3 插件。API 3 不覆盖旧设备仍需的 API 2 目录条目。
- 所有资源校验通过并成功发布后，在一次提交中更新市场目录；失败时不发布部分目录。
- 包最多 8 MiB、128 个文件，main.js 最多 512 KiB，单个资源最多 4 MiB，Manifest 最多 16 KiB。资源路径和 UTF-8 类型由发布器及客户端共同校验。
- 新权限和新来源需要用户确认。插件更新由用户手动发起，网络失败保留旧插件。
- 进入市场立即检查、可手动刷新，页面前台每分钟检查。实际到达时间取决于网络和 GitHub 缓存。

本轮没有运行本地构建、测试或远程发布。工作流、测试源码和类型定义已随源码调整；后续发布需要真实工作流回执才能确认产物可用。
