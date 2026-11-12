import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activity, extract, fetchNotice, fields, gemini, method, official, Problem, validate } from './notice.mjs';
import { catalogFromSnapshot, methodContext, methodFacts, methodFields, summarizeMethod, validateMethod } from './catalog.mjs';
import { manualActivity, mergeManual, reviewDocument } from './review.mjs';
import { fetchOfficialImage, imageKey, recognizeImage } from './images.mjs';
import { fingerprint, methodFingerprint, sourceReferences, summaryForDisplay } from './incremental.mjs';
import { CODEX_MODEL, createCodexGenerator } from './codex.mjs';
import { fetchCorrection, officialCorrectionUrl, verifiedSource, withCorrections } from './corrections.mjs';
import { activityState, periodText, timeline } from './periods.mjs';
import { rewardTypes, searchCatalog, statuses } from './search.mjs';
import { answerPlayer, compareMethods, playerAssistant, searchWithAgent } from './player-assist.mjs';
import { announcementUrl, collectAnnouncements, discoveryWindow, officialAnnouncement, officialPages, saveAnnouncement } from './discovery.mjs';
import { sourceTracking } from './tracking.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const link = '<a href="' + official + '" target="_blank" rel="noopener noreferrer">查看官方公告 ↗</a>';
const style = 'body{margin:0;background:#f6f5ef;color:#252e26;font:17px/1.65 system-ui,sans-serif}main{max-width:48rem;margin:auto;padding:2rem 1rem}h1,h2{line-height:1.25}a{color:#17563d}article,details{background:white;border:1px solid #d9e1d7;padding:1rem;margin:1rem 0;border-radius:12px}input,button{font:inherit;padding:.45rem .65rem}button{cursor:pointer}dt{font-weight:700}dd{margin:0 0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{margin-bottom:1rem}';
const layout = `
main:has(.activity-grid){max-width:72rem}
summary{cursor:pointer;font-weight:700}
.activity-family{--accent:#32664d;border-top:3px solid var(--accent);margin:1.5rem 0 2rem;padding-top:.65rem}
.activity-family[data-tone="1"]{--accent:#485993}
.activity-family[data-tone="2"]{--accent:#93532c}
.activity-family[data-tone="3"]{--accent:#765086}
.activity-family[data-tone="4"]{--accent:#32646f}
.activity-family>h2{color:var(--accent);margin:.25rem 0 .8rem;font-size:1.3rem}
.activity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:.8rem}
.activity-grid>article{margin:0;padding:.85rem;border-top:3px solid var(--accent);min-width:0}
.activity-grid h2,.activity-grid h3{font-size:1.05rem;line-height:1.35;margin:.45rem 0;overflow-wrap:anywhere}
.activity-grid p{font-size:.9rem;margin:.35rem 0}
.event-label{display:inline-block;border:1px solid #cfdad2;border-radius:.4rem;padding:.05rem .4rem;color:#405449;font-size:.82rem}
.image-preview{border:0;padding:0;margin:.5rem 0;background:transparent}
.image-preview img{display:block;max-width:100%;width:auto;height:auto;max-height:min(65vh,30rem);object-fit:contain;margin:.6rem 0}
.source-panel article:target{border-color:#17563d;outline:2px solid #17563d}
.activity-nav{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.55rem 0;background:#f6f5ef;border-bottom:1px solid #d9e1d7}
.official-button{white-space:nowrap;padding:.3rem .7rem;border:1px solid #b5cbbd;border-radius:.5rem;background:#fff;font-weight:700}
.search-home-link{display:inline-block;margin-inline-start:.5rem;padding:.45rem .65rem;border:1px solid #b5cbbd;border-radius:.4rem;background:#fff;white-space:nowrap}
main :target{scroll-margin-top:4rem}
.source-table{overflow-x:auto;margin:.5rem 0}
.source-table table{border-collapse:collapse;width:100%;font-size:.95rem}
.source-table td,.source-table th{border:1px solid #bccbc1;padding:.45rem .6rem;vertical-align:top;white-space:pre-line;min-width:6em}
.source-table th,.source-table tr:first-child{background:#edf3ee}
.player-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin:1rem 0}
.player-question{display:grid;gap:.5rem}
.player-question textarea{box-sizing:border-box;width:100%;font:inherit}
.player-question button{justify-self:start}
.comparison{overflow-x:auto}
.comparison td{min-width:13rem}
.comparison-select{display:block;width:100%;max-width:100%;font:inherit}
.evidence-image{display:block;max-width:100%;height:auto}
`;
const page = (title, body) => '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title><style>' + style + layout + '</style><main>' + body + '</main></html>';
const imageActions = `
function revealSource(hash) {
  if (!hash) return;
  const target = document.getElementById(hash.slice(1));
  const panel = target?.closest('.source-panel, details[data-source-flow], #image-library');
  if (panel && !panel.open) {
    panel.open = true;
    target.scrollIntoView();
  }
}
revealSource(location.hash);
window.addEventListener('hashchange', () => revealSource(location.hash));
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (link) revealSource(link.hash);
});
document.addEventListener('submit', async event => {
  const form = event.target;
  const card = form.closest('#image-library article');
  if (!card || !event.submitter) return;
  event.preventDefault();
  const button = event.submitter;
  if (form.dataset.pending) return;
  form.dataset.pending = 'true';
  const report = form.querySelector('.image-status') || document.createElement('p');
  report.className = 'image-status';
  report.setAttribute('role', 'status');
  report.textContent = '正在處理這張圖片…';
  if (!report.isConnected) form.append(report);
  try {
    const body = new URLSearchParams(new FormData(form, button));
    const endpoint = new URL(form.getAttribute('action'), location.href);
    endpoint.hash = '';
    const response = await fetch(endpoint, { method: 'POST', body });
    const documentAfter = new DOMParser().parseFromString(await response.text(), 'text/html');
    const newCard = documentAfter.getElementById(card.id);
    if (!response.ok || !newCard) throw new Error(documentAfter.querySelector('h1 + p')?.textContent || '圖片更新失敗。');
    const slotId = 'slot-' + card.id;
    const slot = document.getElementById(slotId);
    const newSlot = documentAfter.getElementById(slotId);
    const previousTop = button.getBoundingClientRect().top;
    const wasPreviewing = card.querySelector('.image-preview')?.open;
    const wasEditing = card.querySelector('.image-note-editor')?.open;
    if (slot && newSlot) {
      slot.replaceChildren(...newSlot.childNodes);
      const original = slot.closest('details[data-source-flow]');
      if (original && slot.firstElementChild) original.open = true;
    }
    const imageNotes = document.getElementById('verified-image-notes');
    const newImageNotes = documentAfter.getElementById('verified-image-notes');
    if (imageNotes && newImageNotes) imageNotes.replaceChildren(...newImageNotes.childNodes);
    card.replaceChildren(...newCard.childNodes);
    if (wasPreviewing && card.querySelector('.image-preview')) card.querySelector('.image-preview').open = true;
    const editor = card.querySelector('.image-note-editor');
    if (editor && (wasEditing || button.value === 'recognize')) editor.open = true;
    const message = documentAfter.querySelector('main > p[role="status"]');
    if (message) {
      report.textContent = message.textContent;
      card.append(report);
    }
    const next = [...card.querySelectorAll('button')].find(entry => entry.value === button.value ||
      (button.value === 'select' && entry.value === 'remove') || (button.value === 'remove' && entry.value === 'select'));
    if (next) {
      next.focus({ preventScroll: true });
      window.scrollBy(0, next.getBoundingClientRect().top - previousTop);
    }
  } catch (error) {
    report.textContent = error.message;
    delete form.dataset.pending;
  }
});
`;

const taipeiTimestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium',
});
const formatTimestamp = value => value ? taipeiTimestamp.format(new Date(value)) + '（台北時間）' : '尚未記錄';

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

function filterOptions(name, values, value, label) {
  return '<label>' + label + ' <select name="' + name + '"><option value="">全部</option>' +
    values.map(option => '<option' + (option === value ? ' selected' : '') + '>' + option + '</option>').join('') + '</select></label>';
}

const familyTitle = item => item.pageTitle?.trim() || '未分組活動';
const familyLabel = item => item.groupTitle ? familyTitle(item) + ' › ' + item.groupTitle : familyTitle(item);
const eventLabel = item => '<span class="event-label">' + escape(familyLabel(item)) + '</span>';

function activityGroups(entries, itemOf, render) {
  const groups = new Map();
  for (const entry of entries) {
    const title = familyTitle(itemOf(entry));
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(entry);
  }
  return [...groups].map(([title, cards]) => {
    const tone = [...title].reduce((total, char) => (total * 31 + char.codePointAt(0)) % 5, 0);
    return '<section class="activity-family" data-tone="' + tone + '"><h2>' + escape(title) +
      '</h2><div class="activity-grid">' + cards.map(render).join('') + '</div></section>';
  }).join('');
}

function catalogResults(entries, saved) {
  if (!entries.length) return '<p>在已收錄的公告 19129 及其他已確認來源中找不到符合的結果。</p>';
  return activityGroups(entries, entry => entry.item, ({ item, method: target, reward, state, periods, image }) => {
    const legacy = saved && reward && item.title === activity && target.title === method &&
      matchingRewards(saved.notice, reward.name).some(entry => entry.name === reward.name && entry.quantity === reward.quantity);
    const href = legacy ? '/note?q=' + encodeURIComponent(reward.name) + '#method' :
      '/activities/' + item.id + (target ? '#' + target.id : '');
    const title = reward ? reward.name + (reward.quantity ? ' ×' + reward.quantity : '') : target?.title ?? item.title;
    return '<article>' + eventLabel(item) + '<h3><a href="' + href + '">' + escape(title) + '</a></h3>' +
      (reward ? '<p>' + escape(item.title + ' › ' + target.title) + ' · ' + escape(reward.type) +
        (reward.group ? ' · ' + escape(reward.group) : '') + (reward.possible ? ' · 可能獎勵' : '') + '</p>' : '') +
      '<p>' + escape(state) + ' · ' + escape(periodText(periods.participation)) + '</p>' +
      (state === '仍可領獎' ? '<p>領獎期限 · ' + escape(periodText(periods.claim)) + '</p>' : '') +
      '<p>來源 · ' + escape(item.pageTitle) + (item.officialUrl ? '' : '（19129）') + '</p>' +
      (image ? '<img loading="lazy" style="max-width:160px" src="/images/' + image + '" alt="' + escape(reward.name) + '">' :
        reward ? '<p>尚無外觀圖片</p>' : '') +
      '<p><a href="' + href + '">' + (reward ? '查看取得方式 →' : '查看活動 →') + '</a></p></article>';
  });
}

function home(saved, query, now, status, hasSnapshot = Boolean(saved), listing, assist) {
  const hasSearch = query || listing?.filters.status || listing?.filters.type;
  const entries = listing ? searchCatalog(listing.items, listing.filters, now, listing.images) : [];
  const offerAssist = listing && query && (!entries.length || entries.length > 8 || assist);
  let nameResults = listing ? catalogResults(entries, listing.snapshot === saved?.snapshot ? saved : null) :
    searchResults(saved, query, now);
  if (assist) nameResults = entries.length || !assist.matches?.length
    ? '<section><h2>名稱搜尋結果</h2>' + nameResults + '</section>' : '';
  return page('新楓之谷公告懶人包', '<h1>新楓之谷公告懶人包</h1><form method="get" action="/"><label for="q">搜尋獎勵或活動</label> <input id="q" name="q" value="' +
    escape(query) + '"> ' + (listing ? filterOptions('state', statuses, listing.filters.status, '活動狀態') + ' ' +
      filterOptions('type', rewardTypes, listing.filters.type, '獎勵類型') + ' ' : '') +
    '<button>搜尋</button>' + (offerAssist ? ' <button formmethod="post" formaction="/assist/search">用 Agent 搜尋</button>' : '') +
    (hasSearch ? '<a class="search-home-link" href="/">回首頁</a>' : '') + '</form>' +
    (assist ? '<section><h2>Agent 搜尋結果</h2>' + (assist.error ? '<p role="alert">' + escape(assist.error) + '</p>' :
      assist.matches.length ? catalogResults(assist.matches) + assistantModel(assist.metadata) :
        '<p>已收錄的活動與獎勵沒有明確符合的結果。</p>') + '</section>' : '') +
    nameResults +
    (hasSnapshot || listing ? '<p><a href="/activities">查看全部已收錄活動</a></p>' : '') +
    '<details' + (status ? ' open' : '') + '><summary>公告管理</summary>' +
    (status ? '<p>' + escape(status) + '</p>' : '') +
    (saved?.capturedAt ? '<p>已保存摘要：' + escape(new Date(saved.capturedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })) + '（台灣時間）</p>' : '') +
    (hasSnapshot ? '<p><a href="/review">檢視與調整公告拆分</a> · <a href="/updates">來源與摘要更新</a> · <a href="/corrections">來源關聯與更正</a></p>' : '') +
    '<p><a href="/discover">探索與回溯官方公告</a> · <a href="/tracking">活動來源追蹤</a></p>' +
    '<form method="post" action="/import"><button>匯入並整理公告 19129</button></form></details>');
}

function reviewPage(document, automatic, previous, message, route = '/review', officialUrl) {
  const options = automatic.flatMap(item => item.methods.filter(method => method.kind === 'method')
    .map(method => '<option value="' + method.id + '">' + escape(item.title + ' › ' + method.title) + '</option>')).join('');
  return page('檢視公告拆分', '<nav><a href="/">← 首頁</a> · <a href="/activities">查看活動</a></nav><h1>檢視公告拆分</h1>' +
    '<p>' + escape(message) + '</p>' +
    (previous && previous.fingerprint !== document.fingerprint ? '<p role="status">來源已變更，舊人工歸屬需重新核對。</p>' : '') +
    '<p><a href="' + route + '/source" download>下載完整來源快照</a>' +
    (officialUrl ? ' · <a href="' + escape(officialUrl) + '">官方公告 ↗</a> · <a href="/discover">回公告探索</a>' : '') + '</p>' +
    (previous ? '<p>已保存人工確認：' + previous.entries.map(entry => escape(entry.title + ' › ' + entry.methods[0].title)).join('、') + '</p>' : '') +
    '<form method="post"><input type="hidden" name="fingerprint" value="' + document.fingerprint + '">' +
    '<p><label>要調整的方法 <select name="target"><option value="">新增活動或方法</option>' + options + '</select></label></p>' +
    '<p><label>方法所屬活動 <select name="parent"><option value="">保留目前歸屬，或新增活動</option>' +
    automatic.map(item => '<option value="' + item.id + '">' + escape(item.title) + '</option>').join('') + '</select></label></p>' +
    '<p><label>新活動名稱（新增活動才填） <input name="title" maxlength="100"></label></p><p><label>方法名稱 <input name="method" required maxlength="100"></label></p>' +
    document.blocks.map(block => '<article><strong>' + block.id + '</strong>' + sourceBody(block) +
      block.images.map((url, index) => '<p><a href="' + escape(url) + '">官方圖片 ' + (index + 1) + '</a></p>').join('') +
      '<label><input type="checkbox" name="own" value="' + block.id + '">方法內容</label> ' +
      '<label><input type="checkbox" name="shared" value="' + block.id + '">適用共用條件</label></article>').join('') +
    '<button>確認並保存拆分</button></form>');
}

function discoveryPage(window, registry, message) {
  const run = registry.run;
  const labels = { version: '版本公告', routine: '例行公告', related: '相關異動' };
  const entries = Object.values(registry.entries).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return page('探索官方公告', '<nav><a href="/">← 首頁</a> · <a href="/activities">查看活動</a></nav><h1>探索官方公告</h1>' +
    '<p>最近 90 天（台北時間） · ' + window.start + ' 至 ' + window.end + '</p>' +
    '<form method="post"><button>檢查官方公告列表</button></form>' +
    '<form method="post" action="/discover/import"><p><label>手動補入官方網址 <input type="url" name="url" required></label> ' +
    '<button>保存來源</button></p></form>' + (message ? '<p role="status">' + escape(message) + '</p>' : '') +
    (run ? '<p>上次檢查 · ' + escape(formatTimestamp(run.at)) + ' · ' + run.start + ' 至 ' + run.end +
      ' · 讀取 ' + run.pages + ' 頁 · 範圍內可讀公告連結 ' + run.candidates + ' 筆 · 保存 ' + run.saved + ' 筆</p>' +
      (run.error ? '<p role="alert">列表檢查未完成 · ' + escape(run.error) + '</p>' : '') +
      (run.failures.length ? '<details><summary>正文取得失敗 ' + run.failures.length + ' 筆</summary><ul>' +
        run.failures.map(entry => '<li><a href="' + escape(entry.url) + '">' + escape(entry.title) + '</a> · ' +
          escape(entry.error) + '</li>').join('') + '</ul></details>' : '') : '') +
    '<h2>已保存來源</h2>' + (entries.length ? '<ul>' + entries.map(entry => '<li><a href="/discover/' + entry.id + '">' +
      escape(entry.title) + '</a> · ' + escape(entry.date ?? '發布日未載明') + ' · ' + labels[entry.kind] + ' · ' +
      (entry.kind !== 'version' ? '來源已保存' : entry.active ? '可查看活動' :
        entry.review?.snapshot === entry.snapshot ? '已人工確認 · 可整理摘要' : '來源已保存 · 拆分待確認') + '</li>').join('') +
      '</ul>' : '<p>尚未保存公告來源。</p>'));
}

async function formData(req, limit = 100_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Problem('表單內容過大。', 413);
  }
  return new URLSearchParams(body);
}

function activityList(activities, query, now, pending = '') {
  const entries = activities.filter(item => !query || item.title.includes(query) || item.methods.some(method => method.title.includes(query)));
  return page('活動清單', '<nav><a href="/">← 首頁</a></nav><h1>活動清單' +
    '</h1><p>' + link + '</p>' + (pending ? '<p>' + escape(pending) + ' <a href="/review">檢視來源</a></p>' : '') +
    '<form><label for="q">活動名稱</label> <input id="q" name="q" value="' + escape(query) +
    '"> <button>搜尋</button></form>' +
    (entries.length ? activityGroups(entries, item => item, item => {
      const periods = timeline(item);
      return '<article>' + eventLabel(item) + '<h3><a href="/activities/' + item.id + '">' + escape(item.title) + '</a></h3><p>' +
        activityState(periods, now) + ' · ' + escape(periodText(periods.participation)) + '</p></article>';
    }) : '<p>查無符合的活動。</p>'));
}

function sourceBody(source) {
  const rows = source.cells ?? source.rows?.map(row => row.map(text => ({ text })));
  if (!rows?.length) return '<pre>' + escape(source.text) + '</pre>';
  const span = (name, value) => Number.isInteger(value) && value > 1 && value < 1000 ? ' ' + name + '="' + value + '"' : '';
  return '<div class="source-table" tabindex="0" role="region" aria-label="官方公告表格"><table><tbody>' +
    rows.map(row => '<tr>' + row.map(cell => {
      const tag = cell.heading ? 'th' : 'td';
      return '<' + tag + span('colspan', cell.colspan) + span('rowspan', cell.rowspan) + '>' + escape(cell.text) + '</' + tag + '>';
    }).join('') + '</tr>').join('') + '</tbody></table></div>';
}

const isTable = source => Boolean(source?.cells?.length || source?.rows?.length);
const evidenceLink = source => isTable(source)
  ? ' <a href="#' + source.id + '">查看公告表格</a>' : '';

function activityNav(backHref, backText, title, sourceUrl = official) {
  const fragment = encodeURIComponent(title).replaceAll('-', '%2D');
  return '<nav class="activity-nav"><a href="' + backHref + '">' + backText + '</a>' +
    '<a class="official-button" href="' + escape(sourceUrl + '#:~:text=' + fragment) + '" target="_blank" rel="noopener noreferrer">官方公告 ↗</a></nav>';
}

function assistantModel(metadata) {
  return metadata?.model ? '<p>模型 · ' + escape(metadata.model) + '</p>' : '';
}

function assistantFacts(facts) {
  return facts.length ? '<ul>' + facts.map(fact => '<li>' + escape(fact.text) + ' ' +
    fact.sources.map(source => '<a href="#evidence-' + source.id + '">依據 ' + source.id + '</a>').join(' ') +
    '</li>').join('') + '</ul>' : '<p>公告未載明</p>';
}

function assistantEvidence(facts) {
  const sources = new Map(facts.flatMap(fact => fact.sources.map(source => [source.id, source])));
  if (!sources.size) return '';
  return '<h2>官方依據</h2>' + [...sources.values()].map(source =>
    '<details data-source-flow><summary id="evidence-' + source.id + '">依據 ' + source.id + ' · ' +
    escape(source.activity + ' · ' + source.scope) + '</summary>' + sourceBody(source) +
    (source.image ? '<img class="evidence-image" loading="lazy" src="' + source.image + '" alt="核對用官方原圖">' : '') +
    '<a target="_blank" rel="noopener noreferrer" href="' +
    escape(source.url ?? official + '#:~:text=' + encodeURIComponent(source.activity).replaceAll('-', '%2D')) +
    '">查看官方公告 ↗</a></details>').join('') + '<script src="/image-actions.js" defer></script>';
}

function verifiedImageSources(item, records) {
  return [...new Set(item.images)].flatMap((url, index) => {
    const key = imageKey(url);
    const record = records[key];
    const note = record?.verifiedText?.[item.id];
    return note && note.version === record.version ? [{
      id: key, scope: '官方圖片 ' + (index + 1) + ' · 已核對文字', text: note.text,
      image: '/images/' + key + '?v=' + encodeURIComponent(note.version),
    }] : [];
  });
}

function imageNoteEditor(item, record) {
  const note = record?.verifiedText?.[item.id];
  const confirmed = note?.version === record?.version ? note : undefined;
  if (!record?.recognition && !confirmed) return '';
  return '<details class="image-note-editor"><summary>' + (confirmed ? '圖片文字 · 已加入活動筆記' : '圖片辨識 · 待人工核對') + '</summary>' +
    '<input type="hidden" name="imageVersion" value="' + escape(record.version) + '">' +
    '<div class="player-question"><label>對照原圖後，保留適用於本活動的文字<textarea name="imageText" rows="5" maxlength="16000">' +
    escape(confirmed?.text ?? record.recognition.text) + '</textarea></label>' +
    '<div><button name="action" value="verify-text">核對並加入活動筆記</button> ' +
    (confirmed ? '<button name="action" value="remove-text">移除已核對文字</button>' : '') + '</div></div>' +
    (confirmed && record.recognition ? '<details><summary>查看 Gemini 辨識稿</summary><pre>' +
      escape(record.recognition.text) + '</pre></details>' : '') + '</details>';
}

function questionForm(item, question = '') {
  return '<form class="player-question" method="post" action="/activities/' + item.id +
    '/ask"><label for="player-question">你想更了解這個活動的哪些細節？</label><textarea id="player-question" name="question" rows="2" ' +
    'maxlength="500" required placeholder="例如：參加資格、活動玩法、獎勵或期限">' +
    escape(question) + '</textarea><button>用 Agent 回答</button></form>';
}

const activityMethods = items => items.flatMap(item => item.methods.filter(method => method.kind === 'method')
  .map(method => ({ item, method })));
const methodLabel = ({ item, method }) => item.title + ' › ' + method.title;

function comparisonPage(methods, from, selections = [], result, error) {
  const back = from ? '/activities/' + from.id : '/activities';
  const fields = ['第一種方式', '第二種方式'].map((label, index) =>
    '<p><label>' + label + '<select class="comparison-select" name="method" required><option value="">請選擇</option>' +
    methods.map(entry => '<option value="' + entry.method.id + '"' + (selections[index] === entry.method.id ? ' selected' : '') +
      '>' + escape(methodLabel(entry)) + '</option>').join('') + '</select></label></p>').join('');
  const output = result ? '<h2>比較結果</h2><div class="source-table comparison" tabindex="0" role="region" aria-label="取得方式比較">' +
    '<table><thead><tr><th scope="col">項目</th>' + selections.map(id => '<th scope="col">' +
    escape(methodLabel(methods.find(entry => entry.method.id === id))) + '</th>').join('') + '</tr></thead><tbody>' +
    result.rows.map(row => '<tr><th scope="row">' + escape(row.label) + '</th>' +
      row.cells.map(facts => '<td>' + assistantFacts(facts) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>' + assistantModel(result.metadata) + assistantEvidence(result.rows.flatMap(row => row.cells.flat())) : '';
  return page('比較取得方式', '<nav><a href="' + back + '">← 返回活動</a></nav><h1>比較取得方式</h1>' +
    (methods.length < 2 ? '<p>目前可比較的方法少於兩種。</p>' : '<form method="post" action="/compare">' +
    (from ? '<input type="hidden" name="activity" value="' + from.id + '">' : '') +
    fields + '<button>用 Agent 比較</button></form>') +
    (error ? '<p role="alert">' + escape(error) + '</p>' : '') + output);
}

function activityDetail(item, now, summaries = {}, status = '', imageRecords = {}, provider = 'gemini') {
  const periods = timeline(item);
  const showPeriod = (label, period, field) => {
    const change = period.change;
    const linked = item.linkedSources?.filter(source => source.field === field) ?? [];
    const evidence = change
      ? '<p>原公告 · ' + escape(periodText(period.original)) + '</p><p><a href="' + escape(change.url) +
        '" target="_blank" rel="noopener noreferrer">查閱官方更正 ↗</a></p>'
      : linked.length ? '<p>' + (linked.filter(entry => entry.kind === 'correction').length > 1 ? '官方更正期限有差異，待比對' : '另有來源待比對') +
        ' <a href="/corrections?activity=' + item.id + '">查看來源關聯</a></p>' : '';
    return '<dt>' + label + '</dt><dd>' + escape(periodText(period)) + (period.source ? evidenceLink(period.source) : '') + evidence + '</dd>';
  };
  const cite = source => source ? (isTable(source) ? '' : escape(source.text)) +
    evidenceLink(item.sources.find(original => original.id === source.id) ?? source) : '未載明／待確認';
  const facts = (label, sources, earlier) => {
    const repeated = new Set(earlier?.sources.map(source => source.text.replace(/\s+/g, ' ').trim()));
    const unique = sources.filter(source => !repeated.has(source.text.replace(/\s+/g, ' ').trim()));
    return '<dt>' + label + '</dt>' + (sources.length
      ? (unique.length < sources.length ? '<dd>同' + earlier.label + '</dd>' : '') +
        unique.map(source => '<dd>' + cite(source) + '</dd>').join('')
      : '<dd>未載明／待確認</dd>');
  };
  const placed = new Set();
  const placedTables = new Set();
  const isSelected = url => imageRecords[imageKey(url)]?.selected ?? item.shopImages?.includes(url);
  const imagesFor = urls => [...new Set(urls)].filter(url => !placed.has(url)).map(url => {
    placed.add(url);
    const key = imageKey(url);
    const record = imageRecords[key];
    const figure = !isSelected(url) ? '' : '<figure><img loading="lazy" style="max-width:100%" src="' +
      (record?.version ? '/images/' + key : escape(url)) + '" alt="' + escape(record?.appearance || '官方原圖') + '">' +
      '<figcaption>' + escape(record?.appearance || '官方原圖 · 物品對應待確認') + '</figcaption></figure>';
    return '<div id="slot-image-' + key + '">' + figure + '</div>';
  }).join('');
  const originalFlow = (sources, urls, title) => {
    const allowed = new Set(urls.filter(url => !placed.has(url)));
    const at = images => imagesFor((images ?? []).filter(url => allowed.has(url)));
    const body = sources.map(source => {
      let table = '';
      if (isTable(source) && !placedTables.has(source.id)) {
        placedTables.add(source.id);
        table = '<div id="' + source.id + '">' + sourceBody(source) + '</div>';
      }
      return at(source.beforeImages) + table + at(source.images);
    }).join('');
    if (!body && !allowed.size) return '';
    return '<details data-source-flow' + ([...allowed].some(isSelected) ? ' open' : '') + '><summary>' +
      title + '</summary>' + body + imagesFor([...allowed]) + '</details>';
  };
  const sections = item.methods.map(method => {
    if (method.kind === 'reference') return originalFlow(
      methodContext(item, method).filter(source => method.sourceIds.includes(source.id)), method.images,
      '補充說明 · ' + escape(method.title));
    const { steps, rewards, costs, chances, limits } = methodFacts(item, method);
    const rewardLabel = chances.some(source => source.text.includes('可能獲得')) ? '可能獎勵' : '獎勵';
    const shortRewards = rewards.filter(source => !source.text.includes('\n'));
    const ownImages = method.images.filter(url => !item.sharedImages?.includes(url) || method.sourceIds.length === 0);
    const methodPeriods = timeline(item, method);
    const procedure = { label: '進行方式', sources: steps ? [steps] : [] };
    const reset = { label: '重置規則', sources: methodPeriods.resets };
    const ownPeriods = [
      ['參加期間', 'participation'], ['開領時間', 'opening'], ['領獎期限', 'claim'],
    ].filter(([, key]) => methodPeriods[key].source?.id !== periods[key].source?.id);
    return '<article id="' + method.id + '"><h2>' + escape(method.title) + '</h2><dl>' +
      (ownPeriods.length ? '<dt>方法狀態</dt><dd>' + activityState(methodPeriods, now) + '</dd>' : '') +
      ownPeriods.map(([label, key]) => showPeriod(label, methodPeriods[key])).join('') +
      (reset.sources.length ? facts(reset.label, reset.sources) : '') +
      facts(procedure.label, procedure.sources) + facts(rewardLabel, shortRewards, procedure) + facts('重要限制', limits, reset) +
      facts('成本及付費條件', costs) +
      facts('機率', chances.filter(source => /機率/.test(source.text))) +
      '</dl>' + originalFlow(methodContext(item, method)
        .filter(source => method.sourceIds.includes(source.id) || item.local.includes(source)), ownImages,
        '公告表格與圖片') + '<details><summary>摘要整理</summary>' +
      (summaries[method.id] ? '<dl>' + Object.entries(methodFields).map(([key, label]) =>
        facts(label, summaryForDisplay(summaries[method.id], methodContext(item, method))[key].map(fact => ({ text: fact.text, id: fact.source })))).join('') + '</dl>' : '<p>尚未整理這個方法。</p>') +
      '<form method="post" action="/activities/' + item.id + '/' + method.id + '"><button>用預設模型整理這個方法</button></form></details></article>';
  }).join('');
  const shared = originalFlow(item.sources, item.images, '活動共用表格與圖片');
  const imageNotes = verifiedImageSources(item, imageRecords);
  return page(item.title, activityNav('/activities', '← 全部活動', item.title, item.officialUrl) + eventLabel(item) + '<h1>' + escape(item.title) + '</h1><p>' +
    activityState(periods, now) + ' · <a href="#player-tools">玩家查詢</a></p>' + (status ? '<p role="status">' + escape(status) + '</p>' : '') +
    '<dl><dt>參加資格</dt><dd>' + cite(item.eligibility) +
    (item.sharedEligibility && item.sharedEligibility.text !== item.eligibility?.text
      ? '</dd><dd>版本共用資格 · ' + cite(item.sharedEligibility) : '') +
    '</dd>' + showPeriod('參加期間', periods.participation, 'participation') + showPeriod('開領時間', periods.opening) +
    showPeriod('領獎期限', periods.claim, 'claim') + '</dl>' +
    (item.relatedNotices?.length ? '<details><summary>相關官方公告</summary><ul>' + item.relatedNotices.map(notice =>
      '<li><a href="/discover/' + notice.id + '">' + escape(notice.title) + '</a></li>').join('') + '</ul></details>' : '') +
    shared + sections + '<div id="verified-image-notes">' + (imageNotes.length ? '<section><h2>已核對的官方圖片文字</h2>' +
    imageNotes.map(source => '<article><h3>' + escape(source.scope) + '</h3><pre>' + escape(source.text) +
      '</pre><details class="image-preview"><summary>預覽官方原圖</summary><img loading="lazy" src="' + source.image +
      '" alt="核對用官方原圖"></details></article>').join('') + '</section>' : '') + '</div>' +
    '<section id="player-tools"><h2>玩家查詢</h2><div class="player-tools"><a href="/compare?activity=' + item.id +
    '">比較兩種取得方式</a></div><details><summary>問這個活動</summary>' + questionForm(item) + '</details></section>' +
    '<details><summary>用訂閱 Codex 整理本批</summary><p>目前預設：' +
    (provider === 'codex' ? '訂閱 Codex' : 'Gemini') + '</p><form method="post" action="/activities/' + item.id + '/batch">' +
    item.methods.filter(target => target.kind === 'method').map(target => '<label><input type="checkbox" name="method" value="' +
      target.id + '">' + escape(target.title) + '</label> ').join('') +
    '<button>用訂閱 Codex 整理勾選方法</button></form></details>' +
    '<details id="image-library"><summary>官方圖片來源與選圖</summary>' +
    item.images.map((url, i) => {
      const key = imageKey(url);
      const record = imageRecords[key];
      const shop = item.shopImages?.includes(url);
      const selected = record?.selected ?? shop;
      const preview = record?.version ? '/images/' + key : escape(url);
      return '<article id="image-' + key + '"><p>官方圖片 ' + (i + 1) + ' · ' +
        (record?.version ? '已保存本機原圖' : '尚未保存本機原圖') + '</p>' +
        '<details class="image-preview"><summary>預覽圖片</summary><img loading="lazy" src="' + preview +
        '" alt="' + escape(record?.appearance || '官方圖片 ' + (i + 1)) + '"></details>' +
        '<form method="post" action="/activities/' + item.id + '/images/' + key + '#image-' + key + '">' +
        '<button name="action" value="download">保存／重試原圖</button> ' +
        '<button name="action" value="' + (selected ? 'remove' : 'select') + '">' + (selected ? '移出' : '選入') + '懶人包</button> ' +
        (shop ? '' : '<button name="action" value="recognize">Gemini 辨識這張圖</button>' +
          '<p><label>已核對的單一獎勵名稱 <input name="appearance" maxlength="100" value="' + escape(record?.appearance || '') +
          '"></label> <button name="action" value="confirm">保存外觀對應</button></p>' + imageNoteEditor(item, record)) + '</form></article>';
    }).join('') + '</details><script src="/image-actions.js" defer></script>');
}

function note(saved, now, query, catalogItem) {
  const { notice, summary } = saved;
  const time = timing(notice.dates, now);
  const row = (title, value, source) => '<dt>' + title + '</dt><dd>' + escape(value) +
    (source ? evidenceLink(notice.sources.find(original => original.id === source)) : '') + '</dd>';
  const fact = key => row(fields[key], summary[key].text, summary[key].source);
  const rewards = query ? matchingRewards(notice, query) : [];
  const rewardDetails = rewards.some(reward => reward.name !== notice.reward)
    ? rewards.map(({ name, quantity, level }) =>
      row(fields.reward, level + '（選擇應援時）：' + name + ' ×' + quantity + '／次', notice.table)).join('')
    : fact('reward');
  return page(activity, activityNav('/?q=' + encodeURIComponent(query ?? notice.reward), '← 回搜尋結果', activity) +
    '<span class="event-label">星夜馬戲團 in 墮落城市</span><h1>' + activity +
    '</h1><p>' + time.status + (catalogItem ? ' · <a href="/activities/' + catalogItem.id + '#player-tools">玩家查詢</a>' : '') +
    '</p><dl>' + fact('eligibility') + row('參加期間', time.text, notice.date?.id) +
    row('領獎期限', notice.claim ? '請查看公告所列領取條件' : '此活動段落未載明獨立領獎期限',
      notice.claim?.id ?? 'sources') + '</dl><article id="method"><h2>' + method +
    '</h2><dl>' + fact('first') + rewardDetails + fact('steps') + fact('limits') +
    '</dl><a href="#' + notice.table + '">查看應援規則與獎勵表</a></article>' +
    '<details class="source-panel" id="sources"><summary>官方公告表格</summary>' +
    notice.sources.filter(isTable).map(source => '<article id="' + source.id + '">' + sourceBody(source) + '</article>').join('') +
    '</details><script src="/image-actions.js" defer></script>');
}

export function website({ dir = 'data', now = () => new Date(), fetchSource = fetchNotice, summarize = gemini,
  summarizeActivityMethod = summarizeMethod, downloadImage = fetchOfficialImage, summarizeImage = recognizeImage,
  codexGenerate = createCodexGenerator(), fetchLinkedSource = fetchCorrection, generatePlayerAssistance,
  openAnnouncementPages = officialPages, fetchAnnouncement = officialAnnouncement } = {}) {
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
  async function readCatalog(source) {
    if (catalogCache?.snapshot !== source.snapshot) {
      const entry = {
        snapshot: source.snapshot,
        items: (async () => {
          const items = catalogFromSnapshot(await readFile(join(dir, source.snapshot), 'utf8'));
          await save('activity-catalog.json', JSON.stringify({ snapshot: source.snapshot, items }, null, 2));
          return items;
        })(),
      };
      catalogCache = entry;
      entry.items.catch(() => { if (catalogCache === entry) catalogCache = undefined; });
    }
    return catalogCache.items;
  }
  async function confirmedItems(source) {
    const manual = await readSaved('manual-split.json');
    if (!manual) return [];
    const html = await readFile(join(dir, source.snapshot), 'utf8');
    return reviewDocument(html).fingerprint === manual.fingerprint ? manual.entries : [];
  }
  async function applyCorrections(items) {
    const corrections = await readSaved('source-corrections.json') ?? {};
    const { entries } = await discoveryRegistry();
    const related = new Map();
    for (const notice of Object.values(entries).filter(entry => entry.kind !== 'version')) {
      const ids = new Set(notice.matches.flatMap(block => block.activities.map(activity => activity.id)));
      for (const id of ids) {
        if (!related.has(id)) related.set(id, []);
        related.get(id).push({ id: notice.id, title: notice.title });
      }
    }
    return items.map(item => {
      const current = corrections[item.id]?.length ? withCorrections(item, corrections[item.id]) : item;
      return related.has(item.id) ? { ...current, relatedNotices: related.get(item.id) } : current;
    });
  }
  async function discoveryRegistry() {
    return await readSaved('discovery.json') ?? { entries: {} };
  }
  async function discoveredItems() {
    const { entries } = await discoveryRegistry();
    return Object.values(entries).flatMap(entry => mergeManual([], entry.review?.entries ?? []).map(item => ({
      ...item, discoverySnapshot: entry.review.snapshot,
    })));
  }
  async function browsableItems(source) {
    const extra = await discoveredItems();
    if (!source) return applyCorrections(extra);
    const confirmed = await confirmedItems(source);
    let items;
    try { items = await readCatalog(source); }
    catch (error) { if (!(error instanceof Problem)) throw error; items = []; }
    return applyCorrections([...mergeManual(items, confirmed), ...extra]);
  }
  async function preferredProvider() {
    return (await readSaved('model-preferences.json'))?.provider ?? 'gemini';
  }
  return createServer(async (req, res) => {
    let methodLocked = false;
    const lockModel = () => {
      if (importing) throw new Problem('目前正在處理另一項工作，請稍後重試。', 409);
      importing = methodLocked = true;
    };
    const respond = (status, body) => res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' https://tw.hicdn.beanfun.com; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    }).end(body);
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? '')) {
        throw new Problem('請使用本機網站網址。', 403);
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/image-actions.js') {
        return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end(imageActions);
      }
      if (req.method === 'POST' && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        throw new Problem('請從本機網站操作。', 403);
      }
      if (req.method === 'GET' && url.pathname === '/tracking') {
        const registry = await discoveryRegistry();
        const items = await browsableItems(await readSaved('activity-source.json') ?? await readSaved());
        const sources = sourceTracking(items, registry.entries, now());
        const names = new Map(Object.values(registry.entries).map(entry => [entry.url, entry.title]));
        const details = [...sources].map(([source, activities]) => {
          const tracking = activities.some(item => item.track);
          return '<details><summary>' + (tracking ? '持續追蹤' : '已停止自動追蹤') + ' · ' +
            escape(names.get(source) ?? (source === official ? '公告 19129' : source)) + '</summary><ul>' +
            activities.map(item => '<li><a href="/activities/' + item.id + '">' + escape(item.title) + '</a> · ' +
              escape(item.reason) + '</li>').join('') + '</ul><form method="post" action="/discover/import">' +
            '<input type="hidden" name="url" value="' + escape(source) + '"><button>手動重新取得來源</button></form></details>';
        }).join('');
        return respond(200, page('活動來源追蹤', '<nav><a href="/discover">← 公告探索</a></nav><h1>活動來源追蹤</h1>' +
          (details || '<p>確認活動後即可查看來源追蹤狀態。</p>')));
      }
      if (url.pathname === '/discover' || url.pathname === '/discover/import' ||
          /^\/discover\/[a-f0-9]{24}(?:\/source)?$/.test(url.pathname)) {
        const registry = await discoveryRegistry();
        const base = await readSaved('activity-source.json') ?? await readSaved();
        const clock = now();
        const window = discoveryWindow(clock);
        const [, , key, subpage] = url.pathname.split('/');
        if (req.method === 'GET' && !key) return respond(200, discoveryPage(window, registry));
        if (req.method === 'POST') lockModel();
        if (req.method === 'POST' && (!key || key === 'import')) {
          let items = await browsableItems(base);
          const importOne = async candidate => {
            const id = fingerprint(candidate.url).slice(0, 24);
            const entry = await saveAnnouncement(candidate, items, fetchAnnouncement, save, registry.entries[id], clock);
            if (!entry) return false;
            if (entry.existing) {
              try {
                catalogFromSnapshot(await readFile(join(dir, entry.snapshot), 'utf8'));
                await save('activity-source.json', JSON.stringify({ snapshot: entry.snapshot, checkedAt: clock.toISOString() }));
                entry.active = !base || items.some(item => item.id.startsWith('beanfun-19129-'));
              } catch (error) {
                if (!(error instanceof Problem)) throw error;
              }
            }
            registry.entries[id] = entry;
            return true;
          };
          if (key === 'import') {
            const candidate = { url: announcementUrl((await formData(req)).get('url')?.trim() ?? '') };
            let saved;
            try { saved = await importOne(candidate); }
            catch (error) { return respond(502, discoveryPage(window, registry, '正文取得失敗 · ' + error.message)); }
            if (!saved) return respond(200, discoveryPage(window, registry, '這份公告未找到可對應已收錄活動的異動。'));
            await save('discovery.json', JSON.stringify(registry));
            return res.writeHead(303, { Location: '/discover/' + fingerprint(candidate.url).slice(0, 24) }).end();
          }
          const { candidates, ...run } = await collectAnnouncements(openAnnouncementPages, clock);
          const tracking = sourceTracking(items, registry.entries, clock);
          const existing = new Map(Object.values(registry.entries).map(entry => [entry.url, entry]));
          const selected = new Map(candidates.filter(candidate =>
            !tracking.has(candidate.url) || tracking.get(candidate.url).some(item => item.track)).map(candidate => [candidate.url, candidate]));
          for (const [url, activities] of tracking) {
            if (activities.some(item => item.track) && !selected.has(url)) selected.set(url, existing.get(url) ?? { url });
          }
          const work = [...selected.values()];
          const failures = [];
          let saved = 0;
          const scan = async group => {
            for (let index = 0; index < group.length; index += 4) await Promise.all(group.slice(index, index + 4).map(async candidate => {
              try { if (await importOne(candidate)) saved++; }
              catch (error) { failures.push({ ...candidate, error: error.message }); }
            }));
          };
          await scan(work.filter(candidate => candidate.kind === 'version' || candidate.url === official));
          if (!base) items = await browsableItems(await readSaved('activity-source.json'));
          await scan(work.filter(candidate => candidate.kind !== 'version' && candidate.url !== official));
          registry.run = { ...run, at: clock.toISOString(), candidates: candidates.length, saved, failures };
          await save('discovery.json', JSON.stringify(registry));
          return res.writeHead(303, { Location: '/discover' }).end();
        }
        const entry = registry.entries[key];
        if (!entry) throw new Problem('找不到已保存的公告。', 404);
        const html = await readFile(join(dir, entry.snapshot), 'utf8');
        if (req.method === 'GET' && subpage === 'source') {
          return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="announcement-source.txt"', 'X-Content-Type-Options': 'nosniff' }).end(html);
        }
        if (entry.kind !== 'version' || entry.active) {
          if (req.method !== 'GET') throw new Problem('請從對應活動核對這份公告。', 405);
          const evidence = entry.matches.map(block => '<article><pre>' + escape(block.text) + '</pre>' +
            block.activities.map(({ id, title, name }) => '<a href="/activities/' + id + '">' + escape(title ?? name) + '</a> ').join('') + '</article>').join('');
          return respond(200, page(entry.title, '<nav><a href="/discover">← 回公告探索</a></nav><h1>' + escape(entry.title) + '</h1>' +
            '<p><a href="' + escape(entry.url) + '">官方公告 ↗</a> · <a href="/discover/' + entry.id +
            '/source" download>下載已保存來源</a></p>' + (entry.active ? '<p><a href="/activities">查看活動</a> · <a href="/review">核對拆分</a></p>' :
            '<p>來源已保存。期限更正可從<a href="/corrections">來源關聯與更正</a>核對。</p>') + evidence));
        }
        const document = reviewDocument(html);
        const review = entry.review;
        const entries = review?.fingerprint === document.fingerprint ? review.entries : [];
        const active = mergeManual([], entries);
        if (req.method === 'GET') return respond(200, reviewPage(document, active, review,
          entries.length ? '已確認的活動可從活動筆記整理摘要。' : '來源已保存，公告版型待確認。請選取活動與方法內容。',
          '/discover/' + entry.id, entry.url));
        if (req.method !== 'POST' || subpage) throw new Problem('操作不支援。', 405);
        const item = manualActivity(document, await formData(req), active, entry);
        entry.review = { snapshot: entry.snapshot, fingerprint: document.fingerprint,
          entries: [...entries.filter(old => old.methods[0].id !== item.methods[0].id), item] };
        await save('discovery.json', JSON.stringify(registry));
        return res.writeHead(303, { Location: '/activities/' + item.id + '#' + item.methods[0].id }).end();
      }
      if (url.pathname === '/updates') {
        const source = await readSaved('activity-source.json') ?? await readSaved();
        if (req.method === 'POST') {
          if (importing) throw new Problem('公告正在處理中。', 409);
          importing = methodLocked = true;
          const html = await fetchSource();
          if (!html.trim()) throw new Problem('官網回傳空白公告。');
          const checkedAt = now().toISOString();
          const previous = source ? await readFile(join(dir, source.snapshot), 'utf8') : null;
          const snapshot = previous === html ? source.snapshot : '19129-' + checkedAt.replace(/[:.]/g, '-') + '-' + fingerprint(html).slice(0, 12) + '.html';
          if (previous !== html) await save(snapshot, html);
          await save('activity-source.json', JSON.stringify({ snapshot, checkedAt }));
          const records = await readSaved('official-images.json') ?? {};
          const changed = [];
          const failed = [];
          for (const [key, record] of Object.entries(records)) {
            if (!record.version || !html.includes(record.url)) continue;
            try {
              const image = await downloadImage(record.url);
              if (image.version === record.version) continue;
              await save('image-' + image.version, image.bytes);
              records[key] = { url: record.url, version: image.version, mime: image.mime, selected: record.selected,
                verifiedText: record.verifiedText };
              changed.push(key);
            } catch (error) { if (!(error instanceof Problem)) throw error; failed.push(key); }
          }
          if (changed.length) await save('official-images.json', JSON.stringify(records));
          await save('source-update.json', JSON.stringify({ changed: previous !== html, images: changed.length, failed: failed.length }));
          return res.writeHead(303, { Location: '/updates' }).end();
        }
        if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
        const latest = await readSaved('source-update.json');
        const records = await readSaved('official-images.json') ?? {};
        const provider = (await readSaved('model-preferences.json'))?.provider ?? 'gemini';
        const pendingBatch = await readSaved('pending-codex-batch.json');
        const savedMethods = (await readSaved('activity-methods.json'))?.methods ?? {};
        let body = '';
        if (source) {
          try {
            const items = await applyCorrections(mergeManual(await readCatalog(source), await confirmedItems(source)));
            body = items.flatMap(item => item.methods.filter(target => target.kind === 'method').map(target => {
              const previous = savedMethods[target.id];
              const state = !previous ? '尚未整理' : previous.inputKey === methodFingerprint(item, target, records,
                provider, provider === 'codex' ? CODEX_MODEL : process.env.GEMINI_MODEL) ? '摘要已是最新' : '摘要待重整 · 舊摘要仍可讀';
              return '<li><a href="/activities/' + item.id + '#' + target.id + '">' + escape(item.title + ' › ' + target.title) +
                '</a> · ' + state + (previous?.at ? ' · 摘要完成 ' + escape(formatTimestamp(previous.at)) : '') +
                (state === '摘要已是最新' ? '' : '<form method="post" action="/activities/' + item.id + '/' + target.id + '"><button>整理這個方法</button></form>') + '</li>';
            })).join('');
          } catch (error) { if (!(error instanceof Problem)) throw error; body = '<li>' + escape(error.message) + ' <a href="/review">檢視拆分</a></li>'; }
        }
        return respond(200, page('來源與摘要更新', '<nav><a href="/">← 首頁</a></nav><h1>來源與摘要更新</h1>' +
          '<p>來源取得 ' + escape(formatTimestamp(source?.checkedAt ?? source?.capturedAt)) + '</p>' +
          (latest ? '<p>' + (latest.changed ? '來源已更新' : '公告文字未變') + ' · 已變更圖片 ' + latest.images +
            ' 張 · 無法查驗圖片 ' + latest.failed + ' 張</p>' : '') +
          '<form method="post"><button>重新取得官方來源</button></form>' +
          '<form method="post" action="/model-preferences"><label>摘要預設模型 <select name="provider">' +
          '<option value="gemini"' + (provider === 'gemini' ? ' selected' : '') + '>Gemini</option>' +
          '<option value="codex"' + (provider === 'codex' ? ' selected' : '') + '>訂閱 Codex</option></select></label> ' +
          '<button>保存長期預設</button></form>' +
          (pendingBatch?.ids.length ? '<form method="post" action="/activities/' + pendingBatch.activity + '/batch"><p>' +
            escape(pendingBatch.message) + '</p>' + pendingBatch.ids.map(id =>
            '<input type="hidden" name="method" value="' + escape(id) + '">').join('') +
            '<button>重試上次未完成的 Codex 批次</button></form>' : '') + '<ul>' + body + '</ul>'));
      }
      if (req.method === 'POST' && url.pathname === '/model-preferences') {
        if (importing) throw new Problem('公告正在處理中。', 409);
        importing = methodLocked = true;
        const provider = (await formData(req)).get('provider');
        if (!['gemini', 'codex'].includes(provider)) throw new Problem('請選擇可用的模型。');
        await save('model-preferences.json', JSON.stringify({ provider }));
        return res.writeHead(303, { Location: '/updates' }).end();
      }
      if (req.method === 'GET' && /^\/corrections\/official-[a-f0-9]{64}\.html$/.test(url.pathname)) {
        const name = url.pathname.split('/').at(-1);
        const records = await readSaved('source-corrections.json') ?? {};
        if (!Object.values(records).flat().some(record => record.snapshot === name)) throw new Problem('找不到已保存的來源。', 404);
        return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="official-source.txt"', 'X-Content-Type-Options': 'nosniff' })
          .end(await readFile(join(dir, name), 'utf8'));
      }
      if (url.pathname === '/corrections') {
        if (req.method === 'POST') {
          if (importing) throw new Problem('公告正在處理中。', 409);
          importing = methodLocked = true;
        }
        const source = await readSaved('activity-source.json') ?? await readSaved();
        const items = await browsableItems(source);
        if (!items.length) throw new Problem('請先保存並確認公告。', 404);
        const records = await readSaved('source-corrections.json') ?? {};
        if (req.method === 'POST') {
          const form = await formData(req);
          const item = items.find(item => item.id === form.get('activity'));
          if (!item) throw new Problem('請選擇要關聯的活動。');
          const linked = await fetchLinkedSource(officialCorrectionUrl(form.get('url')));
          const record = verifiedSource(item, form, linked, now());
          const candidate = withCorrections(item, [record]);
          if (record.kind === 'correction') {
            const proposed = timeline(candidate)[record.field];
            if (!proposed.change || (/(延長|延期)/.test(record.quote) && proposed.original.end?.date > proposed.end.date)) {
              throw new Problem('新期限與原公告日期或更正用語不符，請核對官方內容。');
            }
          }
          await save(record.snapshot, linked.html);
          records[item.id] = [...(records[item.id] ?? []).filter(entry => entry.id !== record.id), record];
          await save('source-corrections.json', JSON.stringify(records, null, 2));
          return res.writeHead(303, { Location: '/corrections?activity=' + item.id }).end();
        }
        if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
        const selected = items.find(item => item.id === url.searchParams.get('activity'));
        const displayed = selected ? [selected] : items.filter(item => records[item.id]?.length);
        return respond(200, page('來源關聯與更正', '<nav><a href="/">← 首頁</a></nav><h1>來源關聯與更正</h1>' +
          '<form method="post"><p><label>對應活動 <select name="activity">' + items.map(item => '<option value="' + item.id + '"' +
            (item.id === selected?.id ? ' selected' : '') + '>' + escape(item.title) + '</option>').join('') + '</select></label></p>' +
          '<p><label>官方公告網址 <input name="url" type="url" required></label></p>' +
          '<p><label>來源用途 <select name="kind"><option value="supplement">補充／差異待確認</option>' +
          '<option value="correction">明確官方更正</option></select></label> <label>欄位 <select name="field">' +
          '<option value="participation">參加期限</option><option value="claim">領獎期限</option></select></label></p>' +
          '<p><label>原文依據 <textarea name="quote" required maxlength="1500"></textarea></label></p>' +
          '<p><label>新截止（明確更正才填） <input name="end" placeholder="YYYY/MM/DD HH:mm"></label></p><button>核對並保存來源</button></form>' +
          displayed.map(item => '<article><h2><a href="/activities/' + item.id + '">' + escape(item.title) + '</a></h2>' +
            '<p>原公告 · ' + escape(periodText(timeline(item).participation)) + ' · 領獎 ' + escape(periodText(timeline(item).claim)) + '</p>' +
            (records[item.id] ?? []).map(record => '<details><summary>' + (record.kind === 'correction' ? '官方更正' : '補充／差異待確認') +
              ' · ' + (record.field === 'claim' ? '領獎期限' : '參加期限') + ' ' + escape(record.endText ?? '') + '</summary><pre>' +
              escape(record.quote) + '</pre><a href="' + escape(record.url) + '" target="_blank" rel="noopener noreferrer">查看來源 ↗</a> · ' +
              '<a href="/corrections/' + record.snapshot + '" download>下載已保存來源</a></details>').join('') +
            '</article>').join('')));
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
          await save('activity-source.json', JSON.stringify({ snapshot, checkedAt: capturedAt }));
          const notice = extract(html);
          const previous = await readSaved();
          if (previous?.model?.model && fingerprint(previous.notice) === fingerprint(notice) && previous.model.model === process.env.GEMINI_MODEL) {
            await save('status.json', JSON.stringify('公告內容未變，沿用已保存摘要。'));
            return respond(200, home(previous, '核心寶石', now()));
          }
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
      const agentSearch = req.method === 'POST' && url.pathname === '/assist/search';
      if ((req.method === 'GET' && url.pathname === '/') || agentSearch) {
        const saved = await readSaved();
        const source = await readSaved('activity-source.json') ?? saved;
        const params = agentSearch ? await formData(req) : url.searchParams;
        const query = params.get('q')?.trim() ?? '';
        const items = await browsableItems(source);
        const listing = items.length ? {
          items, images: await readSaved('official-images.json') ?? {}, snapshot: source?.snapshot,
          filters: {
            query,
            status: statuses.includes(params.get('state')) ? params.get('state') : '',
            type: rewardTypes.includes(params.get('type')) ? params.get('type') : '',
          },
        } : undefined;
        let assist;
        let status = 200;
        if (agentSearch) {
          try {
            if (!query || query.length > 200) throw new Problem('請輸入 1–200 字的搜尋句。');
            const candidates = listing ? searchCatalog(items, { ...listing.filters, query: '' }, now(), listing.images,
              { includeMethods: true }) : [];
            lockModel();
            assist = await searchWithAgent(query, candidates, playerAssistant(await preferredProvider(), codexGenerate, generatePlayerAssistance));
          } catch (error) {
            if (!(error instanceof Problem)) throw error;
            assist = { error: error.message };
            status = error.status;
          }
        }
        return respond(status, home(saved, query, now(), await readSaved('status.json'), Boolean(source), listing, assist));
      }
      if (url.pathname === '/compare' && ['GET', 'POST'].includes(req.method)) {
        const source = await readSaved('activity-source.json') ?? await readSaved();
        const items = await browsableItems(source);
        const params = req.method === 'POST' ? await formData(req) : url.searchParams;
        const from = items.find(item => item.id === params.get('activity'));
        const methods = activityMethods(from ? [from, ...items.filter(item => item !== from)] : items);
        const ids = params.getAll('method');
        if (req.method === 'GET') return respond(200, comparisonPage(methods, from));
        try {
          const selections = ids.map(id => methods.find(entry => entry.method.id === id));
          if (selections.length !== 2 || selections.some(entry => !entry) || ids[0] === ids[1]) {
            throw new Problem('請選擇兩種不同的取得方式。');
          }
          lockModel();
          const result = await compareMethods(selections, playerAssistant(await preferredProvider(), codexGenerate, generatePlayerAssistance));
          return respond(200, comparisonPage(methods, from, ids, result));
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          return respond(error.status, comparisonPage(methods, from, ids, undefined, error.message));
        }
      }
      if (req.method === 'GET' && /^\/images\/[a-f0-9]{24}$/.test(url.pathname)) {
        const key = url.pathname.split('/').at(-1);
        const record = (await readSaved('official-images.json'))?.[key];
        if (!record?.version) throw new Problem('找不到已保存的圖片。', 404);
        if (url.searchParams.has('v') && url.searchParams.get('v') !== record.version) {
          throw new Problem('這張圖片的版本已更新。', 404);
        }
        const bytes = await readFile(join(dir, 'image-' + record.version));
        return res.writeHead(200, { 'Content-Type': record.mime, 'X-Content-Type-Options': 'nosniff' }).end(bytes);
      }
      if (url.pathname === '/review' || url.pathname === '/review/source') {
        if (req.method === 'POST') {
          if (importing) throw new Problem('公告正在處理中。', 409);
          importing = methodLocked = true;
        }
        const source = await readSaved('activity-source.json') ?? await readSaved();
        if (!source) throw new Problem('請先匯入公告 19129。', 404);
        const html = await readFile(join(dir, source.snapshot), 'utf8');
        if (req.method === 'GET' && url.pathname === '/review/source') {
          return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="19129-source.txt"', 'X-Content-Type-Options': 'nosniff' }).end(html);
        }
        const document = reviewDocument(html);
        const previous = await readSaved('manual-split.json');
        let automatic = [];
        let message = '已辨識公告模板。可調整方法的原文歸屬；摘要欄位請在活動頁檢視。';
        try { automatic = catalogFromSnapshot(html); }
        catch (error) {
          if (!(error instanceof Problem)) throw error;
          message = error.message;
        }
        const active = mergeManual(automatic, previous?.fingerprint === document.fingerprint ? previous.entries : []);
        if (req.method === 'GET') return respond(200, reviewPage(document, active, previous, message));
        if (req.method !== 'POST' || url.pathname !== '/review') throw new Problem('操作不支援。', 405);
        const item = manualActivity(document, await formData(req), active);
        const original = previous?.entries.find(entry => entry.methods[0].id === item.methods[0].id);
        if (original?.fromActivityId) item.fromActivityId = original.fromActivityId;
        const entries = previous?.fingerprint === document.fingerprint ? previous.entries : [];
        const next = { fingerprint: document.fingerprint, snapshot: source.snapshot,
          entries: [...entries.filter(entry => entry.methods[0].id !== item.methods[0].id), item] };
        const summaries = await readSaved('activity-methods.json');
        if (summaries?.snapshot === source.snapshot && summaries.methods[item.methods[0].id]) {
          delete summaries.methods[item.methods[0].id];
          await save('activity-methods.json', JSON.stringify(summaries, null, 2));
        }
        if (previous && previous.fingerprint !== document.fingerprint) {
          await save('manual-split-' + previous.fingerprint + '.json', JSON.stringify(previous, null, 2));
        }
        await save('manual-split.json', JSON.stringify(next, null, 2));
        return res.writeHead(303, { Location: '/activities/' + item.id + '#' + item.methods[0].id }).end();
      }
      if (url.pathname === '/activities' || url.pathname.startsWith('/activities/')) {
        if (req.method === 'POST') {
          if (importing) throw new Problem('公告正在整理中。', 409);
          importing = methodLocked = true;
        }
        const saved = await readSaved('activity-source.json') ?? await readSaved();
        const extraItems = await discoveredItems();
        if (!saved && !extraItems.length) throw new Problem('請先從公告探索保存並確認來源。', 404);
        let items;
        let previousCatalog;
        let pending = '';
        const confirmed = saved ? await confirmedItems(saved) : [];
        try { items = saved ? await readCatalog(saved) : []; }
        catch (error) {
          if (!(error instanceof Problem)) throw error;
          const old = await readSaved('activity-catalog.json');
          previousCatalog = old?.snapshot !== saved.snapshot ? old : null;
          pending = previousCatalog?.items?.length
            ? '新來源拆分待確認，仍可查看上次成功的活動。' : '來源拆分待確認，只列出已人工確認的活動。';
          if (!confirmed.length && !extraItems.length && !(req.method === 'GET' && previousCatalog?.items?.length)) {
            return respond(422, page('拆分待確認', '<h1>拆分待確認</h1><p>' + escape(error.message) +
              '</p><p><a href="/review">檢視來源並調整拆分</a></p>'));
          }
          items = [];
        }
        items = await applyCorrections([...mergeManual(items, confirmed), ...extraItems]);
        if (req.method === 'GET' && url.pathname === '/activities') {
          const listed = [...items, ...(previousCatalog?.items ?? []).filter(old => !items.some(item => item.id === old.id))];
          return respond(200, activityList(listed, url.searchParams.get('q')?.trim() ?? '', now(), pending));
        }
        const [, , activityId, methodId, extra, rest] = url.pathname.split('/');
        const item = items.find(item => item.id === activityId);
        const imageRecords = await readSaved('official-images.json') ?? {};
        if (!item && req.method === 'GET' && !methodId) {
          const old = previousCatalog?.items.find(entry => entry.id === activityId);
          if (old) {
            const methods = await readSaved('activity-methods.json');
            return respond(200, activityDetail(old, now(), methods?.snapshot === previousCatalog.snapshot ? methods.methods : {},
              '新來源拆分待確認，目前顯示上次成功的活動。', imageRecords));
          }
        }
        if (req.method === 'POST' && item && methodId === 'images' && extra && !rest) {
          const imageUrl = item.images.find(url => imageKey(url) === extra);
          if (!imageUrl) throw new Problem('這張圖不屬於指定活動。', 404);
          const form = await formData(req, 180_000);
          const action = form.get('action');
          const old = imageRecords[extra];
          const shop = item.shopImages?.includes(imageUrl);
          const editsText = action === 'verify-text' || action === 'remove-text';
          if (!['download', 'select', 'remove', 'recognize', 'confirm'].includes(action) && !editsText) {
            throw new Problem('圖片操作不支援。');
          }
          if (shop && (editsText || ['recognize', 'confirm'].includes(action))) {
            throw new Problem('這張圖片使用原圖規則。');
          }
          if (editsText && (!old?.version || old.version !== form.get('imageVersion'))) {
            throw new Problem('原圖版本已變更，請重新開啟圖片並核對。', 409);
          }
          const record = { ...old, url: imageUrl, selected: old?.selected ?? Boolean(shop) };
          if (action !== 'remove' && (!record.version || action === 'download')) {
            const { bytes, mime, version } = await downloadImage(imageUrl);
            if (version !== record.version) {
              delete record.recognition;
              delete record.appearance;
            }
            await save('image-' + version, bytes);
            Object.assign(record, { mime, version });
          }
          if (action === 'select' || action === 'remove') record.selected = action === 'select';
          if (action === 'confirm') {
            const appearance = form.get('appearance')?.trim() ?? '';
            if (appearance.length > 100) throw new Problem('獎勵名稱過長。');
            record.appearance = appearance;
          }
          if (editsText) {
            record.verifiedText = { ...record.verifiedText };
            if (action === 'verify-text') {
              const text = form.get('imageText')?.trim() ?? '';
              if (!text || text.length > 16000) throw new Problem('請輸入 1–16000 字的已核對內容。');
              record.verifiedText[item.id] = { text, version: record.version };
            } else delete record.verifiedText[item.id];
          }
          imageRecords[extra] = record;
          await save('official-images.json', JSON.stringify(imageRecords, null, 2));
          if (action === 'recognize') {
            record.recognition = await summarizeImage({ bytes: await readFile(join(dir, 'image-' + record.version)), mime: record.mime });
            await save('official-images.json', JSON.stringify(imageRecords, null, 2));
          }
          const methods = await readSaved('activity-methods.json');
          const status = action === 'verify-text' ? '已將核對文字加入活動筆記。' :
            action === 'remove-text' ? '已從活動筆記移除核對文字。' : '已更新官方圖片。';
          return respond(200, activityDetail(item, now(), methods?.methods ?? {}, status, imageRecords, await preferredProvider())
            .replace('<details id="image-library">', '<details id="image-library" open>'));
        }
        if (!item || extra !== undefined) throw new Problem('找不到活動。', 404);
        const savedMethods = await readSaved('activity-methods.json');
        const summaries = savedMethods?.methods ?? {};
        const preferred = await preferredProvider();
        if (req.method === 'GET' && !methodId) return respond(200, activityDetail(item, now(), summaries, pending, imageRecords, preferred));
        if (req.method === 'POST' && methodId === 'ask') {
          const question = (await formData(req)).get('question')?.trim() ?? '';
          let status = 200;
          let content;
          try {
            if (!question || question.length > 500) throw new Problem('請輸入 1–500 字的問題。');
            const result = await answerPlayer(item, question,
              playerAssistant(preferred, codexGenerate, generatePlayerAssistance), verifiedImageSources(item, imageRecords));
            content = '<h2>回答</h2>' + (result.facts.length ? assistantFacts(result.facts) : '<p>已收錄的公告沒有足夠資料回答。</p>') +
              (result.incomplete && result.facts.length ? '<p>部分條件仍需核對官方公告。</p>' : '') +
              assistantModel(result.metadata) + assistantEvidence(result.facts);
          } catch (error) {
            if (!(error instanceof Problem)) throw error;
            status = error.status;
            content = '<p role="alert">' + escape(error.message) + '</p>';
          }
          return respond(status, page('問這個活動', activityNav('/activities/' + item.id, '← 回到活動', item.title, item.officialUrl) +
            '<h1>問這個活動</h1><p>' + escape(item.title) + '</p>' + questionForm(item, question) + content));
        }
        const target = item.methods.find(method => method.id === methodId && method.kind === 'method');
        if (req.method === 'POST' && (target || methodId === 'batch')) {
          const batch = methodId === 'batch';
          const provider = batch ? 'codex' : preferred;
          const ids = batch ? [...new Set((await formData(req)).getAll('method'))] : [target.id];
          const targets = item.methods.filter(entry => entry.kind === 'method' && ids.includes(entry.id));
          if (!targets.length || targets.length !== ids.length) throw new Problem('請選擇本活動的取得方法。');
          const remaining = new Set(ids);
          try {
            for (const target of targets) {
              const inputKey = methodFingerprint(item, target, imageRecords, provider, provider === 'codex' ? CODEX_MODEL : process.env.GEMINI_MODEL);
              if (summaries[target.id]?.inputKey === inputKey) { remaining.delete(target.id); continue; }
              const sources = methodContext(item, target);
              const input = { title: item.title, method: target.title, sources };
              const generated = provider === 'codex' ? await summarizeMethod(input, async (instruction, input, properties) => {
                const parts = [{ text: JSON.stringify(input) }];
                for (const imageUrl of new Set([...target.images, ...(item.sharedImages ?? [])])) {
                  const record = imageRecords[imageKey(imageUrl)];
                  if (!record?.selected || !record.version || item.shopImages?.includes(imageUrl)) continue;
                  const bytes = await readFile(join(dir, 'image-' + record.version));
                  parts.push({ inlineData: { mimeType: record.mime, data: bytes.toString('base64') } });
                }
                const output = await codexGenerate({ parts, instruction,
                  schema: { type: 'object', properties, required: Object.keys(properties) } });
                return { result: output.result, metadata: { model: output.model, usage: output.usage, provider } };
              }) : await summarizeActivityMethod(input);
              const known = methodFacts(item, target);
              const facts = validateMethod(generated.result, sources, {
                eligibility: item.eligibility ? [item.eligibility.id] : [],
                steps: known.steps ? [known.steps.id] : [],
                rewards: known.rewards.map(source => source.id),
              });
              summaries[target.id] = { facts, references: sourceReferences(sources), inputKey, model: generated.metadata, at: now().toISOString() };
              await save('activity-methods.json', JSON.stringify({ snapshot: saved?.snapshot ?? item.discoverySnapshot, methods: summaries }, null, 2));
              remaining.delete(target.id);
            }
          } catch (error) {
            if (batch && error instanceof Problem) {
              await save('pending-codex-batch.json', JSON.stringify({ activity: item.id, ids: [...remaining], message: error.message }));
            }
            throw error;
          }
          if (batch && (await readSaved('pending-codex-batch.json'))?.activity === item.id) await save('pending-codex-batch.json', 'null');
          return res.writeHead(303, { Location: '/activities/' + item.id + '#' + targets[0].id }).end();
        }
      }
      if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
      if (url.pathname === '/note') {
        const saved = await readSaved();
        if (saved) {
          const source = await readSaved('activity-source.json') ?? saved;
          const item = (await browsableItems(source)).find(item => item.title === activity);
          return respond(200, note(saved, now(), url.searchParams.get('q'), item));
        }
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
