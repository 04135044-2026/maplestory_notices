import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { website } from '../src/site.mjs';

const official = 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=19999';
const page = label => '<main><h2>' + label + '</h2><p>活動日期：2026/11/01 00:00 ～ 2026/11/30 23:59</p>' +
  '<table><tr><td>原表條件</td></tr></table><img src="https://tw.hicdn.beanfun.com/picture.png"></main>';

test('公告探索自動分析、保留最新成功活動，首次不完整可查原文', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-auto-notice-'));
  let label = '第一版活動';
  const calls = [];
  let held, release;
  const hold = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { held = resolve; });
  t.after(() => release());
  const server = website({ dir, fetchAnnouncement: async url => ({ title: '測試公告', html: page(url === official ? label : '首次部分活動') }),
    analyzeNotice: async (_instruction, input, _schema, media) => {
      assert.equal(media, undefined);
      assert.ok(!JSON.stringify(input).includes('picture.png'));
      assert.ok(!JSON.stringify(input).includes('原表條件'));
      assert.deepEqual(input.excluded.map(block => block.kind), ['table', 'image']);
      const [title, dates] = input.blocks;
      calls.push(title.text);
      if (title.text === '過時並行活動') { held(); await hold; }
      return { result: { complete: ['第一版活動', '模型漏掉日期', '過時並行活動', '最後新版活動'].includes(title.text), notes: [{ title: title.text, source: title.id,
        methods: [{ title: '參加方法', source: title.id,
          facts: title.text === '模型漏掉日期' ? [] : [{ kind: 'participation', text: dates.text, source: dates.id }] }] }] } };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = path => fetch(base + path).then(res => res.text());
  async function save(url) {
    const res = await fetch(base + '/discover/import', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ url }) });
    assert.equal(res.status, 303);
    return res.headers.get('location');
  }
  async function until(path, expected) {
    for (let i = 0; i < 100; i++) {
      const html = await get(path);
      if (expected.test(html)) return html;
      await delay(20);
    }
    assert.fail('No expected result at ' + path + ': ' + expected);
  }
  const detail = await save(official);
  await until(detail, /分析完成/);
  const first = await until('/activities', />第一版活動</);
  const path = first.match(/href="(\/activities\/agent-[a-f0-9]+)(?:#[^"]+)?"/)?.[1];
  assert.ok(path);
  const note = await get(path);
  const anchor = note.match(/href="(\/announcement-source\/[^"]+#original-[^"]+)"/)?.[1];
  assert.ok(anchor);
  assert.match(await get(anchor.split('#')[0]), /原表條件/);
  await save(official);
  label = '第二版缺漏活動';
  await save(official);
  await until(detail, /整理未完成/);
  assert.match(await get('/activities'), /第一版活動/);
  assert.doesNotMatch(await get('/activities'), /第二版缺漏活動/);
  assert.match(await get(anchor.split('#')[0]), /第一版活動/);
  label = '模型漏掉日期';
  await save(official);
  await until(detail, /整理未完成/);
  assert.doesNotMatch(await get('/activities'), /模型漏掉日期/);
  const partial = await save(official.replace('19999', '19998'));
  await until(partial, /整理未完成/);
  assert.match(await get('/activities'), /首次部分活動/);
  label = '過時並行活動';
  await save(official);
  await started;
  label = '最後新版活動';
  await save(official);
  release();
  const latest = await until('/activities', /最後新版活動/);
  assert.doesNotMatch(latest, /過時並行活動/);
  assert.match(await get(detail), /分析紀錄/);
  assert.deepEqual(calls, ['第一版活動', '第二版缺漏活動', '模型漏掉日期', '首次部分活動', '過時並行活動', '最後新版活動']);
});

test('口語查詢依椅子分類連到目前可參加的活動，Ollama 離線時可改用名稱搜尋', {
  skip: !process.env.MAPLE_TEST_DATABASE_URL,
}, async t => {
  const { randomUUID } = await import('node:crypto');
  const { default: pg } = await import('pg');
  const { openPostgresStore } = await import('../src/postgres-store.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'maple-semantic-'));
  const connectionString = process.env.MAPLE_TEST_DATABASE_URL;
  const namespace = 'test-' + randomUUID();
  const store = await openPostgresStore({ connectionString, namespace });
  let label = '舊內容';
  let offline = false;
  const batches = [];
  const server = website({ dir, store, now: () => new Date('2026-11-17T04:00:00Z'), fetchAnnouncement: async () => ({
    title: '獎勵版本公告', html: page(label).replace('<table>', '<p>可領取椅子「星光寶座」。</p><table>'),
  }), analyzeNotice: async (_instruction, { blocks: [title, dates, reward] }) => ({
    result: { complete: true, notes: [{ title: title.text, source: title.id,
      methods: [{ title: '每日簽到', source: title.id, facts: [
        { kind: 'participation', text: dates.text, source: dates.id },
        { kind: 'reward', text: '星光寶座', source: reward.id },
      ] }] }] },
  }), embeddingFetch: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/embed');
    if (offline) throw new Error('offline');
    const { input } = JSON.parse(request.body);
    batches.push(input);
    return Response.json({ embeddings: input.map(text => text === '火星郵局' ? [1, 0] : [0, 1]) });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await store.close();
    const pool = new pg.Pool({ connectionString });
    try {
      await pool.query("DELETE FROM maple_saved_files WHERE namespace=$1", [namespace]);
      await pool.query("DELETE FROM maple_notice_vectors WHERE dataset=$1", [namespace]);
    } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, values) => fetch(base + path, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(values),
  });
  assert.equal((await post('/discover/import', { url: official })).status, 303);
  assert.equal(batches.length, 0);
  const ask = async (q = '活動椅子有哪些') => {
    const response = await post('/semantic/search', { q });
    assert.equal(response.status, 200);
    return response.text();
  };
  const waitFor = async title => {
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(base + '/activities')).text()).includes(title)) return;
      await delay(30);
    }
    assert.fail('活動筆記未就緒：' + title);
  };
  await waitFor(label);
  const first = await ask();
  assert.match(first, /舊內容/);
  const evidence = first.match(/href="(\/activities\/[^"#]+#[^"]+)">星光寶座/)?.[1];
  assert.ok(evidence);
  assert.match(await (await fetch(base + evidence.split('#')[0])).text(), /舊內容/);
  assert.equal(batches.length, 0, '分類命中時不呼叫向量服務');
  await ask('最近能拿什麼紀念品');
  const count = batches.length;
  await ask('最近能拿什麼紀念品');
  assert.equal(batches.length, count + 1, '再次搜尋只向量化查詢文字');
  assert.match(await ask('火星郵局'), /找不到符合的活動或目前可領取的獎勵/);
  label = '最新內容';
  assert.equal((await post('/discover/import', { url: official })).status, 303);
  await waitFor(label);
  const second = await ask();
  assert.match(second, /最新內容/);
  assert.doesNotMatch(second, /舊內容/);
  offline = true;
  assert.match(await ask(), /星光寶座/);
  assert.match(await ask('最近能拿什麼紀念品'), /語意搜尋暫不可用/);
  assert.equal((await fetch(base + '/?q=簽到')).status, 200);
});

test('來源保存後若在排入分析之前中斷，重啟會找回待分析的公告', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-analysis-recovery-'));
  const snapshot = '19129-recovery.html';
  await writeFile(join(dir, snapshot), page('中斷後恢復的活動'));
  // 模擬快照與分析意圖已寫入，但工作清單還來不及更新。
  await writeFile(join(dir, 'activity-source.json'), JSON.stringify({ snapshot, analysisRequest: {} }));
  let calls = 0;
  const server = website({ dir, analyzeNotice: async (_instruction, { blocks: [heading, dates] }) => {
    calls++;
    return { result: { complete: true, notes: [{ title: heading.text, source: heading.id,
      methods: [{ title: '參加方法', source: heading.id, facts: [
        { kind: 'participation', text: dates.text, source: dates.id },
      ] }],
    }] } };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/activities';
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(url)).text()).includes('中斷後恢復的活動')) {
      assert.equal(calls, 1);
      return;
    }
    await delay(20);
  }
  assert.fail('重啟後仍無法查閱待分析公告的活動筆記');
});
