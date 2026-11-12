import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activity, extract, fetchNotice, fields, gemini, method, official, Problem, validate } from './notice.mjs';
import { catalogFromSnapshot, methodContext, methodFacts, methodFields, summarizeMethod, validateMethod } from './catalog.mjs';

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
  if (!rewards.length) return '<p>目前的獎勵表沒有符合的名稱。</p><p><a href="/activities?q=' +
    encodeURIComponent(query) + '">依名稱搜尋公告 19129 的其他活動 →</a></p>';
  const time = timing(saved.notice.dates, now);
  const href = query ? '/note?q=' + encodeURIComponent(query) + '#method' : '/note#method';
  return rewards.map(({ name, quantity, level }) => '<article><h2>' + escape(name) + ' ×' + escape(quantity) +
    '／次</h2><p>' + activity + ' › ' + method + ' · ' + escape(level) + '</p><p>' + time.status +
    ' · ' + time.text + '</p><a href="' + href + '">查看取得方式 →</a></article>').join('');
}

function home(saved, query, now, status, hasSnapshot = Boolean(saved)) {
  return page('新楓之谷公告懶人包', '<h1>新楓之谷公告懶人包</h1><form method="get"><label for="q">搜尋獎勵或活動</label> <input id="q" name="q" value="' +
    escape(query) + '"> <button>搜尋</button></form>' + searchResults(saved, query, now) +
    (hasSnapshot ? '<p><a href="/activities">查看公告 19129 的全部活動</a></p>' : '') +
    '<details' + (status ? ' open' : '') + '><summary>公告管理</summary>' +
    (status ? '<p>' + escape(status) + '</p>' : '') +
    (saved ? '<p>已保存摘要：' + escape(new Date(saved.capturedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })) + '（台灣時間）</p>' : '') +
    '<form method="post" action="/import"><button>匯入並整理公告 19129</button></form></details>');
}

function activityList(activities, query, now) {
  const entries = activities.filter(item => !query || item.title.includes(query) || item.methods.some(method => method.title.includes(query)));
  return page('公告 19129 活動', '<nav><a href="/">← 首頁</a></nav><h1>' + escape(activities[0].pageTitle) +
    '</h1><p>' + link + '</p><form><label for="q">活動名稱</label> <input id="q" name="q" value="' + escape(query) +
    '"> <button>搜尋</button></form>' +
    (entries.length ? entries.map(item => {
      const time = timing(item.dates, now);
      return '<article><h2><a href="/activities/' + item.id + '">' + escape(item.title) + '</a></h2><p>' +
        (item.groupTitle ? escape(item.groupTitle) + ' · ' : '') + time.status + ' · ' + time.text + '</p></article>';
    }).join('') : '<p>查無符合的活動。</p>'));
}

function activityDetail(item, now, summaries = {}, status = '') {
  const time = timing(item.dates, now);
  const cite = source => source ? escape(source.text) + ' <a href="#' + source.id + '">查看依據</a>' : '未載明／待確認';
  const facts = (label, sources) => '<dt>' + label + '</dt>' +
    (sources.length ? sources.map(source => '<dd>' + cite(source) + '</dd>').join('') : '<dd>未載明／待確認</dd>');
  const sections = item.methods.map(method => {
    if (method.kind === 'reference') return '<details><summary>補充說明 · ' + escape(method.title) +
      '</summary>' + methodContext(item, method).filter(source => method.sourceIds.includes(source.id))
        .map(source => '<p>' + cite(source) + '</p>').join('') + '</details>';
    const { steps, rewards, costs, chances, limits } = methodFacts(item, method);
    const rewardLabel = chances.some(source => source.text.includes('可能獲得')) ? '可能獎勵' : '獎勵';
    const shortRewards = rewards.filter(source => !source.text.includes('\n'));
    return '<article id="' + method.id + '"><h2>' + escape(method.title) + '</h2><dl>' +
      facts('第一步', steps ? [steps] : []) + facts(rewardLabel, shortRewards) + facts('重要限制', limits) +
      facts('成本及付費條件', costs) +
      facts('機率', chances.filter(source => /機率/.test(source.text))) +
      '</dl><details><summary>Gemini 整理</summary>' +
      (summaries[method.id] ? '<dl>' + Object.entries(methodFields).map(([key, label]) =>
        facts(label, summaries[method.id].facts[key].map(fact => ({ text: fact.text, id: fact.source })))).join('') + '</dl>' : '<p>尚未整理這個方法。</p>') +
      '<form method="post" action="/activities/' + item.id + '/' + method.id + '"><button>用 Gemini 整理這個方法</button></form></details>' +
      '<details><summary>查看方法原文及表格</summary>' +
      methodContext(item, method).filter(source => method.sourceIds.includes(source.id) || item.local.includes(source))
        .map(source => '<pre>' + cite(source) + '</pre>').join('') + '</details></article>';
  }).join('');
  return page(item.title, '<nav><a href="/activities">← 全部活動</a></nav><h1>' + escape(item.title) + '</h1><p>' +
    time.status + ' · ' + link + '</p>' + (status ? '<p role="status">' + escape(status) + '</p>' : '') +
    '<dl><dt>參加資格</dt><dd>' + cite(item.eligibility) +
    (item.sharedEligibility && item.sharedEligibility.text !== item.eligibility?.text
      ? '</dd><dd>版本共用資格 · ' + cite(item.sharedEligibility) : '') +
    '</dd><dt>參加期間</dt><dd>' + time.text + (item.date ? ' <a href="#' + item.date.id + '">查看依據</a>' : '') +
    '</dd><dt>領獎期限</dt><dd>' + cite(item.local.find(source => /(?:領獎|領取)(?:期限|期間|截止)/.test(source.text))) +
    '</dd></dl>' + sections +
    '<h2>官方公告段落</h2>' + item.sources.map(source => '<article id="' + source.id + '"><small>' +
      escape(source.scope) + '</small><pre>' + escape(source.text) + '</pre></article>').join('') +
    '<details><summary>官方圖片來源（內容待確認）</summary>' +
    item.images.map((url, i) => '<p><a href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">官方圖片 ' + (i + 1) + '</a></p>').join('') + '</details>');
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

export function website({ dir = 'data', now = () => new Date(), fetchSource = fetchNotice, summarize = gemini, summarizeActivityMethod = summarizeMethod } = {}) {
  let importing = false;
  let catalogCache;
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
    let methodLocked = false;
    const respond = (status, body) => res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    }).end(body);
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? '')) {
        throw new Problem('請使用本機網站網址。', 403);
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        throw new Problem('請從本機網站操作。', 403);
      }
      if (req.method === 'POST' && url.pathname === '/import') {
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
          await save('activity-source.json', JSON.stringify({ snapshot }));
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
          return respond(error.status, home(await readSaved(), '', now(), status, Boolean(await readSaved('activity-source.json'))));
        } finally { importing = false; }
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const saved = await readSaved();
        return respond(200, home(saved, url.searchParams.get('q')?.trim() ?? '', now(), await readSaved('status.json'),
          Boolean(await readSaved('activity-source.json') ?? saved)));
      }
      if (url.pathname === '/activities' || url.pathname.startsWith('/activities/')) {
        if (req.method === 'POST') {
          if (importing) throw new Problem('公告正在整理中。', 409);
          importing = methodLocked = true;
        }
        const saved = await readSaved('activity-source.json') ?? await readSaved();
        if (!saved) throw new Problem('請先匯入公告 19129。', 404);
        if (catalogCache?.snapshot !== saved.snapshot) {
          const entry = {
            snapshot: saved.snapshot,
            items: (async () => {
              const items = catalogFromSnapshot(await readFile(join(dir, saved.snapshot), 'utf8'));
              await save('activity-catalog.json', JSON.stringify({ snapshot: saved.snapshot, items }, null, 2));
              return items;
            })(),
          };
          catalogCache = entry;
          entry.items.catch(() => { if (catalogCache === entry) catalogCache = undefined; });
        }
        const items = await catalogCache.items;
        if (req.method === 'GET' && url.pathname === '/activities') return respond(200, activityList(items, url.searchParams.get('q')?.trim() ?? '', now()));
        const [, , activityId, methodId, extra] = url.pathname.split('/');
        const item = items.find(item => item.id === activityId);
        if (!item || extra !== undefined) throw new Problem('找不到活動。', 404);
        const savedMethods = await readSaved('activity-methods.json');
        const summaries = savedMethods?.snapshot === saved.snapshot ? savedMethods.methods : {};
        if (req.method === 'GET' && !methodId) return respond(200, activityDetail(item, now(), summaries));
        const target = item.methods.find(method => method.id === methodId && method.kind === 'method');
        if (req.method === 'POST' && target) {
            const sources = methodContext(item, target);
            const generated = await summarizeActivityMethod({ title: item.title, method: target.title, sources });
            const known = methodFacts(item, target);
            const facts = validateMethod(generated.result, sources, {
              eligibility: item.eligibility ? [item.eligibility.id] : [],
              steps: known.steps ? [known.steps.id] : [],
              rewards: known.rewards.map(source => source.id),
            });
            const updated = { ...summaries, [target.id]: { facts, model: generated.metadata, at: now().toISOString() } };
            await save('activity-methods.json', JSON.stringify({ snapshot: saved.snapshot, methods: updated }, null, 2));
            res.writeHead(303, { Location: '/activities/' + item.id + '#' + target.id }).end();
            return;
        }
      }
      if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
      if (url.pathname === '/note') {
        const saved = await readSaved();
        if (saved) return respond(200, note(saved, now(), url.searchParams.get('q')));
      }
      throw new Problem('找不到頁面。', 404);
    } catch (error) {
      respond(error instanceof Problem ? error.status : 500,
        page('操作未完成', '<h1>操作未完成</h1><p>' + escape(error instanceof Problem ? error.message : '本機資料讀寫失敗。') +
        '</p><p><a href="/">回首頁</a></p>'));
    } finally {
      if (methodLocked) importing = false;
    }
  });
}
