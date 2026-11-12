import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Problem } from './notice.mjs';
import { announcementUrl } from './discovery.mjs';

const maxBytes = 128 * 1024 * 1024;
const marker = '.restored-data';
const generation = /^[0-9a-f-]{36}$/;
const records = new Set([
  'activity-catalog.json', 'activity-methods.json', 'activity-source.json', 'calendar-exports.json',
  'discovery.json', 'jobs.json', 'manual-edits.json', 'manual-split.json', 'model-preferences.json',
  'official-images.json', 'pending-codex-batch.json', 'schedule.json', 'source-corrections.json',
  'source-update.json', 'status.json', 'summary.json', 'watches.json',
]);
const snapshot = /^(?:19129-[a-zA-Z0-9-]+|(?:discovered|official)-[a-f0-9]{64})\.html$/;
const image = /^image-[a-f0-9]{64}$/;
const supported = name => typeof name === 'string' && (records.has(name) ||
  snapshot.test(name) || image.test(name) || /^manual-split-[a-f0-9]{20}\.json$/.test(name));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function activeDataDirectory(root) {
  const id = await readFile(join(root, marker), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (!id) return root;
  if (!generation.test(id)) throw new Error('本機還原紀錄格式錯誤。');
  return join(root, '.restores', id);
}

export async function createBackup(dir, now) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  let size = 0;
  const files = [];
  for (const entry of entries.filter(entry => entry.isFile() && supported(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await readFile(join(dir, entry.name));
    const data = bytes.toString('base64');
    size += data.length + entry.name.length + 160;
    if (size > maxBytes - 8192) throw new Problem('備份資料超過目前可還原的大小。', 413);
    files.push({ name: entry.name, sha256: digest(bytes), data });
  }
  return { format: 'maplestory-notices-backup', version: 1, createdAt: now.toISOString(), files };
}

export async function readBackupUpload(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new Problem('請選擇備份檔。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Problem('備份檔超過 128 MiB。', 413);
    chunks.push(chunk);
  }
  try {
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': contentType } }).formData();
    const file = form.get('backup');
    if (form.get('confirm') !== '1' || !file || typeof file === 'string') throw new Error();
    return JSON.parse(await file.text());
  } catch {
    throw new Problem('請選擇有效的備份檔，並勾選確認還原。');
  }
}

function validateBackup(backup) {
  if (backup?.format !== 'maplestory-notices-backup' || backup.version !== 1 || !Array.isArray(backup.files)) {
    throw new Problem('備份檔格式或版本無法辨識。');
  }
  const files = new Map();
  const names = new Set();
  const json = new Map();
  for (const file of backup.files) {
    if (!supported(file?.name) || names.has(file.name.toLowerCase()) || typeof file.data !== 'string') {
      throw new Problem('備份包含不支援或重複的檔案。');
    }
    names.add(file.name.toLowerCase());
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data || digest(bytes) !== file.sha256 ||
        (image.test(file.name) && file.name !== 'image-' + file.sha256)) {
      throw new Problem('備份檔案校驗失敗 · ' + file.name);
    }
    files.set(file.name, bytes);
    if (file.name.endsWith('.json')) {
      try { json.set(file.name, JSON.parse(bytes.toString('utf8'))); }
      catch { throw new Problem('備份資料無法讀取 · ' + file.name); }
    }
  }
  const requireFile = (name, pattern) => {
    if (typeof name !== 'string' || !pattern.test(name) || !files.has(name)) throw new Problem('備份缺少所引用的本機檔案。');
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const invalid = name => { throw new Problem('備份資料格式不正確 · ' + name); };
  for (const [name, value] of json) {
    if (name === 'status.json') {
      if (value !== null && typeof value !== 'string') invalid(name);
    } else if (!(name === 'pending-codex-batch.json' && value === null) && !object(value)) invalid(name);
  }
  for (const record of Object.values(json.get('calendar-exports.json') ?? {})) {
    if (!object(record) || typeof record.version !== 'string' || !Array.isArray(record.frequencies) ||
        record.frequencies.some(value => !['DAILY', 'WEEKLY'].includes(value))) invalid('calendar-exports.json');
    if (record.reminderVersions != null && (!object(record.reminderVersions) ||
        Object.entries(record.reminderVersions).some(([frequency, version]) =>
          !record.frequencies.includes(frequency) || typeof version !== 'string'))) invalid('calendar-exports.json');
  }
  for (const record of Object.values(json.get('watches.json') ?? {})) {
    if (!object(record) || typeof record.label !== 'string' || typeof record.version !== 'string') invalid('watches.json');
  }
  const savedMethods = json.get('activity-methods.json');
  if (savedMethods && !object(savedMethods.methods)) invalid('activity-methods.json');
  const discovery = json.get('discovery.json');
  if (discovery && (!object(discovery.entries) || (discovery.queue != null && !object(discovery.queue)))) invalid('discovery.json');
  const work = [...json.values()];
  while (work.length) {
    const record = work.pop();
    if (!record || typeof record !== 'object') continue;
    if (Object.hasOwn(record, 'snapshot') && record.snapshot != null) requireFile(record.snapshot, snapshot);
    if (Object.hasOwn(record, 'id') && (typeof record.id !== 'string' || !/^[\w-]+$/.test(record.id))) {
      throw new Problem('備份包含無法辨識的資料識別碼。');
    }
    for (const field of ['url', 'officialUrl']) {
      if (record[field] != null && (typeof record[field] !== 'string' || !URL.canParse(record[field]) ||
          new URL(record[field]).protocol !== 'https:')) throw new Problem('備份包含無法辨識的來源網址。');
    }
    for (const value of Object.values(record)) if (value && typeof value === 'object') work.push(value);
  }
  for (const record of Object.values(json.get('official-images.json') ?? {})) {
    if (record.version) {
      requireFile('image-' + record.version, image);
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(record.mime)) {
        throw new Problem('備份包含不支援的原圖格式。');
      }
    }
  }
  for (const collection of [discovery?.entries, discovery?.queue]) {
    for (const record of Object.values(collection ?? {})) announcementUrl(record.url);
  }
  return files;
}

export async function restoreBackup(root, backup) {
  const files = validateBackup(backup);
  const id = randomUUID();
  const target = join(root, '.restores', id);
  await mkdir(target, { recursive: true });
  for (const [name, bytes] of files) await writeFile(join(target, name), bytes, { flag: 'wx' });
  const pending = join(root, marker + '.tmp');
  await writeFile(pending, id);
  await rename(pending, join(root, marker));
  return target;
}
