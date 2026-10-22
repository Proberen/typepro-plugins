# TypePro 插件

TypePro 的公开插件发布仓库。客户端从市场清单读取目录，从 Releases 下载安装包；笔记、会话、Skill、插件私有数据和 API Key 不保存在本仓库。

- TypePro 1.4 使用 [catalog.json](catalog.json)，只包含 API 1 插件。
- TypePro 1.5.0 起使用 [catalog-v2.json](catalog-v2.json)，同时包含 API 1 和 API 2 插件。API 2 提供插件存储、首页打卡和 AI 会话组件。

## 发布插件

1. 使用 TypePro 插件 API 编写 `manifest.json` 和 `main.js`。示例见 [日期与字数](plugins/notebook.date-and-count)。
2. 在 GitHub 的「Add file → Upload files」中上传插件目录，结构为 `plugins/<插件 id>/manifest.json` 和 `plugins/<插件 id>/main.js`，提交到 `main`。也可通过 Git 提交。
3. 查看「Actions → Publish plugins」。发布成功后，客户端进入插件市场或点击刷新即可看到。网络与 GitHub 缓存会影响显示时间。

仓库维护以下插件，均需用户安装并确认权限后运行：

| 插件 | 功能 | 最低 TypePro 版本 |
| --- | --- | --- |
| [日期与字数](plugins/notebook.date-and-count) | 插入日期、读取当前文档并显示字数面板 | 1.4.0 |
| [每日打卡](plugins/notebook.daily-checkin) | 人工编辑自动打卡，首页展示贡献热力图与每日新增／删除字数 | 1.5.0 |
| [AI 助手](plugins/notebook.ai-assistant) | DeepSeek／兼容接口会话、笔记工具、Skill 和写入确认 | 1.5.0 |

```text
plugins/
  notebook.date-and-count/
    manifest.json
    main.js
```

`manifest.json`：

```json
{
  "id": "my.date-tool",
  "name": "日期工具",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "在光标处插入日期。",
  "permissions": ["commands", "editor.insert"]
}
```

插件脚本使用 TypePro 的 `notebook` API，不能使用 npm 依赖、任意文件访问、外部进程或直接网络连接。AI 连接由宿主在获准后执行；插件拿不到 API Key。

API 1 支持 `commands`、`panels`、`editor.insert`、`notes.read` 和 `notes.write`。API 2 在此基础上增加 `storage`、`home.activity` 和 `assistant`，必须在 manifest 中设置 `"apiVersion": 2`。API 1 插件不能声明新增权限。只声明实际需要的权限；`notes.read` 可以读取全部本地笔记，`notes.write` 可以修改文档正文。

## 每日打卡

启用后，由宿主记录人工编辑的正文变化，从启用当天开始展示近一年的贡献热力图。点击日期可查看 `+新增／−删除` 字数；不计算空白和 Markdown 标记，撤销抵消对应变化，同步导入及 AI 自动写入不计入。记录按日期、文档和设备分开保存，随私有笔记仓库同步，避免另一设备拉取内容时重复打卡。

插件通过声明式 API 注册首页组件：

```js
await notebook.home.activity.register('daily', { title: '每日打卡' });
```

采集、撤销处理与热力图由宿主的通用活动组件完成。插件可独立安装、停用或卸载，停用时停止采集并移除对应首页组件。

## AI 助手

启用后从工具菜单打开「AI 助手」。默认接入 DeepSeek，Key 每台设备单独填写；支持选择模型、多个会话、流式回复和停止。可配置自定义兼容接口、全局系统提示词，导入 `SKILL.md` 或包含其参考资料的 ZIP。Skill 用作会话指令和资料，不能执行脚本或系统命令。

内置工具限定于 TypePro 笔记：列出、搜索、读取、新建和修改文档。助手按需读取笔记，引用来源；修改已有内容先展示差异，确认后写入。读取的内容会发送给所选模型服务。

会话、模型设置、全局提示词、Skill 和插件数据随现有 GitHub 私有笔记仓库同步。API Key 只由宿主保存在当前设备的安全存储中，不进入插件存储、笔记导出或 GitHub 同步。同步恢复插件后，新设备首次运行仍需确认权限。

AI 插件调用 `notebook.pages.assistant.register(id, { title, systemPrompt })` 注册宿主提供的会话页面，通过 `notebook.pages.open(id)` 打开。完整示例见 [main.js](plugins/notebook.ai-assistant/main.js)。

## 更新和下架

- 修改已发布插件时必须提高 `manifest.version`，例如 `1.0.0` → `1.0.1`。相同版本不允许替换内容，已发布的安装包保持原样。
- 市场版本采用严格语义版本：`1.0.0` 或 `1.0.0-rc.10`，最多 40 个字符，不含 `+` 构建标记。数字段不得含多余前导零，预发布段不得为空；例如 `01.0.0`、`1.0.0-rc.01`、`1.0.0-a..b` 均拒绝发布。
- 插件 id 不变；目录名必须与 id 相同。不要直接编辑 `catalog.json` 或 `catalog-v2.json`，两份目录都由发布流程生成。
- 删除插件目录并提交，可从下一版市场清单下架；已安装副本与旧版下载包保留。
- 客户端由用户点击更新；发布新版本不会静默替换正在运行的插件。

## 发布规则

ZIP 根目录只包含 `manifest.json` 与 `main.js`。脚本最多 512 KiB，manifest 最多 16 KiB，安装包与解压后的总大小最多 2 MiB；支持 `apiVersion: 1` 和 `2`。名称、版本与权限遵循 TypePro 插件包校验规则。全部插件最多 500 个，每份市场清单最多 1 MiB。

Actions 先校验全部插件，再生成确定性 ZIP。新增版本上传到独立 Release 并核对实际下载字节，未变化版本沿用此前已发布的安装包。只有本次新增版本全部成功后，才在同一次提交中更新两份清单：旧目录仅保留 API 1，新目录包含全部插件。两份清单使用相同更新时间。失败时不发布部分清单，重新运行相同提交可继续完成。清单包含包大小与 SHA-256，客户端下载安装前校验。

版本比较与不可变包校验优先读取 `catalog-v2.json`；首次升级、尚无新目录时读取 `catalog.json`。新目录存在但损坏时直接报错，不退回旧目录绕过 API 2 插件的版本检查。

每个插件版本对应独立的 Release tag，tag 根据插件 id 与版本生成；旧版包不会随新版覆盖。请保留这些 Release 和 tag。初次工作流尚未成功时，市场清单为空。

如果发布期间 `main` 又收到新提交，清单推送会安全失败，不覆盖新提交。等待最新一次工作流完成；必要时在 Actions 中选择 `main` 重新运行发布。已成功上传且内容一致的安装包可继续使用，无需删除 Release。

仓库需允许 GitHub Actions 写入 Contents，并允许发布机器人向 `main` 提交两份清单。无需额外配置密码、个人访问令牌或服务器。若启用了阻止机器人直推的分支保护，需由仓库管理员调整相应规则。
