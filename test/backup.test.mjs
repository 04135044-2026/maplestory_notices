import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';

test('下載備份還原後重啟，離線仍可查看資料並排除憑證', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maple-backup-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(source);
  await writeFile(join(source, '.env'), 'GEMINI_API_KEY=never-export');
  await writeFile(join(source, 'auth.json'), '{"access_token":"never-export"}');
  await writeFile(join(source, 'watches.json'), JSON.stringify({ old: { label: '離線關注樣本', version: 'previous' } }));
  await writeFile(join(source, 'schedule.json'), JSON.stringify({ time: '15:30' }));
  let server;
  const start = async dir => {
    server = website({ dir, openAnnouncementPages: async () => { throw new Error('離線驗收'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  const restore = (base, file) => {
    const form = new FormData();
    form.set('confirm', '1');
    form.set('backup', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'maplestory-backup.json');
    return fetch(base + '/backup', { method: 'POST', redirect: 'manual', body: form });
  };
  try {
    let base = await start(source);
    const file = await fetch(base + '/backup/download');
    assert.match(file.headers.get('content-disposition') ?? '', /attachment/);
    const backup = await file.json();
    assert.deepEqual(backup.files.map(file => file.name).sort(), ['schedule.json', 'watches.json']);
    await stop();
    base = await start(target);
    assert.equal((await restore(base, backup)).status, 303);
    assert.match(await fetch(base + '/watch').then(res => res.text()), /離線關注樣本/);
    assert.equal((await restore(base, { ...backup, files: [...backup.files, { ...backup.files[0], name: '../.env' }] })).status, 422);
    const malformed = Buffer.from(JSON.stringify({ sample: { version: 'a', frequencies: false } }));
    assert.equal((await restore(base, { ...backup, files: [...backup.files, { name: 'calendar-exports.json',
      sha256: createHash('sha256').update(malformed).digest('hex'), data: malformed.toString('base64') }] })).status, 422);
    await stop();
    base = await start(target);
    assert.match(await fetch(base + '/watch').then(res => res.text()), /離線關注樣本/);
    assert.match(await fetch(base + '/schedule').then(res => res.text()), /value="15:30"/);
  } finally {
    if (server?.listening) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
