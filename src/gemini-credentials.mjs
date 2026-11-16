import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { Problem } from './notice.mjs';

const keyName = 'GEMINI_API_KEY';
const validKey = key => typeof key === 'string' && /^[\x21-\x7e]{1,512}$/.test(key);
const unavailable = () => new Problem('無法使用 Windows 本機金鑰儲存。舊設定未確認移轉，請檢查 Windows 帳戶和資料夾權限。', 503);

function dpapi(action, input) {
  const windows = process.env.SystemRoot;
  if (process.platform !== 'win32' || !windows || !isAbsolute(windows)) throw unavailable();
  const operation = action === 'protect' ? 'Protect' : 'Unprotect';
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
try {
  $outputBytes = [Security.Cryptography.ProtectedData]::${operation}($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} finally {
  [Array]::Clear($inputBytes, 0, $inputBytes.Length)
  if ($outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GEMINI_API_KEY|GOOGLE_API_KEY)$/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 });
    let output = '';
    child.stdout.setEncoding('ascii').on('data', chunk => {
      output += chunk;
      if (output.length > 16000) child.kill();
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(unavailable()));
    child.once('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output) || output.length > 16000) reject(unavailable());
      else resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.end(input.toString('base64'), 'ascii');
  });
}

async function maybeRead(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function remove(path) {
  try { await unlink(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function replace(path, text) {
  const staged = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, text, { flag: 'wx', encoding: 'utf8' });
    await rename(staged, path);
  } finally {
    await remove(staged);
  }
}

function dotenvMigration(text) {
  if (text === undefined) return null;
  const settings = parseEnv(text);
  const keys = Object.keys(settings).filter(name => name.toUpperCase() === keyName);
  if (!keys.length) return null;
  const key = settings[keys.at(-1)];
  const rest = Object.entries(settings).filter(([name]) => name.toUpperCase() !== keyName);
  const assignments = /^(?:\uFEFF)?[ \t]*(?:export[ \t]+)?GEMINI_API_KEY[ \t]*=[ \t]*/gim;
  let cleaned = '';
  let offset = 0;
  for (let match; (match = assignments.exec(text));) {
    let valueEnd = assignments.lastIndex;
    const quote = text[valueEnd];
    if (['"', "'", '`'].includes(quote)) {
      const closing = text.indexOf(quote, valueEnd + 1);
      if (closing < 0) throw unavailable();
      valueEnd = closing + 1;
      if (!/^[ \t]*(?:#|\r?\n|$)/.test(text.slice(valueEnd))) throw unavailable();
    }
    const newline = text.indexOf('\n', valueEnd);
    const end = newline < 0 ? text.length : newline + 1;
    cleaned += text.slice(offset, match.index);
    offset = assignments.lastIndex = end;
  }
  cleaned += text.slice(offset);
  const check = parseEnv(cleaned);
  if (rest.length !== Object.keys(check).length || !rest.every(([name, value]) => check[name] === value) ||
      Object.keys(check).some(name => name.toUpperCase() === keyName) || (key && !validKey(key))) throw unavailable();
  return { key, cleaned, original: text };
}

export function createGeminiCredentials({ dir, envFile, vaultDirectory } = {}) {
  const legacy = resolve(dir, 'local-model-credentials.json');
  const legacyTemp = legacy + '.tmp';
  const profile = process.env.LOCALAPPDATA;
  const vault = vaultDirectory ?? (profile && isAbsolute(profile) ? join(profile, 'MapleNotice', 'credentials') : undefined);
  const project = resolve(envFile ? dirname(envFile) : dir);
  const scope = createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex');
  const file = vault && join(vault, scope + '.dpapi');
  let pending = Promise.resolve();

  function serial(action) {
    const work = pending.then(action).catch(error => {
      if (error instanceof Problem) throw error;
      throw unavailable();
    });
    pending = work.catch(() => {});
    return work;
  }

  async function protectedKey() {
    if (!file) return undefined;
    const text = await maybeRead(file);
    if (text === undefined) return undefined;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > 16000) throw unavailable();
    const plain = await dpapi('unprotect', Buffer.from(text, 'base64'));
    try {
      const key = plain.toString('utf8');
      if (!validKey(key)) throw unavailable();
      return key;
    } finally { plain.fill(0); }
  }

  async function requireLocalVault() {
    if (!file) throw unavailable();
    const roots = [project, process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
      .filter(path => path && isAbsolute(path));
    const comparable = async path => (await realpath(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return resolve(path);
    })).toLowerCase();
    const locations = [resolve(vault).toLowerCase(), await comparable(vault)];
    for (const root of roots) {
      const home = await comparable(root);
      if (locations.some(path => path === home || path.startsWith(home + sep))) throw unavailable();
    }
  }

  async function persist(key) {
    if (!validKey(key)) throw new Problem('Gemini 金鑰格式有誤。');
    await requireLocalVault();
    const plain = Buffer.from(key, 'utf8');
    try {
      const sealed = await dpapi('protect', plain);
      const verified = await dpapi('unprotect', sealed);
      try { if (!plain.equals(verified)) throw unavailable(); }
      finally { verified.fill(0); }
      await mkdir(vault, { recursive: true });
      await requireLocalVault();
      await replace(file, sealed.toString('base64'));
    } finally { plain.fill(0); }
  }

  async function migrate() {
    const raw = await maybeRead(legacy);
    const unfinished = await maybeRead(legacyTemp);
    const dotenv = envFile ? dotenvMigration(await maybeRead(envFile)) : null;
    if (raw === undefined && unfinished === undefined && !dotenv) return;
    const saved = await protectedKey();
    if (!saved) {
      const oldKey = raw === undefined && unfinished === undefined ? undefined : JSON.parse(raw ?? unfinished).geminiKey;
      if ((raw !== undefined || unfinished !== undefined) && !validKey(oldKey)) throw unavailable();
      const key = oldKey || dotenv?.key;
      if (key) await persist(key);
    }
    if (dotenv) {
      if (await maybeRead(envFile) !== dotenv.original) throw unavailable();
      await replace(envFile, dotenv.cleaned);
    }
    if (raw !== undefined) await remove(legacy);
    if (unfinished !== undefined) await remove(legacyTemp);
  }

  return {
    migrate: () => serial(migrate),
    read: () => serial(async () => {
      await migrate();
      return protectedKey();
    }),
    save: key => serial(async () => {
      await migrate();
      await persist(key);
    }),
  };
}
