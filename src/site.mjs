import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activity, extract, fetchNotice, fields, gemini, method, official, Problem, validate } from './notice.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const link = '<a href="' + official + '" target="_blank" rel="noopener noreferrer">查看官方公告 ↗</a>';
const style = 'body{margin:0;background:#f6f5ef;color:#252e26;font:17px/1.65 system-ui,sans-serif}main{max-width:48rem;margin:auto;padding:2rem 1rem}h1,h2{line-height:1.25}a{color:#17563d}article,details{background:white;border:1px solid #d9e1d7;padding:1rem;margin:1rem 0;border-radius:12px}input,button{font:inherit;padding:.45rem .65rem}button{cursor:pointer}dt{font-weight:700}dd{margin:0 0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{margin-bottom:1rem}';
const page = (title, body) => '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title><style>' + style + '</style><main>' + body + '</main></html>';

function timing(dates, now) {
  if (!dates) return { status: '參加期間待確認', text: '公告日期待確認' };
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
  const [start, end] = dates;
  const status = date < start ? '尚未開始' : date > end ? '已結束'
    : date === start || date === end ? '當日時間待確認' : '進行中';
  return { status, text: start.replaceAll('-', '/') + ' ～ ' + end.slice(5).replace('-', '/') + '（起迄時刻未載明）' };
}

function matchingRewards(notice, query) {
  const table = notice.sources.find(source => source.id === notice.table)?.rows;
  const [groups = [], ...rows] = table ?? [];
  const rewards = rows.flatMap(row => groups.flatMap((level, group) => {
    const [name, quantity] = row.slice(group * 2, group * 2 + 2);
    return name && /^\d+$/.test(quantity) ? [{ name, quantity, level }] : [];
  }));
  if (!rewards.length) rewards.push({ name: notice.reward, quantity: notice.quantity, level: 'Lv259以下' });
  if (!query || [activity, method].some(name => name.includes(query))) {
    return rewards.filter(reward => reward.name === notice.reward);
  }
  return rewards.filter(reward => reward.name.includes(query));
}

function searchResults(saved, query, now) {
  if (!saved) return '<p>尚未整理公告，匯入後即可搜尋。</p>';
  const rewards = matchingRewards(saved.notice, query);
  if (!rewards.length) return '<p>在已收錄的獎勵或活動中找不到符合的名稱。</p>';
  const time = timing(saved.notice.dates, now);
  const href = query ? '/note?q=' + encodeURIComponent(query) + '#method' : '/note#method';
  return rewards.map(({ name, quantity, level }) => '<article><h2>' + escape(name) + ' ×' + escape(quantity) +
    '／次</h2><p>' + activity + ' › ' + method + ' · ' + escape(level) + '</p><p>' + time.status +
    ' · ' + time.text + '</p><a href="' + href + '">查看取得方式 →</a></article>').join('');
}

function home(saved, query, now, status) {
  return page('新楓之谷公告懶人包', '<h1>新楓之谷公告懶人包</h1><form method="get"><label for="q">搜尋獎勵或活動</label> <input id="q" name="q" value="' +
    escape(query) + '"> <button>搜尋</button></form>' + searchResults(saved, query, now) +
    '<details' + (status ? ' open' : '') + '><summary>公告管理</summary>' +
    (status ? '<p>' + escape(status) + '</p>' : '') +
    (saved ? '<p>已保存摘要：' + escape(new Date(saved.capturedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })) + '（台灣時間）</p>' : '') +
    '<form method="post" action="/import"><button>匯入並整理公告 19129</button></form></details>');
}

function note(saved, now, query) {
  const { notice, summary } = saved;
  const time = timing(notice.dates, now);
  const row = (title, value, source) => '<dt>' + title + '</dt><dd>' + escape(value) +
    (source ? ' <a href="#' + source + '">查看依據</a>' : '') + '</dd>';
  const fact = key => row(fields[key], summary[key].text, summary[key].source);
  const rewards = query ? matchingRewards(notice, query) : [];
  const rewardDetails = rewards.some(reward => reward.name !== notice.reward)
    ? rewards.map(({ name, quantity, level }) =>
      row(fields.reward, level + '（選擇應援時）：' + name + ' ×' + quantity + '／次', notice.table)).join('')
    : fact('reward');
  return page(activity, '<nav><a href="/?q=' + encodeURIComponent(query ?? notice.reward) + '">← 回搜尋結果</a></nav><h1>' + activity +
    '</h1><p>' + time.status + ' · ' + link + '</p><dl>' + fact('eligibility') + row('參加期間', time.text, notice.date?.id) +
    row('領獎期限', notice.claim ? '請查看公告所列領取條件' : '此活動段落未載明獨立領獎期限',
      notice.claim?.id ?? 'sources') + '</dl><article id="method"><h2>' + method +
    '</h2><dl>' + fact('first') + rewardDetails + fact('steps') + fact('limits') +
    '</dl><a href="#' + notice.table + '">查看應援規則與獎勵表</a></article><h2 id="sources">官方公告段落</h2>' +
    notice.sources.map(source => '<article id="' + source.id + '"><pre>' + escape(source.text) + '</pre></article>').join(''));
}

export function website({ dir = 'data', now = () => new Date(), fetchSource = fetchNotice, summarize = gemini } = {}) {
  let importing = false;
  async function readSaved(name = 'summary.json') {
    try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  async function save(name, value) {
    const target = join(dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(target + '.tmp', value, 'utf8');
    await rename(target + '.tmp', target);
  }
  return createServer(async (req, res) => {
    const respond = (status, body) => res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    }).end(body);
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? '')) {
        throw new Problem('請使用本機網站網址。', 403);
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/import') {
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw new Problem('請從本機網站操作。', 403);
        }
        if (importing) throw new Problem('公告正在整理中。', 409);
        importing = true;
        let sourceSaved = false;
        try {
          const html = await fetchSource();
          if (!html.trim()) throw new Problem('官網回傳空白公告。');
          const capturedAt = now().toISOString();
          const snapshot = '19129-' + capturedAt.replace(/[:.]/g, '-') + '.html';
          await save(snapshot, html);
          sourceSaved = true;
          const notice = extract(html);
          const generated = await summarize(notice);
          const summary = validate(generated?.result ?? generated, notice);
          const saved = { notice, summary, snapshot, capturedAt, model: generated?.metadata ?? null };
          await save('summary.json', JSON.stringify(saved, null, 2));
          await save('status.json', 'null');
          return respond(200, home(saved, '核心寶石', now()));
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          const status = (sourceSaved ? '已保存來源，摘要待更新。' : '本次來源取得未完成。') + error.message;
          await save('status.json', JSON.stringify(status));
          return respond(error.status, home(await readSaved(), '', now(), status));
        } finally { importing = false; }
      }
      if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
      if (url.pathname === '/') return respond(200, home(await readSaved(), url.searchParams.get('q')?.trim() ?? '', now(), await readSaved('status.json')));
      if (url.pathname === '/note') {
        const saved = await readSaved();
        if (saved) return respond(200, note(saved, now(), url.searchParams.get('q')));
      }
      throw new Problem('找不到頁面。', 404);
    } catch (error) {
      respond(error instanceof Problem ? error.status : 500,
        page('操作未完成', '<h1>操作未完成</h1><p>' + escape(error instanceof Problem ? error.message : '本機資料讀寫失敗。') +
        '</p><p><a href="/">回首頁</a></p>'));
    }
  });
}
