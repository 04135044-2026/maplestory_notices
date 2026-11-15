import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';

const now = () => new Date('2026-11-15T12:00:00+08:00');
const png = 'https://tw.hicdn.beanfun.com/maplestory/demo.png';
const original = '<main><div class="content"><h2>驗收公告</h2></div><section>這段使用未知版型</section>' +
  '<p>原表說明</p><table><tr><th colspan="2">領獎表</th></tr><tr><td rowspan="2">核心寶石</td><td>一個</td></tr><tr><td>兩個<table><tr><td>表內備註<img data-src="/example/official.png" src="data:image/gif;base64,eA=="></td></tr></table></td></tr></table>' +
  '<img alt="官方示意" src="' + png + '" onerror="alert(1)"><script>UNSAFE_SCRIPT</script><p>公告末段</p></main>';

test('原文頁按順序呈現未知版型、合併儲存格與可預覽的官方圖片', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-original-'));
  const url = 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=19210';
  const site = await start(t, dir, { fetchAnnouncement: async () => ({ html: original, title: '驗收公告' }) });
  const imported = await site.post('/discover/import', { url });
  assert.equal(imported.status, 303);
  const detail = imported.headers.get('location');
  const review = await site.get(detail);
  const originalLink = review.match(/href="([^"]+\/original)"/)?.[1];
  assert.ok(originalLink);
  const page = await site.get(originalLink);
  assert.match(page, /驗收公告[\s\S]*這段使用未知版型[\s\S]*原表說明[\s\S]*<th colspan="2">領獎表[\s\S]*<td rowspan="2">核心寶石[\s\S]*<img[^>]+maplestory\/demo\.png[\s\S]*公告末段/);
  assert.match(page, /<td>兩個<table><tbody><tr><td>表內備註<a[^>]*><img[^>]+beanfun-event\.beanfun\.com\/example\/official\.png/);
  assert.match(page, /eventAdId=19210/);
  assert.doesNotMatch(page, /onerror=|UNSAFE_SCRIPT/);
  assert.equal(await site.get(detail + '/source'), original);
});

test('所有獎勵名稱只顯示仍在領獎期間的取得方法', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-redeemable-'));
  const snapshot = '19129-redeemable.html';
  const dates = [
    ['楓之谷學院', '過期方法', '2026/11/01 00:00 ～ 2026/11/14 23:59'],
    ['驗收活動', '持續開放', '2026/11/10 00:00 ～ 2026/11/20 23:59'],
    ['驗收活動', '同活動已截止', '2026/11/10 00:00 ～ 2026/11/15 11:59'],
    ['尚未開領活動', '未來方法', '2026/11/20 00:00 ～ 2026/11/30 23:59'],
    ['期限不明活動', '未知方法', '2026/11/15 維護前'],
    ['公告未定開領活動', '待通知方法', '2026/11/10 00:00 ～ 2026/11/20 23:59', '另行公告'],
    ['另訂開領活動', '有開領限制的方法', '2026/11/10 00:00 ～ 2026/11/20 23:59', '2026/11/18 00:00 開始'],
  ];
  await writeFile(join(dir, snapshot), '<main>' + dates.map(([title, , claim, opening]) =>
    '<p>活動日期：2026/11/01 00:00 ～ 2026/11/10 00:00</p><p>領獎期間：' + claim +
    '</p><p>可領取「核心寶石」，可領取「測試椅子」。</p><p>' + (opening ? '開領：' + opening : '活動說明') + '</p><p>' + title + '</p>').join('') + '</main>');
  const site = await start(t, dir);
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  const review = await site.get('/review');
  const fingerprint = review.match(/name="fingerprint" value="([^"]+)"/)[1];
  let parent;
  for (const [index, [title, method]] of dates.entries()) {
    const body = new URLSearchParams({ fingerprint, title, method });
    const first = 1 + index * 5;
    for (const offset of [0, 1, 2, 3]) body.append('own', 'B' + (first + offset));
    if (index === 2) body.set('parent', parent);
    const response = await site.post('/review', body);
    assert.equal(response.status, 303);
    if (index === 1) parent = response.headers.get('location').split('/').at(-1).split('#')[0];
  }
  for (const query of ['核心寶石', '測試椅子', '椅子']) {
    const page = await site.get('/?q=' + encodeURIComponent(query));
    assert.match(page, /持續開放/);
    assert.doesNotMatch(page, /楓之谷學院|同活動已截止|尚未開領活動|期限不明活動|公告未定開領活動|另訂開領活動/);
  }
  assert.match(await site.get('/activities'), /楓之谷學院/);
});

async function start(t, dir, options = {}) {
  const server = website({ dir, now, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    get: path => fetch(base + path).then(response => response.text()),
    post: (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body) }),
  };
}
