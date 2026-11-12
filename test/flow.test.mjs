import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';
import { Problem } from '../src/notice.mjs';

const html = '<h3>活動時間：</h3><p>2026/10/21 09:00 ~ 2026/12/01 23:59</p>' +
  '<p style="font-size:20pt;font-weight:700">【搖滾樂園粉絲俱樂部招募】</p>' +
  '<p>活動日期：10/21 ~ 12/1</p><p>活動資格：Lv200</p><p>每週三選擇應援</p>' +
  '<p style="font-size:15pt;font-weight:700">【燃燒之城應援】</p>' +
  '<p>狩獵500隻怪物後從UI領取</p><table><tr><td>Lv259以下</td><td>Lv260以上</td></tr>' +
  '<tr><td>核心寶石(1個)交換券</td><td>5</td></tr></table><p>每日10次，每週30次</p>' +
  '<p style="font-size:15pt;font-weight:700">【墮落雷霆應援】</p>';

test('匯入官方公告後可從首頁搜尋獎勵，重開仍可查看獎勵取得方法與期限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-flow-'));
  const options = {
    dir, now: () => new Date('2026-11-12T20:00:00+08:00'),
    fetchSource: async () => html,
    summarize: async () => ({
      eligibility: { text: 'Lv200', source: 's2' },
      first: { text: '每週三選燃燒之城', source: 's3' },
      steps: { text: '狩獵500隻後從介面領取', source: 's4' },
      reward: { text: 'Lv259 以下：核心寶石交換券 ×5', source: 's5' },
      limits: { text: '每日10次，每週30次', source: 's6' },
    }),
  };
  let server;
  async function start(config) {
    server = website(config);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  }
  try {
    let url = await start(options);
    assert.equal((await fetch(url + '/import', { method: 'POST' })).status, 200);
    const result = await (await fetch(url + '/?q=核心寶石')).text();
    assert.match(result, /\/note#method/);
    assert.match(result, /進行中/);
    await new Promise(resolve => server.close(resolve));
    const failures = [
      [{ fetchSource: async () => '' }, 422, /空白公告/],
      [{ fetchSource: async () => { throw new Problem('官網連線失敗', 502); } }, 502, /官網連線失敗/],
      [{ summarize: async () => { throw new Problem('Gemini 免費額度受限', 429); } }, 429, /免費額度受限/],
      [{ summarize: async () => ({}) }, 422, /輸出無效/],
    ];
    for (const [config, status, message] of failures) {
      url = await start({ ...options, ...config });
      assert.equal((await fetch(url + '/import', { method: 'POST' })).status, status);
      assert.match(await (await fetch(url)).text(), message);
      const note = await (await fetch(url + '/note')).text();
      assert.match(note, /狩獵500隻後從介面領取/);
      assert.match(note, /未載明獨立領獎期限/);
      assert.match(note, /查看官方公告/);
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
