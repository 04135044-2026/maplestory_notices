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

test('活動中的獎勵可依活動時間查找，方法名稱與常見別名也可搜尋', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-search-availability-'));
  const snapshot = '19129-search-availability.html';
  const activities = [
    { title: '搖滾樂園粉絲俱樂部招募', method: '燃燒之城應援',
      source: ['活動日期：2026/10/21 ～ 2026/12/01', '可取得「特殊名譽勳章」，也可獲得「核心寶石」。'] },
    { title: '搖滾音樂節演出', method: '參與方式',
      source: ['活動日期：2026/10/21 ～ 2026/12/01', '可獲得「搖滾慶典演出：燃燒之城」。', '領獎截止：2026/11/12 23:59'] },
    { title: '露希妲的神祕庭園', method: '擲骰子',
      source: ['活動日期：2026/11/01 ～ 2026/12/01', '可獲得「夢境碎片」。'] },
    { title: '等結算的活動', method: '排名獎勵',
      source: ['活動日期：2026/11/01 ～ 2026/12/01', '可獲得「特殊名譽勳章」。', '活動結束後，依排名發放獎勵。'] },
  ];
  await writeFile(join(dir, snapshot), '<main>' + activities.flatMap(item => item.source)
    .map(text => '<p>' + text + '</p>').join('') + '</main>');
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  const site = await start(t, dir);
  const review = await site.get('/review');
  const fingerprint = review.match(/name="fingerprint" value="([^"]+)"/)[1];
  let block = 0;
  for (const item of activities) {
    const body = new URLSearchParams({ fingerprint, title: item.title, method: item.method });
    for (const ignored of item.source) body.append('own', 'B' + ++block);
    assert.equal((await site.post('/review', body)).status, 303);
  }
  const search = query => site.get('/?q=' + encodeURIComponent(query));
  for (const reward of ['特殊名譽勳章', '核心寶石']) {
    const page = await search(reward);
    assert.ok(page.includes('燃燒之城應援'), reward + ' 應能找到目前仍在活動期間的獎勵');
    assert.ok(!page.includes('等結算的活動'), '公告寫明結束後發放，活動進行中不應顯示');
    assert.match(page, /依活動期間顯示/);
  }
  const method = await search('燃燒之城');
  assert.ok(method.includes('燃燒之城應援'), '同字的過期獎勵不應蓋掉可用的方法名稱');
  assert.ok(!method.includes('搖滾音樂節演出'));
  assert.ok((await search('露西妲')).includes('露希妲的神祕庭園'));
});

test('首頁搜尋會排除過期商店並依公告分類找出名稱沒有「椅子」的獎勵', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-reward-category-'));
  const snapshot = '19129-reward-category.html';
  const live = '活動日期：2026/10/21 ～ 2026/12/01';
  const cases = [
    ['楓之谷學院', '已過期活動商店', ['活動日期：2026/09/09 ～ 2026/10/20', '可兌換道具。']],
    ['現正開放的活動', '兌換商店', [live, '可兌換道具。']],
    ['燒烤活動', '累積分數', [live, '🎸累積獲得4萬分或單局獲得1250分，可領取紀念椅子「三眼章魚直火燒烤」。']],
    ['甩頭冠軍', '累積分數', [live, '🎸累積獲得9萬分或單局獲得2500分，可領取紀念椅子「一點都不暈」。',
      '🎸獲得紀念椅子「三眼章魚直火烤肉吃播」和「一點都不暈」後，可追加領取紀念椅子「墮落城市搖滾樂團」。']],
    ['幸運箱', '開箱', [live, '可能獲得的獎勵如下：可獲得「搖滾慶典椅子選擇券」。']],
    ['過期椅子活動', '歷史領取方法', [live, '領獎截止：2026/11/01 00:00', '可領取椅子「不應出現的獎勵」。']],
  ];
  await writeFile(join(dir, snapshot), '<main>' + cases.flatMap(([, , sources]) => sources)
    .map(text => '<p>' + text + '</p>').join('') + '</main>');
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  const site = await start(t, dir);
  const fingerprint = (await site.get('/review')).match(/name="fingerprint" value="([^"]+)"/)[1];
  let block = 0;
  for (const [title, method, sources] of cases) {
    const form = new URLSearchParams({ fingerprint, title, method });
    sources.forEach(() => form.append('own', 'B' + ++block));
    assert.equal((await site.post('/review', form)).status, 303);
  }
  const search = word => site.get('/?' + new URLSearchParams({ q: word }));
  const shops = await search('商店');
  assert.match(shops, /兌換商店/);
  assert.doesNotMatch(shops, /楓之谷學院|已過期活動商店/);
  assert.match(await site.get('/activities'), /楓之谷學院/);
  const chairs = await search('椅子');
  for (const chair of ['三眼章魚直火燒烤', '一點都不暈', '墮落城市搖滾樂團', '搖滾慶典椅子選擇券']) {
    assert.ok(chairs.includes(chair), chair + ' 應列入椅子搜尋');
  }
  assert.doesNotMatch(chairs, /不應出現的獎勵/);
  const categorized = await site.get('/?' + new URLSearchParams({ q: '椅子', type: '外觀與收藏' }));
  assert.match(categorized, /一點都不暈/);
  const bonus = await search('墮落城市搖滾樂團');
  assert.match(bonus, /取得條件 · 獲得紀念椅子「三眼章魚直火烤肉吃播」和「一點都不暈」後/);
});
