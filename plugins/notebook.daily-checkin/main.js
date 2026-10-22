// The host records human edits, handles undo and excludes import/sync/AI changes.
// Daily document/device records belong to this plugin's synchronized storage.
await notebook.home.activity.register('daily', { title: '每日打卡' });
