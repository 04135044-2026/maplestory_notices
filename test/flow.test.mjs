import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';
import { Problem } from '../src/notice.mjs';

const html = '<div class="content"><h1>星夜馬戲團</h1><div><h3>活動時間：</h3><p>2026/10/21 09:00 ~ 2026/12/01 23:59</p></div>' +
  '<div><h3>星夜馬戲團</h3><hr>' +
  '<p style="font-size:20pt;font-weight:700">【搖滾樂園粉絲俱樂部招募】</p>' +
  '<p>活動日期：10/21 ~ 12/1</p><p>活動資格：Lv200</p><p>每週三選擇應援</p>' +
  '<p style="font-size:15pt;font-weight:700">【燃燒之城應援】</p>' +
  '<p>狩獵500隻怪物後從UI領取</p><table><tr><td>Lv259以下</td><td>Lv260以上</td></tr><tr><td>獎勵</td><td>數量</td><td>獎勵</td><td>數量</td></tr>' +
  '<tr><td>核心寶石(1個)交換券</td><td>5</td><td>靈魂艾爾達碎片交換券</td><td>1</td></tr>' +
  '<tr><td>特殊名譽勳章</td><td>1</td></tr></table><p>每日10次，每週30次</p><p>領獎期間：2026/10/21 09:00 ～ 2026/12/01 23:59</p>' +
  '<p style="font-size:15pt;font-weight:700">【墮落雷霆應援】</p></div><div><h3>注意事項</h3><p>詳見官方公告。</p></div></div>';

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
    assert.match(result, /\/note\?q=[^"]+#method/);
    assert.match(result, /進行中/);
    const medalQuery = encodeURIComponent('特殊名譽勳章');
    const medal = await (await fetch(url + '/?q=' + medalQuery)).text();
    assert.match(medal, />特殊名譽勳章 ×1<\/a>/);
    assert.match(medal, /燃燒之城應援 · [^<]*Lv259以下/);
    const medalNote = await (await fetch(url + '/note?q=' + medalQuery)).text();
    assert.ok(medalNote.includes('/?q=' + medalQuery));
    const fragment = await (await fetch(url + '/?q=靈魂艾爾達碎片')).text();
    assert.match(fragment, /燃燒之城應援 · [^<]*Lv260以上/);
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
      assert.match(await (await fetch(url + '/manage')).text(), message);
      const note = await (await fetch(url + '/note')).text();
      assert.match(note, /狩獵500隻後從介面領取/);
      assert.match(note, /領獎(?:期間|期限)[\s\S]*12\/01/);
      assert.match(note, /<nav class="activity-nav">[^\n]*>官方公告 ↗<\/a><\/nav>/);
      const officialLinks = [...note.matchAll(/href="(https:\/\/beanfun-event\.beanfun\.com\/EventAD_Mobile\/EventAD\?eventAdId=19129[^"]*)"/g)];
      assert.equal(officialLinks.length, 1);
      assert.equal(decodeURIComponent(new URL(officialLinks[0][1]).hash), '#:~:text=搖滾樂園粉絲俱樂部招募');
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL 移轉既有備份後，重啟仍可搜尋獎勵和核對官方原文', {
  skip: !process.env.MAPLE_TEST_DATABASE_URL,
}, async t => {
  const { createHash, randomUUID } = await import('node:crypto');
  const { default: pg } = await import('pg');
  const { openPostgresStore } = await import('../src/postgres-store.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'maple-pg-flow-'));
  const connectionString = process.env.MAPLE_TEST_DATABASE_URL;
  const namespace = 'test-' + randomUUID();
  const servers = [];
  const stores = [];
  t.after(async () => {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    await Promise.all(stores.map(store => store.close()));
    const pool = new pg.Pool({ connectionString });
    try {
      await pool.query('DELETE FROM maple_active_dataset WHERE namespace = $1', [namespace]);
      await pool.query('DELETE FROM maple_saved_files WHERE namespace = $1 OR namespace LIKE $2', [namespace, namespace + ':%']);
    }
    finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
  });
  async function start(options) {
    const server = website({ dir, now: () => new Date('2026-11-12T20:00:00+08:00'), ...options });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: 'http://127.0.0.1:' + server.address().port };
  }
  const local = await start({ fetchSource: async () => html,
    summarize: async () => ({
      eligibility: { text: 'Lv200', source: 's2' },
      first: { text: '每週三選燃燒之城', source: 's3' },
      steps: { text: '狩獵500隻後從介面領取', source: 's4' },
      reward: { text: 'Lv259 以下：核心寶石交換券 ×5', source: 's5' },
      limits: { text: '每日10次，每週30次', source: 's6' },
    }) });
  assert.equal((await fetch(local.url + '/import', { method: 'POST' })).status, 200);
  const oldHome = await (await fetch(local.url + '/?q=核心寶石')).text();
  const oldNote = oldHome.match(/href="(\/note\?q=[^"]+#method)"/)?.[1];
  assert.ok(oldNote);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imageVersion = createHash('sha256').update(bytes).digest('hex');
  const imageId = 'a'.repeat(24);
  await writeFile(join(dir, 'image-' + imageVersion), bytes);
  const fixtures = {
    'schedule.json': { time: '15:30' },
    'watches.json': { old: { label: '移轉關注樣本', version: 'previous' } },
    'manual-edits.json': { old: { activity: '歷史活動', method: '原本方法', fields: { eligibility: { text: '保留個人修正' } } } },
    'calendar-exports.json': { earlier: { version: 'previous', frequencies: ['WEEKLY'] } },
    'official-images.json': { [imageId]: { version: imageVersion, mime: 'image/png' } },
  };
  for (const [name, record] of Object.entries(fixtures)) await writeFile(join(dir, name), JSON.stringify(record));
  await writeFile(join(dir, 'local-model-credentials.json'), '{"geminiKey":"keep-out-of-backup"}');
  const backupResponse = await fetch(local.url + '/backup/download');
  assert.equal(backupResponse.status, 200);
  const backup = await backupResponse.json();

  const first = await openPostgresStore({ connectionString, namespace });
  try {
    assert.equal(await first.importBackup(backup), backup.files.length);
    assert.equal(await first.importBackup(backup), backup.files.length);
  }
  finally { await first.close(); }
  const store = await openPostgresStore({ connectionString, namespace });
  stores.push(store);
  const pgDir = join(dir, 'empty-postgres-local-dir');
  const current = await start({ dir: pgDir, store, fetchSource: async () => { throw new Error('應離線查閱'); } });
  const page = await (await fetch(current.url + '/?q=核心寶石')).text();
  assert.ok(page.includes(oldNote));
  const note = await (await fetch(current.url + oldNote)).text();
  assert.match(note, /狩獵500隻後從介面領取/);
  assert.match(note, /eventAdId=19129/);
  const source = await fetch(current.url + '/review/source');
  assert.equal(source.status, 200);
  assert.equal(await source.text(), html);
  assert.match(await (await fetch(current.url + '/watch')).text(), /移轉關注樣本/);
  assert.match(await (await fetch(current.url + '/edits')).text(), /保留個人修正/);
  assert.deepEqual(Buffer.from(await (await fetch(current.url + '/images/' + imageId)).arrayBuffer()), bytes);

  const snapshotBackup = await (await fetch(current.url + '/backup/download')).json();
  for (const file of backup.files) assert.deepEqual(snapshotBackup.files.find(saved => saved.name === file.name), file);
  const calendar = await (await fetch(current.url + '/calendar')).text();
  const calendarId = calendar.match(/name="activity" value="([^"]+)"/)?.[1];
  assert.ok(calendarId);
  const ics = await fetch(current.url + '/calendar', { method: 'POST', body: new URLSearchParams({ activity: calendarId }) });
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /BEGIN:VCALENDAR/);
  const postgresBackup = await (await fetch(current.url + '/backup/download')).json();

  const schedule = await fetch(current.url + '/schedule', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ time: '16:45' }),
  });
  assert.equal(schedule.status, 303);
  const upload = data => {
    const form = new FormData();
    form.set('confirm', '1');
    form.set('backup', new Blob([JSON.stringify(data)]), 'maplestory-backup.json');
    return fetch(current.url + '/backup', { method: 'POST', body: form, redirect: 'manual' });
  };
  const invalid = { ...backup, files: [{ ...backup.files[0], sha256: 'invalid' }] };
  assert.equal((await upload(invalid)).status, 422);
  assert.match(await (await fetch(current.url + '/schedule')).text(), /value="16:45"/);
  const restored = await upload(postgresBackup);
  assert.equal(restored.status, 303);
  assert.match(await (await fetch(current.url + restored.headers.get('location'))).text(), /備份已還原/);
  assert.equal((await upload(postgresBackup)).status, 303);
  await new Promise(resolve => current.server.close(resolve));
  const reopened = await openPostgresStore({ connectionString, namespace });
  stores.push(reopened);
  const restarted = await start({ dir: pgDir, store: reopened });
  assert.match(await (await fetch(restarted.url + '/schedule')).text(), /value="15:30"/);
  const exported = await (await fetch(restarted.url + '/backup/download')).json();
  for (const file of postgresBackup.files) assert.deepEqual(exported.files.find(saved => saved.name === file.name), file);
  const previous = await (await fetch(restarted.url + '/backup/download?previous=1')).json();
  const beforeRestore = previous.files.find(file => file.name === 'schedule.json');
  assert.equal(JSON.parse(Buffer.from(beforeRestore.data, 'base64')).time, '16:45');
  assert.ok(!exported.files.some(file => Buffer.from(file.data, 'base64').includes('keep-out-of-backup')));
});
