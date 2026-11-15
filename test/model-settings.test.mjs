import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { website } from '../src/site.mjs';
import { Problem } from '../src/notice.mjs';

test('公告管理可測試三種模型、保存選擇，金鑰不進入頁面及備份', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-model-settings-'));
  const calls = [];
  const key = 'test-api-key-7';
  const server = website({
    dir,
    codexGenerate: async request => {
      calls.push('codex');
      if (request.model === 'not-logged-in') throw new Problem('請先在本機 Codex CLI 登入。', 422);
      assert.equal(request.model, 'codex-test');
      assert.deepEqual(request.schema.required, ['ok']);
      return { result: { ok: true }, model: request.model };
    },
    providerFetch: async (url, request) => {
      if (url.includes(':11434/')) {
        calls.push('ollama');
        const { model } = JSON.parse(request.body);
        if (model === 'offline') throw new Error('offline');
        if (model === 'invalid-output') return Response.json({ message: { content: '{"ok":false}' } });
        assert.equal(model, 'maple-test');
        return Response.json({ message: { content: '{"ok":true}' } });
      }
      calls.push('gemini');
      assert.match(url, /gemini-test:generateContent$/);
      const supplied = request.headers['x-goog-api-key'];
      if (supplied === 'over-quota') return Response.json({}, { status: 429 });
      if (supplied !== key) return Response.json({ error: { message: supplied, details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 });
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = fields => fetch(base + '/model-preferences', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
  });
  const settings = { ollamaModel: 'maple-test', codexModel: 'codex-test', geminiModel: 'gemini-test', geminiKey: key };
  for (const provider of ['ollama', 'gemini', 'codex']) {
    const probe = await post({ ...settings, provider, action: 'test' });
    assert.equal(probe.status, 200);
    const html = await probe.text();
    assert.match(html, /連線測試成功/);
    assert.ok(!html.includes(key));
  }
  const wrong = await post({ ...settings, provider: 'gemini', action: 'test', geminiKey: 'private-wrong-key' });
  assert.equal(wrong.status, 422);
  const message = await wrong.text();
  assert.match(message, /Gemini 驗證失敗/);
  assert.ok(!message.includes('private-wrong-key'));
  const quota = await post({ ...settings, provider: 'gemini', action: 'test', geminiKey: 'over-quota' });
  assert.equal(quota.status, 429);
  const offline = await post({ provider: 'ollama', action: 'test', ollamaModel: 'offline' });
  assert.equal(offline.status, 502);
  assert.match(await offline.text(), /Ollama 連線失敗/);
  const invalid = await post({ provider: 'ollama', action: 'test', ollamaModel: 'invalid-output' });
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /未通過結構化輸出測試/);
  const login = await post({ provider: 'codex', action: 'test', codexModel: 'not-logged-in' });
  assert.equal(login.status, 422);
  assert.match(await login.text(), /Codex CLI 登入/);
  assert.deepEqual(calls, ['ollama', 'gemini', 'codex', 'gemini', 'gemini', 'ollama', 'ollama', 'codex']);
  assert.equal((await post({ ...settings, provider: 'ollama' })).status, 303);
  const page = await (await fetch(base + '/updates')).text();
  assert.match(page, /value="ollama" selected/);
  assert.match(page, /value="maple-test"/);
  assert.ok(!page.includes(key));

  const savedKeyProbe = await post({ provider: 'gemini', action: 'test', geminiKey: '' });
  assert.equal(savedKeyProbe.status, 200);
  const backupResponse = await fetch(base + '/backup/download');
  assert.equal(backupResponse.status, 200);
  const backup = await backupResponse.json();
  assert.ok(backup.files.some(file => file.name === 'model-preferences.json'));
  for (const file of backup.files) assert.ok(!Buffer.from(file.data, 'base64').includes(key));
});
