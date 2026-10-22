await notebook.commands.register('insert-date', '插入日期', async () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await notebook.editor.insert(date);
});

async function updateCount() {
  const document = await notebook.notes.active();
  if (!document) {
    await notebook.panels.set('word-count', '字数', '未打开文档');
    return;
  }
  const characters = [...document.markdown.replace(/\s/g, '')].length;
  const lines = document.markdown ? document.markdown.split('\n').length : 0;
  await notebook.panels.set('word-count', '字数', `${characters} 字符 · ${lines} 行\n按 Markdown 原文统计，不含空白。`);
}

await notebook.events.onDocumentChange(updateCount);
await updateCount();
