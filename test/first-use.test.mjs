import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sortedActivityFamilies, website } from '../src/site.mjs';

test('全部活動先列進行中，再依主活動開始日期由新到舊排序', () => {
  const item = (title, start, end) => {
    const date = { id: 'B1', scope: '版本共用期間', text: `活動日期：${start} ~ ${end}` };
    return { id: title, title, pageTitle: title, sources: [date], local: [date], methods: [] };
  };
  const items = [
    item('已結束較新', '2026/09/01', '2026/10/01'),
    item('進行中較舊', '2026/08/01', '2026/12/01'),
    item('已結束較舊', '2026/07/01', '2026/08/01'),
    item('進行中較新', '2026/10/01', '2026/12/01'),
    item('尚未開始', '2026/12/01', '2026/12/31'),
  ];
  assert.deepEqual(sortedActivityFamilies(items, new Date('2026-11-01T00:00:00+08:00')).map(group => group.title),
    ['進行中較新', '進行中較舊', '尚未開始', '已結束較新', '已結束較舊']);
});

test('首次使用時分開顯示名稱搜尋與口語搜尋，並說明語意搜尋條件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-first-use-'));
  const server = website({ dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const home = await (await fetch(base)).text();
  assert.match(home, /<form method="get" action="\/">[\s\S]*搜尋名稱<\/button>[\s\S]*<\/form><form method="post" action="\/semantic\/search">/);
  assert.match(home, /例如：我想知道活動椅子怎麼取得/);
  assert.match(home, /此功能需要 PostgreSQL、pgvector 和本機 Ollama/);
  const manage = await (await fetch(base + '/manage')).text();
  assert.match(manage, /匯入與查找官方公告/);
  assert.match(manage, /設定 AI 模型與更新摘要/);
});
