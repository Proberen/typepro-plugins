# TypePro 插件

TypePro 的公开插件发布仓库。客户端从 [catalog.json](catalog.json) 读取市场目录，从 Releases 下载安装包；笔记和用户授权不保存在本仓库。

## 发布插件

1. 使用 TypePro 插件 API 编写 `manifest.json` 和 `main.js`。示例见 [日期与字数](plugins/notebook.date-and-count)。
2. 在 GitHub 的「Add file → Upload files」中上传插件目录，结构为 `plugins/<插件 id>/manifest.json` 和 `plugins/<插件 id>/main.js`，提交到 `main`。也可通过 Git 提交。
3. 查看「Actions → Publish plugins」。发布成功后，客户端进入插件市场或点击刷新即可看到。网络与 GitHub 缓存会影响显示时间。

示例 `notebook.date-and-count` 仅在获准后插入日期、读取当前文档并显示字数面板。

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

插件脚本使用 TypePro 的 `notebook` API，不能使用 npm 依赖、任意文件访问、外部进程或网络。支持的权限为 `commands`、`panels`、`editor.insert`、`notes.read` 和 `notes.write`；只声明实际需要的权限。`notes.read` 可以读取全部本地笔记，`notes.write` 可以修改文档正文。

## 更新和下架

- 修改已发布插件时必须提高 `manifest.version`，例如 `1.0.0` → `1.0.1`。相同版本不允许替换内容，已发布的安装包保持原样。
- 市场版本采用严格语义版本：`1.0.0` 或 `1.0.0-rc.10`，最多 40 个字符，不含 `+` 构建标记。数字段不得含多余前导零，预发布段不得为空；例如 `01.0.0`、`1.0.0-rc.01`、`1.0.0-a..b` 均拒绝发布。
- 插件 id 不变；目录名必须与 id 相同。不要直接编辑 `catalog.json`，目录由发布流程生成。
- 删除插件目录并提交，可从下一版市场清单下架；已安装副本与旧版下载包保留。
- 客户端由用户点击更新；发布新版本不会静默替换正在运行的插件。

## 发布规则

ZIP 根目录只包含 `manifest.json` 与 `main.js`。脚本最多 512 KiB，manifest 最多 16 KiB，安装包与解压后的总大小最多 2 MiB；`apiVersion` 当前为 `1`。名称、版本与权限遵循 TypePro 插件包校验规则。市场清单最多 500 个插件、总大小最多 1 MiB。

Actions 先校验全部插件，再生成确定性 ZIP。新增版本上传到独立 Release 并核对实际下载字节，未变化版本沿用此前已发布的安装包。只有本次新增版本全部成功后，才一次性提交新的市场清单。失败时不发布部分清单，重新运行相同提交可继续完成。清单包含包大小与 SHA-256，客户端下载安装前校验。

每个插件版本对应独立的 Release tag，tag 根据插件 id 与版本生成；旧版包不会随新版覆盖。请保留这些 Release 和 tag。初次工作流尚未成功时，市场清单为空。

如果发布期间 `main` 又收到新提交，清单推送会安全失败，不覆盖新提交。等待最新一次工作流完成；必要时在 Actions 中选择 `main` 重新运行发布。已成功上传且内容一致的安装包可继续使用，无需删除 Release。

仓库需允许 GitHub Actions 写入 Contents，并允许发布机器人向 `main` 提交 `catalog.json`。无需额外配置密码、个人访问令牌或服务器。若启用了阻止机器人直推的分支保护，需由仓库管理员调整相应规则。
