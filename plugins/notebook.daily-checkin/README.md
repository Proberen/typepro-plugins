# 每日打卡 · Plugin API 3

插件自己订阅通用 `document.changed` 事件，统计人工编辑的新增/删除 Unicode 正文字数、抵消可识别的撤销和恢复重做；同步、导入和插件写入只重置基线。统计和热力图均不在宿主实现。

- `source/main.ts`: 有序处理事件，分文档/日期/设备写入自己的同步空间。
- `source/tracker.ts`: 有界增量比较及撤销归属。
- `source/ui.tsx` / `ActivityHeatmap.tsx`: 首页近一年热力图、日明细和主题适配。

沿用原 ID 和 `activity.<日期>.<文档UUID>.<设备UUID>` 记录，不回填启用前历史。应用暂停/停止期间不保证采集，编辑历史保存在有界内存中，重启后不追溯旧撤销。发布流水线独立生成插件 main.js 和 files/ui.js、ui.css；业务更新只发布插件。
