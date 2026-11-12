import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';
import { catalogFromSnapshot } from '../src/catalog.mjs';
import { timeline } from '../src/periods.mjs';

const heading = (title, size) => '<p style="font-size:' + size + 'pt;font-weight:700">【' + title + '】</p>';
const paragraph = text => '<p>' + text + '</p>';
const activity = (title, size, from, rank, content) => heading(title, size) +
  paragraph('活動日期：' + from + ' ~ 12/1') + paragraph('參加條件：' + rank) + content;
const chair = activity('三眼章魚直火燒烤', 15, '10/21', '見習者設計師',
  paragraph('向NPC內拉接受任務後即可參加。') +
  paragraph('累積獲得4萬分或單局獲得1250分，可領取紀念椅子「三眼章魚直火燒烤」。') +
  '<p><img src="https://tw.hicdn.beanfun.com/chair.png"></p>' +
  '<table><tr><th colspan="2">效果表</th></tr><tr><td rowspan="2">重置卷</td><td>一階<br>加成</td></tr><tr><td>二階</td></tr></table>');
const stress = activity('消除壓力！', 15, '11/4', '老手設計師', paragraph('進入挑戰。'));
const box = activity('搖滾音樂節幸運箱', 15, '11/11', '菁英設計師',
  paragraph('一天1次，一週最多3次，與NPC權達開對話。') + paragraph('可能獲得的獎勵如下：'));
function page(children) {
  return '<div class="content"><h1>星夜馬戲團</h1><div><h3>活動時間：</h3><p>2026/10/21 09:00 ~ 2026/12/01 23:59</p></div>' +
    '<div><h3>星夜馬戲團</h3><hr>' + children +
    '</div><div><h3>注意事項</h3><p>詳見官方公告。</p></div></div>';
}
const html = page(heading('慶典活動', 20) + chair + stress + box);

test('官方回溯依台北日期跨頁，待確認版本可人工發布，列表失敗保留來源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-discovery-'));
  const source = '19129-discovery.html';
  await writeFile(join(dir, source), html);
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot: source }));
  const row = (id, title, startDate, urlLink) => ({ bullentinId: id, title, startDate, urlLink });
  const event = id => 'https://maplestory-event.beanfun.com/eventad/eventad?eventadid=' + id;
  let failed = false;
  let summaryCalls = 0;
  const server = website({ dir, now: () => new Date('2026-11-11T16:30:00Z'),
    openAnnouncementPages: async () => async number => {
      if (failed && number === 2) throw new Error('分頁暫時無法取得');
      return { totalPages: 3, rows: number === 1 ? [
        row(111, '例行維護開機公告', '2026/11/11'),
        row(112, '獨立商城公告', '2026/08/15'),
      ] : [row(113, '學院改版', '2026/08/15', event(19999)), row(114, '更早公告', '2026/08/14', event(18888))] };
    },
    fetchAnnouncement: async url => ({
      title: url.endsWith('18888') ? '較舊官方活動' : '官方測試公告',
      date: '2026/08/14',
      html: url.includes('bid=111') ? '<p>三眼章魚直火燒烤</p><p>活動期間照常。</p>' :
        url.includes('bid=112') ? '<p>皇家美容商品上架。</p>' : '<h2>學院新活動</h2><p>完成指定任務可獲得獎勵。</p>',
    }),
    summarizeActivityMethod: async () => { summaryCalls++; throw new Error('本測試不送模型'); },
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const post = (path, fields = {}) => fetch(root + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields) });
    const get = path => fetch(root + path).then(response => response.text());
    assert.equal((await post('/discover')).status, 303);
    assert.equal((await post('/discover')).status, 303);
    const listing = await get('/discover');
    assert.match(listing, /2026-08-15 至 2026-11-12[\s\S]*讀取 2 頁/);
    assert.equal((listing.match(/>學院改版<\/a>/g) ?? []).length, 1);
    assert.doesNotMatch(listing, /獨立商城公告|更早公告/);
    const version = listing.match(/href="(\/discover\/[a-f0-9]+)">學院改版/)[1];
    const review = await get(version);
    assert.match(review, /公告版型待確認/);
    assert.match(await get(version + '/source'), /學院新活動/);
    const revision = review.match(/name="fingerprint" value="([^"]+)"/)[1];
    const added = await post(version, { fingerprint: revision, title: '學院新活動', method: '完成指定任務', own: 'B2' });
    assert.equal(added.status, 303);
    assert.match(await get(added.headers.get('location')), /學院新活動[\s\S]*用預設模型整理這個方法/);
    assert.match(await get('/?q=學院新活動'), /學院新活動/);
    const older = await post('/discover/import', { url: event(18888) });
    assert.equal(older.status, 303);
    assert.match(await get('/discover'), /較舊官方活動/);
    failed = true;
    assert.equal((await post('/discover')).status, 303);
    assert.match(await get('/discover'), /列表檢查未完成[\s\S]*學院改版/);
    assert.equal(summaryCalls, 0);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

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
    await writeFile(join(dir, 'activity-catalog.json'), JSON.stringify({ snapshot: 'old.html', items: catalogFromSnapshot(html) }));
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
    const listing = await (await fetch(root + '/activities')).text();
    assert.match(listing, /人工活動/);
    assert.match(listing, /三眼章魚直火燒烤/);
    assert.match(listing, /新來源拆分待確認/);
    const action = detail.match(/action="(\/activities\/[^"]+)"/)[1];
    assert.equal((await fetch(root + action, { method: 'POST', redirect: 'manual' })).status, 303);
    assert.equal(calls, 1);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('縮寫日期只在官方共用期間能唯一對應時補年份', () => {
  const date = { id: 'local', text: '活動日期：12/25 ～ 01/05' };
  const version = { id: 'shared', scope: '版本共用期間', text: '2026/12/20 ～ 2027/01/10' };
  const item = { date, sources: [version, date], local: [date] };
  assert.equal(timeline(item).participation.start.date, '2026-12-25');
  assert.equal(timeline(item).participation.end.date, '2027-01-05');
  date.text = '活動日期：11/01 ～ 11/05';
  assert.equal(timeline(item).participation.start, undefined);
});

test('模板區分子活動，改標題與換順序後保留識別，未知版型需確認', () => {
  const items = catalogFromSnapshot(html);
  const moved = catalogFromSnapshot(page(heading('慶典活動', 20) + box + stress + chair.replace('【三眼章魚直火燒烤】', '【燒烤活動】')));
  assert.deepEqual(moved.map(item => item.id), items.map(item => item.id).reverse());
  assert.deepEqual(items[1].dates, ['2026-11-04', '2026-12-01']);
  assert.equal(items[0].groupTitle, '慶典活動');
  assert.throws(() => catalogFromSnapshot('<main><h1>未知公告</h1></main>'), /拆分待確認/);
});

test('活動筆記分開呈現參加、開領和領獎期限，台灣時間邊界不猜時刻', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-periods-'));
  const snapshot = '19129-periods.html';
  const fixture = page(heading('慶典活動', 20) + stress + chair +
    paragraph('開領時間：2026/12/02 10:00') + paragraph('領獎期限：2026/12/03 23:59'));
  await writeFile(join(dir, snapshot), fixture);
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  let time;
  const server = website({ dir, now: () => new Date(time) });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const [stressItem, chairItem] = catalogFromSnapshot(fixture);
    const get = async (item, date) => {
      time = date;
      return (await fetch(root + '/activities/' + item.id)).text();
    };
    assert.match(await get(stressItem, '2026-11-03T23:59:00+08:00'), /尚未開始/);
    const edge = await get(stressItem, '2026-11-04T00:00:00+08:00');
    assert.match(edge, /時間待確認/);
    assert.match(edge, /2026\/11\/04/);
    assert.match(edge, /<dt>領獎期限<\/dt><dd>公告未載明/);
    assert.match(await get(stressItem, '2026-11-05T00:00:00+08:00'), /進行中/);
    assert.match(await get(chairItem, '2026-12-02T09:59:00+08:00'), /尚未開領/);
    assert.match(await get(chairItem, '2026-12-02T10:01:00+08:00'), /仍可領獎/);
    assert.match(await get(chairItem, '2026-12-04T00:00:00+08:00'), /已結束/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('從活動入口核對取得方法，Gemini 只收到指定方法的適用來源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-catalog-'));
  const snapshot = '19129-test.html';
  await writeFile(join(dir, snapshot), html);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ snapshot, capturedAt: '2026-11-12T08:24:49.046Z' }));
  let imageCalls = 0;
  let methodCalls = 0;
  const server = website({ dir, now: () => new Date('2026-11-12T20:00:00+08:00'),
    downloadImage: async () => ({ bytes: Buffer.from('sample-image'), mime: 'image/png', version: 'sample' }),
    summarizeImage: async () => { imageCalls++; return { text: '原圖不含可辨識文字' }; },
    summarizeActivityMethod: async ({ sources }) => {
      methodCalls++;
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
    assert.equal((await fetch(root + action, { method: 'POST', redirect: 'manual' })).status, 303);
    assert.equal(methodCalls, 1);
    const imageAction = detail.match(/action="(\/activities\/[^"]+\/images\/[^"#]+)#/)?.[1];
    assert.ok(imageAction);
    const select = await fetch(root + imageAction, { method: 'POST', body: new URLSearchParams({ action: 'select' }) });
    assert.equal(select.status, 200);
    assert.equal(imageCalls, 0);
    const updates = await (await fetch(root + '/updates')).text();
    assert.match(updates, /來源取得 2026-11-12 16:24:49（台北時間）/);
    assert.match(updates, /摘要待重整 · 舊摘要仍可讀 · 摘要完成 2026-11-12 20:00:00（台北時間）/);
    const rendered = await select.text();
    const cached = rendered.match(/src="(\/images\/[^"]+)"/)?.[1];
    assert.equal(await (await fetch(root + cached)).text(), 'sample-image');
    assert.match(rendered, /物品對應待確認/);
    const original = rendered.match(/<details data-source-flow open>[\s\S]*?<\/details>/)?.[0];
    assert.match(original, /<figure>[\s\S]*?<table>/);
    assert.doesNotMatch(original, /1250分|見習者設計師|活動日期/);
    assert.equal((rendered.split('<summary>摘要整理</summary>')[0].match(/累積獲得4萬分或單局獲得1250分/g) ?? []).length, 1);
    assert.match(original, /<th colspan="2">效果表<\/th>/);
    assert.match(original, /<td rowspan="2">重置卷<\/td><td>一階\n加成<\/td>/);
    assert.doesNotMatch(rendered, /預覽對應原圖|<dt>重置規則<\/dt>/);
    assert.equal((await fetch(root + imageAction, { method: 'POST', body: new URLSearchParams({ action: 'recognize' }) })).status, 200);
    assert.equal(imageCalls, 1);
    const lucky = catalogFromSnapshot(html)[2];
    const luckyDetail = await (await fetch(root + '/activities/' + lucky.id)).text();
    assert.match(luckyDetail, /2026\/11\/11/);
    assert.match(luckyDetail, /可能獎勵/);
    assert.match(luckyDetail, /一天1次，一週最多3次/);
    const chairSearch = new URLSearchParams({ q: '三眼章魚', state: '進行中', type: '外觀與收藏' });
    const home = await (await fetch(root + '/?' + chairSearch)).text();
    assert.match(home, /查看取得方式/);
    assert.match(home, /尚無外觀圖片/);
    assert.match(home, /來源 · 星夜馬戲團/);
    assert.doesNotMatch(home, /搖滾音樂節幸運箱/);
    chairSearch.set('state', '已結束');
    assert.match(await (await fetch(root + '/?' + chairSearch)).text(), /已收錄的公告 19129.*找不到/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('網站保留補充來源，只有明示更正才更新參加期限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-correction-'));
  const snapshot = '19129-corrections.html';
  const original = page(heading('慶典活動', 20) + chair);
  await writeFile(join(dir, snapshot), original);
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  const item = catalogFromSnapshot(original)[0];
  const note = '三眼章魚直火燒烤 活動期間延長至2026/12/08 23:59';
  const supplementary = '三眼章魚直火燒烤 活動日期12/09';
  const officialUrl = 'https://maplestory.beanfun.com/bulletin?bid=83987';
  const server = website({ dir, now: () => new Date('2026-12-02T20:00:00+08:00'),
    fetchLinkedSource: async url => ({ url, html: '<p>' + note + '</p><p>' + supplementary + '</p>' }),
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const post = (kind, quote, end) => fetch(root + '/corrections', {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ activity: item.id, url: officialUrl, field: 'participation', kind, quote, end }),
    });
    const detail = () => fetch(root + '/activities/' + item.id).then(response => response.text());
    assert.equal((await post('supplement', supplementary, '')).status, 303);
    assert.match(await detail(), /已結束[\s\S]*另有來源待比對/);
    assert.equal((await post('correction', supplementary, '2026/12/09')).status, 422);
    assert.equal((await post('correction', note, '2026/12/08 23:59')).status, 303);
    const updated = await detail();
    assert.match(updated, /進行中[\s\S]*12\/08 23:59[\s\S]*原公告[\s\S]*12\/01/);
    assert.match(updated, /查閱官方更正/);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('玩家可問活動、比較方法及用自然語言搜尋，模型只能引用適用的資料', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-player-assist-'));
  const snapshot = '19129-player.html';
  await writeFile(join(dir, snapshot), html);
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot }));
  const [chairItem, stressItem] = catalogFromSnapshot(html);
  const methodId = item => item.methods.find(method => method.kind === 'method').id;
  let searchCalls = 0;
  let codexCalls = 0;
  let imageVersion = 'original';
  const server = website({ dir, now: () => new Date('2026-11-12T20:00:00+08:00'),
    downloadImage: async () => ({ bytes: Buffer.from(imageVersion), mime: 'image/png', version: imageVersion }),
    summarizeImage: async () => ({ text: '待核對的辨識稿' }),
    generatePlayerAssistance: async (_instruction, input) => {
      if (input.question) {
        assert.equal(input.activity, chairItem.title);
        assert.ok(input.sources.every(source => !source.text.includes('老手設計師')));
        if (input.question === '圖中的技能上限？') {
          assert.ok(input.sources.every(source => !source.text.includes('待核對的辨識稿')));
          const image = input.sources.find(source => source.scope.includes('已核對文字'));
          return { result: { facts: image ? [{ text: image.text, sources: [image.id] }] : [], incomplete: !image } };
        }
        const source = input.sources.find(source => source.text.includes('1250分'));
        const facts = [{ text: '單局達 1250 分就符合這項分數門檻。', sources: [source.id] }];
        return { result: input.question === '未載明' ? { facts: [], incomplete: true } : { facts, incomplete: false } };
      }
      searchCalls++;
      assert.ok(input.choices.every(choice => choice.reward));
      return { result: { matches: input.query === '未知候選' ? ['S999999'] :
        [input.choices.find(choice => choice.reward === chairItem.title).id] } };
    },
    codexGenerate: async ({ parts, schema }) => {
      codexCalls++;
      const { sides, fields } = JSON.parse(parts[0].text);
      assert.equal(schema.type, 'object');
      const [left, right] = sides.map(side => ({
        ...Object.fromEntries(Object.keys(fields).map(key => [key, []])),
        eligibility: [{ text: side.sources.find(source => source.text.includes('設計師')).text,
          sources: [side.sources.find(source => source.text.includes('設計師')).id] }],
      }));
      if (codexCalls > 1) left.eligibility[0].sources = right.eligibility[0].sources;
      return { result: { left, right }, model: '測試 Codex' };
    },
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = 'http://127.0.0.1:' + server.address().port;
    const post = (path, values) => fetch(root + path, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams(values),
    });
    const text = path => fetch(root + path).then(response => response.text());
    const activityPath = '/activities/' + chairItem.id;
    const detail = await text(activityPath);
    assert.match(detail, /比較兩種取得方式[\s\S]*問這個活動/);
    const answer = await post(activityPath + '/ask', { question: '單局1250分夠嗎？' });
    assert.equal(answer.status, 200);
    assert.match(await answer.text(), /單局達 1250 分[\s\S]*href="#evidence-Q\d+"[\s\S]*累積獲得4萬分或單局獲得1250分/);
    assert.match(await (await post(activityPath + '/ask', { question: '未載明' })).text(), /沒有足夠資料回答/);
    const imageAction = detail.match(/action="(\/activities\/[^"]+\/images\/[^"#]+)#/)?.[1];
    const askImage = () => post(activityPath + '/ask', { question: '圖中的技能上限？' }).then(response => response.text());
    const draft = await post(imageAction, { action: 'recognize' }).then(response => response.text());
    assert.match(draft, /待人工核對[\s\S]*待核對的辨識稿/);
    assert.match(await askImage(), /沒有足夠資料回答/);
    const verified = { action: 'verify-text', imageVersion, imageText: '技能等級上限為 5 級（測試資料）' };
    assert.match(await (await post(imageAction, verified)).text(), /已核對的官方圖片文字[\s\S]*技能等級上限為 5 級/);
    assert.match(await askImage(), /技能等級上限為 5 級[\s\S]*已核對文字[\s\S]*\?v=original/);
    await post(imageAction, { action: 'remove-text', imageVersion });
    assert.match(await askImage(), /沒有足夠資料回答/);
    await post(imageAction, verified);
    imageVersion = 'replacement';
    await post(imageAction, { action: 'download' });
    assert.match(await askImage(), /沒有足夠資料回答/);
    assert.equal((await post(imageAction, verified)).status, 409);
    assert.match(await text('/?q=那個烤章魚的椅子怎麼拿'), /用 Agent 搜尋/);
    assert.equal(searchCalls, 0);
    const search = await post('/assist/search', { q: '那個烤章魚的椅子怎麼拿', type: '外觀與收藏', state: '進行中' });
    assert.equal(search.status, 200);
    const searchPage = await search.text();
    assert.match(searchPage, new RegExp('Agent 搜尋結果[\\s\\S]*' + activityPath + '#' + methodId(chairItem)));
    assert.match(searchPage, /<form method="get" action="\/">/);
    assert.doesNotMatch(searchPage, /找不到符合的結果/);
    const invalid = await post('/assist/search', { q: '未知候選', type: '外觀與收藏' });
    assert.equal(invalid.status, 502);
    assert.match(await invalid.text(), /用 Agent 搜尋[\s\S]*候選結果無效/);
    assert.equal((await post('/model-preferences', { provider: 'codex' })).status, 303);
    assert.match(await text('/compare?activity=' + chairItem.id), /第一種方式[\s\S]*第二種方式/);
    const selections = [['method', methodId(chairItem)], ['method', methodId(stressItem)]];
    const comparison = await post('/compare', selections);
    assert.equal(comparison.status, 200);
    assert.match(await comparison.text(), /比較結果[\s\S]*依據 A\d+[\s\S]*依據 B\d+[\s\S]*公告未載明[\s\S]*測試 Codex/);
    const wrongSource = await post('/compare', selections);
    assert.equal(wrongSource.status, 502);
    assert.match(await wrongSource.text(), /模型回傳的內容或來源有誤/);
    assert.equal((await post('/compare', [selections[0], selections[0]])).status, 422);
    assert.equal(codexCalls, 2);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
