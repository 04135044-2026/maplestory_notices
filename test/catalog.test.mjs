import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';
import { catalogFromSnapshot } from '../src/catalog.mjs';

const heading = (title, size) => '<p style="font-size:' + size + 'pt;font-weight:700">【' + title + '】</p>';
const paragraph = text => '<p>' + text + '</p>';
const activity = (title, size, from, rank, content) => heading(title, size) +
  paragraph('活動日期：' + from + ' ~ 12/1') + paragraph('參加條件：' + rank) + content;
const chair = activity('三眼章魚直火燒烤', 15, '10/21', '見習者設計師',
  paragraph('向NPC內拉接受任務後即可參加。') +
  paragraph('累積獲得4萬分或單局獲得1250分，可領取紀念椅子「三眼章魚直火燒烤」。'));
const stress = activity('消除壓力！', 15, '11/4', '老手設計師', paragraph('進入挑戰。'));
const box = activity('搖滾音樂節幸運箱', 15, '11/11', '菁英設計師',
  paragraph('一天1次，一週最多3次，與NPC權達開對話。') + paragraph('可能獲得的獎勵如下：'));
function page(children) {
  return '<div class="content"><h1>星夜馬戲團</h1><div><h3>活動時間：</h3><p>2026/10/21 09:00 ~ 2026/12/01 23:59</p></div>' +
    '<div><h3>星夜馬戲團</h3><hr>' + children +
    '</div><div><h3>注意事項</h3><p>詳見官方公告。</p></div></div>';
}
const html = page(heading('慶典活動', 20) + chair + stress + box);

test('模板區分子活動，改標題與換順序後保留識別，未知版型需確認', () => {
  const items = catalogFromSnapshot(html);
  const moved = catalogFromSnapshot(page(heading('慶典活動', 20) + box + stress + chair.replace('【三眼章魚直火燒烤】', '【燒烤活動】')));
  assert.deepEqual(moved.map(item => item.id), items.map(item => item.id).reverse());
  assert.deepEqual(items[1].dates, ['2026-11-04', '2026-12-01']);
  assert.equal(items[0].groupTitle, '慶典活動');
  assert.throws(() => catalogFromSnapshot('<main><h1>未知公告</h1></main>'), /拆分待確認/);
});

test('從活動入口核對取得方法，Gemini 只收到指定方法的適用來源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-catalog-'));
  const snapshot = '19129-test.html';
  await writeFile(join(dir, snapshot), html);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ snapshot }));
  const server = website({ dir, now: () => new Date('2026-11-12T20:00:00+08:00'),
    summarizeActivityMethod: async ({ sources }) => {
      assert.ok(sources.some(source => source.text.includes('內拉')));
      assert.ok(sources.some(source => source.scope === '共用注意事項'));
      assert.ok(sources.every(source => !source.text.includes('老手設計師') && !source.text.includes('權達開')));
      return { result: { eligibility: [], steps: [], rewards: [], costs: [], probability: [], payment: [], limits: [] } };
    },
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const list = await (await fetch(root + '/activities?q=三眼章魚')).text();
    const path = list.match(/href="(\/activities\/beanfun-[^"]+)"/)?.[1];
    assert.ok(path);
    assert.doesNotMatch(list, /消除壓力！/);
    const detail = await (await fetch(root + path)).text();
    assert.match(detail, /見習者設計師/);
    assert.match(detail, /內拉/);
    assert.match(detail, /4萬分或單局獲得1250分/);
    const action = detail.match(/action="(\/activities\/[^"]+)"/)?.[1];
    assert.equal((await fetch(root + action, { method: 'POST', redirect: 'manual' })).status, 303);
    const lucky = catalogFromSnapshot(html)[2];
    const luckyDetail = await (await fetch(root + '/activities/' + lucky.id)).text();
    assert.match(luckyDetail, /2026\/11\/11/);
    assert.match(luckyDetail, /可能獎勵/);
    assert.match(luckyDetail, /一天1次，一週最多3次/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
