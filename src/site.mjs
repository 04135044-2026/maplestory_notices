import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activity, extract, fetchNotice, fields, gemini, method, official, Problem, validate } from './notice.mjs';
import { catalogFromSnapshot, methodContext, methodFacts, methodFields, summarizeMethod, validateMethod } from './catalog.mjs';
import { manualActivity, mergeManual, reviewDocument } from './review.mjs';
import { fetchOfficialImage, imageKey, recognizeImage } from './images.mjs';
import { activityState, periodText, timeline } from './periods.mjs';
import { rewardTypes, searchCatalog, statuses } from './search.mjs';

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
`;
const page = (title, body) => '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title><style>' + style + layout + '</style><main>' + body + '</main></html>';
const imageActions = `
function revealSource(hash) {
  if (!hash) return;
  const target = document.getElementById(hash.slice(1));
  const panel = target?.closest('.source-panel');
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
    if (slot && newSlot) slot.replaceChildren(...newSlot.childNodes);
    card.replaceChildren(...newCard.childNodes);
    if (wasPreviewing && card.querySelector('.image-preview')) card.querySelector('.image-preview').open = true;
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

function catalogResults(items, filters, now, images, saved) {
  const entries = searchCatalog(items, filters, now, images);
  if (!entries.length) return '<p>在已收錄的公告 19129 活動及獎勵中找不到符合的結果。</p>';
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
      '<p>來源 · ' + escape(item.pageTitle) + '（19129）</p>' +
      (image ? '<img loading="lazy" style="max-width:160px" src="/images/' + image + '" alt="' + escape(reward.name) + '">' :
        reward ? '<p>尚無外觀圖片</p>' : '') +
      '<p><a href="' + href + '">' + (reward ? '查看取得方式 →' : '查看活動 →') + '</a></p></article>';
  });
}

function home(saved, query, now, status, hasSnapshot = Boolean(saved), listing) {
  return page('新楓之谷公告懶人包', '<h1>新楓之谷公告懶人包</h1><form method="get"><label for="q">搜尋獎勵或活動</label> <input id="q" name="q" value="' +
    escape(query) + '"> ' + (listing ? filterOptions('state', statuses, listing.filters.status, '活動狀態') + ' ' +
      filterOptions('type', rewardTypes, listing.filters.type, '獎勵類型') + ' ' : '') +
    '<button>搜尋</button></form>' + (listing ? catalogResults(listing.items, listing.filters, now, listing.images,
      listing.snapshot === saved?.snapshot ? saved : null) : searchResults(saved, query, now)) +
    (hasSnapshot ? '<p><a href="/activities">查看公告 19129 的全部活動</a></p>' : '') +
    '<details' + (status ? ' open' : '') + '><summary>公告管理</summary>' +
    (status ? '<p>' + escape(status) + '</p>' : '') +
    (saved?.capturedAt ? '<p>已保存摘要：' + escape(new Date(saved.capturedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })) + '（台灣時間）</p>' : '') +
    (hasSnapshot ? '<p><a href="/review">檢視與調整公告拆分</a></p>' : '') +
    '<form method="post" action="/import"><button>匯入並整理公告 19129</button></form></details>');
}

function reviewPage(document, automatic, previous, message) {
  const options = automatic.flatMap(item => item.methods.filter(method => method.kind === 'method')
    .map(method => '<option value="' + method.id + '">' + escape(item.title + ' › ' + method.title) + '</option>')).join('');
  return page('檢視公告拆分', '<nav><a href="/">← 首頁</a> · <a href="/activities">查看活動</a></nav><h1>檢視公告拆分</h1>' +
    '<p>' + escape(message) + '</p>' +
    (previous && previous.fingerprint !== document.fingerprint ? '<p role="status">來源已變更，舊人工歸屬需重新核對。</p>' : '') +
    '<p><a href="/review/source" download>下載完整來源快照</a></p>' +
    (previous ? '<p>已保存人工確認：' + previous.entries.map(entry => escape(entry.title + ' › ' + entry.methods[0].title)).join('、') + '</p>' : '') +
    '<form method="post"><input type="hidden" name="fingerprint" value="' + document.fingerprint + '">' +
    '<p><label>要調整的方法 <select name="target"><option value="">新增活動或方法</option>' + options + '</select></label></p>' +
    '<p><label>方法所屬活動 <select name="parent"><option value="">保留目前歸屬，或新增活動</option>' +
    automatic.map(item => '<option value="' + item.id + '">' + escape(item.title) + '</option>').join('') + '</select></label></p>' +
    '<p><label>新活動名稱（新增活動才填） <input name="title" maxlength="100"></label></p><p><label>方法名稱 <input name="method" required maxlength="100"></label></p>' +
    document.blocks.map(block => '<article><strong>' + block.id + '</strong><pre>' + escape(block.text) + '</pre>' +
      block.images.map((url, index) => '<p><a href="' + escape(url) + '">官方圖片 ' + (index + 1) + '</a></p>').join('') +
      '<label><input type="checkbox" name="own" value="' + block.id + '">方法內容</label> ' +
      '<label><input type="checkbox" name="shared" value="' + block.id + '">適用共用條件</label></article>').join('') +
    '<button>確認並保存拆分</button></form>');
}

async function formData(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Problem('表單內容過大。', 413);
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

function activityDetail(item, now, summaries = {}, status = '', imageRecords = {}) {
  const periods = timeline(item);
  const showPeriod = (label, period) => '<dt>' + label + '</dt><dd>' + escape(periodText(period)) +
    (period.source ? ' <a href="#' + period.source.id + '">查看依據</a>' : '') + '</dd>';
  const cite = source => source ? escape(source.text) + ' <a href="#' + source.id + '">查看依據</a>' : '未載明／待確認';
  const facts = (label, sources, allowedImages = []) => '<dt>' + label + '</dt>' +
    (sources.length ? sources.map(source => '<dd>' + cite(source) +
      imagesFor((source.images ?? []).filter(url => allowedImages.includes(url))) + '</dd>').join('') : '<dd>未載明／待確認</dd>');
  const placed = new Set();
  const linkedImages = new Set();
  const imageSource = (url, source) => {
    if (linkedImages.has(url)) return '';
    linkedImages.add(url);
    const key = imageKey(url);
    const text = source?.text.split('\n')[0].replace(/^🎸\s*/u, '').trim() || item.title;
    const fragment = encodeURIComponent(text.slice(0, 85)).replaceAll('-', '%2D');
    return '<div id="source-image-' + key + '"><details class="image-preview"><summary>預覽對應原圖</summary>' +
      '<img loading="lazy" src="' + (imageRecords[key]?.version ? '/images/' + key : escape(url)) + '" alt="對應的官方原圖"></details>' +
      '<p><a href="' + official + '#:~:text=' + fragment + '" target="_blank" rel="noopener noreferrer">到官方公告查看圖片附近原文 ↗</a></p></div>';
  };
  const imagesFor = urls => urls.filter(url => !placed.has(url)).map(url => {
    placed.add(url);
    const key = imageKey(url);
    const record = imageRecords[key];
    const figure = !(record?.selected ?? item.shopImages?.includes(url)) ? '' : '<figure><img loading="lazy" style="max-width:100%" src="' +
      (record?.version ? '/images/' + key : escape(url)) + '" alt="' + escape(record?.appearance || '官方原圖') + '">' +
      '<figcaption>' + escape(record?.appearance || '官方原圖 · 物品對應待確認') +
      ' · <a href="#source-image-' + key + '">查看圖片的公告位置</a></figcaption></figure>';
    return '<div id="slot-image-' + key + '">' + figure + '</div>';
  }).join('');
  const sections = item.methods.map(method => {
    if (method.kind === 'reference') return '<details><summary>補充說明 · ' + escape(method.title) +
      '</summary>' + methodContext(item, method).filter(source => method.sourceIds.includes(source.id))
        .map(source => '<p>' + cite(source) + '</p>').join('') + '</details>';
    const { steps, rewards, costs, chances, limits } = methodFacts(item, method);
    const rewardLabel = chances.some(source => source.text.includes('可能獲得')) ? '可能獎勵' : '獎勵';
    const shortRewards = rewards.filter(source => !source.text.includes('\n'));
    const ownImages = method.images.filter(url => !item.sharedImages?.includes(url) || method.sourceIds.length === 0);
    const methodPeriods = timeline(item, method);
    const ownPeriods = [
      ['參加期間', 'participation'], ['開領時間', 'opening'], ['領獎期限', 'claim'],
    ].filter(([, key]) => methodPeriods[key].source?.id !== periods[key].source?.id);
    return '<article id="' + method.id + '"><h2>' + escape(method.title) + '</h2><dl>' +
      (ownPeriods.length ? '<dt>方法狀態</dt><dd>' + activityState(methodPeriods, now) + '</dd>' : '') +
      ownPeriods.map(([label, key]) => showPeriod(label, methodPeriods[key])).join('') +
      (methodPeriods.resets.length ? facts('重置規則', methodPeriods.resets) : '') +
      facts('第一步', steps ? [steps] : [], ownImages) + facts(rewardLabel, shortRewards, ownImages) + facts('重要限制', limits, ownImages) +
      facts('成本及付費條件', costs) +
      facts('機率', chances.filter(source => /機率/.test(source.text))) +
      '</dl>' + imagesFor(ownImages) + '<details><summary>Gemini 整理</summary>' +
      (summaries[method.id] ? '<dl>' + Object.entries(methodFields).map(([key, label]) =>
        facts(label, summaries[method.id].facts[key].map(fact => ({ text: fact.text, id: fact.source })))).join('') + '</dl>' : '<p>尚未整理這個方法。</p>') +
      '<form method="post" action="/activities/' + item.id + '/' + method.id + '"><button>用 Gemini 整理這個方法</button></form></details>' +
      '<details><summary>查看方法原文及表格</summary>' +
      methodContext(item, method).filter(source => method.sourceIds.includes(source.id) || item.local.includes(source))
        .map(source => '<pre>' + cite(source) + '</pre>').join('') + '</details></article>';
  }).join('');
  return page(item.title, '<nav><a href="/activities">← 全部活動</a></nav>' + eventLabel(item) + '<h1>' + escape(item.title) + '</h1><p>' +
    activityState(periods, now) + ' · ' + link + '</p>' + (status ? '<p role="status">' + escape(status) + '</p>' : '') +
    '<dl><dt>參加資格</dt><dd>' + cite(item.eligibility) +
    (item.sharedEligibility && item.sharedEligibility.text !== item.eligibility?.text
      ? '</dd><dd>版本共用資格 · ' + cite(item.sharedEligibility) : '') +
    '</dd>' + showPeriod('參加期間', periods.participation) + showPeriod('開領時間', periods.opening) +
    showPeriod('領獎期限', periods.claim) + '</dl>' + sections + imagesFor(item.images) +
    '<details class="source-panel" id="sources"><summary>官方公告段落（' + item.sources.length + '）</summary>' +
    item.sources.map(source => '<article id="' + source.id + '"><small>' +
      escape(source.scope) + '</small><pre>' + escape(source.text) + '</pre>' +
      (source.images ?? []).filter(url => item.images.includes(url)).map(url => imageSource(url, source)).join('') + '</article>').join('') +
    item.images.map(url => imageSource(url)).join('') + '</details>' +
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
        (record?.recognition ? '<details><summary>圖片辨識 · 待人工核對</summary><pre>' + escape(record.recognition.text) + '</pre></details>' : '') +
        '<form method="post" action="/activities/' + item.id + '/images/' + key + '#image-' + key + '">' +
        '<button name="action" value="download">保存／重試原圖</button> ' +
        '<button name="action" value="' + (selected ? 'remove' : 'select') + '">' + (selected ? '移出' : '選入') + '懶人包</button> ' +
        (shop ? '' : '<button name="action" value="recognize">Gemini 辨識這張圖</button>' +
          '<p><label>已核對的單一獎勵名稱 <input name="appearance" maxlength="100" value="' + escape(record?.appearance || '') +
          '"></label> <button name="action" value="confirm">保存外觀對應</button></p>') + '</form></article>';
    }).join('') + '</details><script src="/image-actions.js" defer></script>');
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
  return page(activity, '<nav><a href="/?q=' + encodeURIComponent(query ?? notice.reward) + '">← 回搜尋結果</a></nav>' +
    '<span class="event-label">星夜馬戲團 in 墮落城市</span><h1>' + activity +
    '</h1><p>' + time.status + ' · ' + link + '</p><dl>' + fact('eligibility') + row('參加期間', time.text, notice.date?.id) +
    row('領獎期限', notice.claim ? '請查看公告所列領取條件' : '此活動段落未載明獨立領獎期限',
      notice.claim?.id ?? 'sources') + '</dl><article id="method"><h2>' + method +
    '</h2><dl>' + fact('first') + rewardDetails + fact('steps') + fact('limits') +
    '</dl><a href="#' + notice.table + '">查看應援規則與獎勵表</a></article>' +
    '<details class="source-panel" id="sources"><summary>官方公告段落（' + notice.sources.length + '）</summary>' +
    notice.sources.map(source => '<article id="' + source.id + '"><pre>' + escape(source.text) + '</pre></article>').join('') +
    '</details><script src="/image-actions.js" defer></script>');
}

export function website({ dir = 'data', now = () => new Date(), fetchSource = fetchNotice, summarize = gemini,
  summarizeActivityMethod = summarizeMethod, downloadImage = fetchOfficialImage, summarizeImage = recognizeImage } = {}) {
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
  return createServer(async (req, res) => {
    let methodLocked = false;
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
        const source = await readSaved('activity-source.json') ?? saved;
        const query = url.searchParams.get('q')?.trim() ?? '';
        let listing;
        if (source) {
          const confirmed = await confirmedItems(source);
          let items;
          try { items = await readCatalog(source); }
          catch (error) { if (!(error instanceof Problem)) throw error; items = []; }
          items = mergeManual(items, confirmed);
          if (items.length) listing = {
            items, images: await readSaved('official-images.json') ?? {}, snapshot: source.snapshot,
            filters: {
              query,
              status: statuses.includes(url.searchParams.get('state')) ? url.searchParams.get('state') : '',
              type: rewardTypes.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : '',
            },
          };
        }
        return respond(200, home(saved, query, now(), await readSaved('status.json'), Boolean(source), listing));
      }
      if (req.method === 'GET' && /^\/images\/[a-f0-9]{24}$/.test(url.pathname)) {
        const key = url.pathname.split('/').at(-1);
        const record = (await readSaved('official-images.json'))?.[key];
        if (!record?.version) throw new Problem('找不到已保存的圖片。', 404);
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
        if (!saved) throw new Problem('請先匯入公告 19129。', 404);
        let items;
        let previousCatalog;
        let pending = '';
        const confirmed = await confirmedItems(saved);
        try { items = await readCatalog(saved); }
        catch (error) {
          if (!(error instanceof Problem)) throw error;
          const old = await readSaved('activity-catalog.json');
          previousCatalog = old?.snapshot !== saved.snapshot ? old : null;
          pending = previousCatalog?.items?.length
            ? '新來源拆分待確認，仍可查看上次成功的活動。' : '來源拆分待確認，只列出已人工確認的活動。';
          if (!confirmed.length && !(req.method === 'GET' && previousCatalog?.items?.length)) {
            return respond(422, page('拆分待確認', '<h1>拆分待確認</h1><p>' + escape(error.message) +
              '</p><p><a href="/review">檢視來源並調整拆分</a></p>'));
          }
          items = [];
        }
        items = mergeManual(items, confirmed);
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
          const form = await formData(req);
          const action = form.get('action');
          const old = imageRecords[extra];
          const shop = item.shopImages?.includes(imageUrl);
          if (!['download', 'select', 'remove', 'recognize', 'confirm'].includes(action) || (shop && ['recognize', 'confirm'].includes(action))) {
            throw new Problem('這張圖片使用原圖規則。');
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
          imageRecords[extra] = record;
          await save('official-images.json', JSON.stringify(imageRecords, null, 2));
          if (action === 'recognize') {
            record.recognition = await summarizeImage({ bytes: await readFile(join(dir, 'image-' + record.version)), mime: record.mime });
            await save('official-images.json', JSON.stringify(imageRecords, null, 2));
          }
          const methods = await readSaved('activity-methods.json');
          return respond(200, activityDetail(item, now(), methods?.snapshot === saved.snapshot ? methods.methods : {}, '已更新官方圖片。', imageRecords)
            .replace('<details id="image-library">', '<details id="image-library" open>'));
        }
        if (!item || extra !== undefined) throw new Problem('找不到活動。', 404);
        const savedMethods = await readSaved('activity-methods.json');
        const summaries = savedMethods?.snapshot === saved.snapshot ? savedMethods.methods : {};
        if (req.method === 'GET' && !methodId) return respond(200, activityDetail(item, now(), summaries, pending, imageRecords));
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
