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
  paragraph('累積獲得4萬分或單局獲得1250分，可領取紀念椅子「三眼章魚直火燒烤」。') +
  '<p><img src="https://tw.hicdn.beanfun.com/chair.png"></p>');
const stress = activity('消除壓力！', 15, '11/4', '老手設計師', paragraph('進入挑戰。'));
const box = activity('搖滾音樂節幸運箱', 15, '11/11', '菁英設計師',
  paragraph('一天1次，一週最多3次，與NPC權達開對話。') + paragraph('可能獲得的獎勵如下：'));
function page(children) {
  return '<div class="content"><h1>星夜馬戲團</h1><div><h3>活動時間：</h3><p>2026/10/21 09:00 ~ 2026/12/01 23:59</p></div>' +
    '<div><h3>星夜馬戲團</h3><hr>' + children +
    '</div><div><h3>注意事項</h3><p>詳見官方公告。</p></div></div>';
}
const html = page(heading('慶典活動', 20) + chair + stress + box);

test('未知模板的原文經人工確認後可查閱，且只整理已選區塊', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-review-'));
  const snapshot = '19129-review.html';
  await writeFile(join(dir, snapshot), '<main><p>接任務</p><p>帳號共用條件</p><p>不相干活動</p></main>');
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  let calls = 0;
  const options = { dir, summarizeActivityMethod: async ({ sources }) => {
    calls++;
    assert.deepEqual(sources.map(source => source.text), ['接任務', '帳號共用條件']);
    return { result: { eligibility: [], steps: [], rewards: [], costs: [], probability: [], payment: [], limits: [] } };
  } };
  let server;
  async function start() {
    server = website(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  }
  try {
    let root = await start();
    assert.equal((await fetch(root + '/activities')).status, 422);
    const review = await (await fetch(root + '/review')).text();
    assert.match(review, /不相干活動/);
    const fingerprint = review.match(/name="fingerprint" value="([^"]+)"/)[1];
    const form = new URLSearchParams({ fingerprint, title: '人工活動', method: '確認的方法', own: 'B1', shared: 'B2' });
    const saved = await fetch(root + '/review', { method: 'POST', body: form, redirect: 'manual' });
    assert.equal(saved.status, 303);
    assert.equal(calls, 0);
    await new Promise(resolve => server.close(resolve));
    root = await start();
    const detail = await (await fetch(root + saved.headers.get('location'))).text();
    assert.match(detail, /確認的方法/);
    assert.doesNotMatch(detail, /不相干活動/);
    const action = detail.match(/action="(\/activities\/[^"]+)"/)[1];
    assert.equal((await fetch(root + action, { method: 'POST', redirect: 'manual' })).status, 303);
    assert.equal(calls, 1);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

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
  let imageCalls = 0;
  const server = website({ dir, now: () => new Date('2026-11-12T20:00:00+08:00'),
    downloadImage: async () => ({ bytes: Buffer.from('sample-image'), mime: 'image/png', version: 'sample' }),
    summarizeImage: async () => { imageCalls++; return { text: '原圖不含可辨識文字' }; },
    summarizeActivityMethod: async ({ sources }) => {
      assert.ok(sources.some(source => source.text.includes('內拉')));
      assert.ok(sources.some(source => source.scope === '共用注意事項'));
      assert.ok(sources.every(source => !source.text.includes('老手設計師') && !source.text.includes('權達開')));
      const fact = match => {
        const source = sources.find(source => source.text.includes(match));
        return { text: source.text, source: source.id };
      };
      return { result: {
        eligibility: [fact('見習者')], steps: [fact('內拉')], rewards: [fact('紀念椅子')],
        costs: [], probability: [], payment: [], limits: [],
      } };
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
    const imageAction = detail.match(/action="(\/activities\/[^"]+\/images\/[^"#]+)#/)?.[1];
    assert.ok(imageAction);
    const select = await fetch(root + imageAction, { method: 'POST', body: new URLSearchParams({ action: 'select' }) });
    assert.equal(select.status, 200);
    assert.equal(imageCalls, 0);
    const rendered = await select.text();
    const cached = rendered.match(/src="(\/images\/[^"]+)"/)?.[1];
    assert.equal(await (await fetch(root + cached)).text(), 'sample-image');
    assert.match(rendered, /物品對應待確認/);
    assert.equal((await fetch(root + imageAction, { method: 'POST', body: new URLSearchParams({ action: 'recognize' }) })).status, 200);
    assert.equal(imageCalls, 1);
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
