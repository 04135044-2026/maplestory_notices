import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { website } from '../src/site.mjs';

test('網站依台北時間執行固定排程，重啟後補查一次並保存最近失敗', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-schedule-'));
  let clock = new Date('2026-11-11T06:09:00Z');
  let requests = 0;
  let failure = false;
  let server;
  let base;
  const start = async () => {
    server = website({ dir, now: () => clock, enableSchedule: true, scheduleInterval: 20,
      openAnnouncementPages: async () => {
        requests++;
        if (failure) throw new Error('測試官網列表失敗');
        return async () => ({ totalPages: 1, rows: [{ bullentinId: 1, title: '例行維護開機公告', startDate: '2026/11/11' }] });
      },
      fetchAnnouncement: async () => ({ html: '<p>例行維護正文</p>' }),
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  const schedulePage = async () => (await fetch(base + '/schedule')).text();
  const waitFor = async pattern => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (pattern.test(await schedulePage())) return;
      await delay(25);
    }
    assert.fail('排程結果未出現：' + pattern);
  };
  try {
    await start();
    await delay(65);
    assert.equal(requests, 0);
    clock = new Date('2026-11-11T06:10:00Z');
    await waitFor(/2026-11-11 · 固定排程 · 完成/);
    assert.equal(requests, 1);
    await stop();

    clock = new Date('2026-11-12T08:00:00Z');
    failure = true;
    await start();
    await waitFor(/2026-11-12 · 錯過排程補查 · 失敗/);
    assert.match(await schedulePage(), /2026-11-11 14:10:00[\s\S]*測試官網列表失敗/);
    assert.equal(requests, 2);
    await stop();
    await start();
    await delay(70);
    assert.equal(requests, 2);

    const result = await fetch(base + '/schedule', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ time: '15:30' }) });
    assert.equal(result.status, 303);
    assert.match(await schedulePage(), /value="15:30"/);
    clock = new Date('2026-11-13T07:29:00Z');
    await delay(60);
    assert.equal(requests, 2);
    failure = false;
    clock = new Date('2026-11-13T07:30:00Z');
    await waitFor(/2026-11-13 · 固定排程 · 完成/);
    assert.equal(requests, 3);
    const state = JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8'));
    assert.equal(state.time, '15:30');
    assert.equal((await fetch(base + '/discover', { method: 'POST', redirect: 'manual' })).status, 303);
    assert.equal(requests, 4);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
