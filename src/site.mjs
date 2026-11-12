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
import { activityState, periodText, timeline, versionPeriod } from './periods.mjs';
import { activityRewards, rewardTypes, searchCatalog, statuses } from './search.mjs';
import { watchKey, watchVersion } from './watch.mjs';
import { editChanged, editEvidence, editKey } from './manual-edits.mjs';
import { calendarActivity, calendarMonth, exportCalendar, exportVersion } from './calendar.mjs';
import { issueIndex } from './known-issues.mjs';
import { answerPlayer, compareMethods, playerAssistant, searchWithAgent } from './player-assist.mjs';
import { announcementUrl, collectAnnouncements, discoveryWindow, officialAnnouncement, officialPages, saveAnnouncement } from './discovery.mjs';
import { sourceTracking } from './tracking.mjs';
import { jobFailure, METHOD_BATCH, SOURCE_BATCH, sourceAttempt } from './jobs.mjs';
import { DEFAULT_SCHEDULE, dueCheck, validSchedule } from './schedule.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const link = '<a href="' + official + '" target="_blank" rel="noopener noreferrer">查看官方公告 ↗</a>';
const style = 'body{margin:0;background:#f6f5ef;color:#252e26;font:17px/1.65 system-ui,sans-serif}main{max-width:48rem;margin:auto;padding:2rem 1rem}h1,h2{line-height:1.25}a{color:#17563d}article,details{background:white;border:1px solid #d9e1d7;padding:1rem;margin:1rem 0;border-radius:12px}input,button{font:inherit;padding:.45rem .65rem}button{cursor:pointer}dt{font-weight:700}dd{margin:0 0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{margin-bottom:1rem}';
const layout = `
main:has(.activity-grid){max-width:72rem}
summary{cursor:pointer;font-weight:700}
.activity-family{--accent:#32664d;border-top:3px solid var(--accent);margin:1.5rem 0 2rem;padding-top:.65rem}
[data-tone="1"]{--accent:#485993}
[data-tone="2"]{--accent:#93532c}
[data-tone="3"]{--accent:#765086}
[data-tone="4"]{--accent:#32646f}
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
.site-tabs{display:flex;flex-wrap:wrap;gap:.4rem;border-bottom:1px solid #cddbd3;padding-bottom:.35rem}
.site-tabs a{padding:.35rem .65rem;border-radius:.35rem;text-decoration:none}
.site-tabs a:hover,.site-tabs a:focus-visible{text-decoration:underline}
.site-tabs a[aria-current=page]{background:#e0ede4;font-weight:700}
.calendar-scroll{overflow-x:auto}
main:has(.calendar-layout){max-width:82rem}
.calendar-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(14rem,22rem);gap:1rem;align-items:start}
.calendar-filters{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-bottom:1rem}
.calendar-grid{min-width:36rem;border:1px solid #cddbd3}
.calendar-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));position:relative}
.calendar-weekday{text-align:center;padding:.35rem;background:#e5ece1}
.calendar-cell{position:relative;grid-row:1/-1;background:#fffdf8;border:1px solid #dce4de}
.calendar-cell-empty{background:#eceee8}
.calendar-day,.calendar-counts{z-index:1;padding:.3rem;min-width:0}
.calendar-day{position:relative;grid-row:1;min-height:1.8rem}
.calendar-day a{text-decoration:none}
.calendar-cell-selected{background:#edf3e9}
.calendar-counts{min-height:2rem}
.calendar-count{display:block;width:fit-content;margin:.15rem 0;padding:.1rem .3rem;border-radius:.3rem;font-size:.75rem;color:#204c63;background:#e1edf3}
.calendar-count-end{background:#f2e7dc;color:#754623}
.calendar-band{z-index:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:.13rem .45rem;margin:.12rem .18rem;border-radius:.45rem;font-size:.78rem;font-weight:600;color:var(--accent,#32664d);background:color-mix(in srgb,var(--accent,#32664d) 21%,white)}
.calendar-details{padding:1rem;border:1px solid #cddbd3;border-radius:.7rem;background:#fffdf8}
.calendar-details h2{margin-top:0}
@media(max-width:850px){.calendar-layout{grid-template-columns:minmax(0,1fr)}.calendar-details{grid-row:1}}
.calendar-today::after{content:"";position:absolute;z-index:2;inset:1px;border:3px solid #14532d;border-radius:.55rem;pointer-events:none}
.calendar-day:has(.calendar-today-label){z-index:3}
.calendar-today-label{position:absolute;top:0;left:50%;transform:translate(-50%,-40%);padding:0 .5rem;border-radius:1rem;background:#14532d;color:white;font-size:.78rem;font-weight:700;white-space:nowrap;pointer-events:none}
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
const familyTone = title => [...title].reduce((total, char) => (total * 31 + char.codePointAt(0)) % 5, 0);
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
    const tone = familyTone(title);
    return '<section class="activity-family" data-tone="' + tone + '"><h2>' + escape(title) +
      '</h2><div class="activity-grid">' + cards.map(render).join('') + '</div></section>';
  }).join('');
}

function watchButton(entry, watches, back) {
  const id = watchKey(entry);
  const saved = watches[id];
  return (saved && saved.version !== watchVersion(entry) ? '<p role="status">關注項目的來源已更新</p>' : '') +
    '<form method="post" action="/watch"><input type="hidden" name="id" value="' + id +
    '"><input type="hidden" name="back" value="' + escape(back) + '"><button>' +
    (saved ? '取消關注' : entry.reward ? '關注獎勵' : '關注活動') + '</button></form>';
}

function catalogResults(entries, saved, watches, back = '/') {
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
      '<p><a href="' + href + '">' + (reward ? '查看取得方式 →' : '查看活動 →') + '</a></p>' +
      (watches ? watchButton({ item, method: target, reward }, watches, back) : '') + '</article>';
  });
}

function primaryTabs(active) {
  return '<nav class="site-tabs" aria-label="主要分頁">' + [['/', '活動與獎勵'], ['/watch', '我的關注'], ['/calendar', '活動日曆'],
    ['/issues', '已知／修復問題'], ['/manage', '公告管理']]
    .map(([href, label]) => '<a href="' + href + '"' + (href === active ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</nav>';
}

const managementBack = '<a href="/manage">← 上一頁</a>';

function calendarPage(activities, all, month, today, filters, message, selected = []) {
  const date = new Date(month + '-01T00:00:00Z');
  const nearby = offset => {
    const shifted = new Date(date);
    shifted.setUTCMonth(shifted.getUTCMonth() + offset);
    return shifted.toISOString().slice(0, 7);
  };
  const href = (nextMonth, options = {}) => {
    const params = new URLSearchParams({ month: nextMonth });
    if (filters.watched) params.set('watched', '1');
    if (filters.family) params.set('family', filters.family);
    if (options.expanded ?? filters.expanded) params.set('expanded', '1');
    if (options.day) params.set('day', options.day);
    return '/calendar?' + escape(params.toString()) + (options.day ? '#calendar-date-details' : '');
  };
  const events = new Map();
  for (const { item, dates } of activities) {
    for (const entry of dates.filter(entry => entry.point?.date.startsWith(month))) {
      const day = entry.point.date;
      if (!events.has(day)) events.set(day, []);
      events.get(day).push({ item, ...entry });
    }
  }
  const families = [...new Set(all.map(({ item }) => familyTitle(item)))];
  const visibleFamilies = new Set(activities.map(({ item }) => familyTitle(item)));
  const ranges = families.flatMap(title => {
    if (!visibleFamilies.has(title)) return [];
    const members = all.filter(({ item }) => familyTitle(item) === title);
    const official = members.map(({ item }) => versionPeriod(item)).find(period => period.start && period.end &&
      period.start.date !== '1900-01-01' && period.end.date !== '2100-12-31');
    if (official) return [{ title, start: official.start.date, end: official.end.date }];
    const confirmed = members.flatMap(({ dates }) => {
      const start = dates.find(entry => entry.kind === 'start' && !entry.method)?.point?.date;
      const end = dates.find(entry => entry.kind === 'end' && !entry.method)?.point?.date;
      return start && end ? [{ start, end }] : [];
    });
    return confirmed.length ? [{ title, start: confirmed.map(period => period.start).sort()[0],
      end: confirmed.map(period => period.end).sort().at(-1), inferred: true }] : [];
  });
  const weeks = calendarMonth(month);
  const selectedDay = weeks.flat().includes(filters.day) ? filters.day : '';
  const cells = weeks.map(week => {
    const first = week.find(Boolean);
    const last = week.findLast(Boolean);
    const bands = ranges.filter(range => range.start <= last && range.end >= first);
    const shown = filters.expanded ? bands : bands.slice(0, 3);
    const grid = (column, row, span = 1) => ' style="grid-column:' + column + '/span ' + span + ';grid-row:' + row + '"';
    const countRow = shown.length + 2;
    const backgrounds = week.map((day, index) => '<div aria-hidden="true" class="calendar-cell' +
      (!day ? ' calendar-cell-empty' : '') + (day === today ? ' calendar-today' : '') +
      (day && day === selectedDay ? ' calendar-cell-selected' : '') + '"' + grid(index + 1, '1/' + (countRow + 1)) + '></div>').join('');
    const dates = week.map((day, index) => day ? '<div class="calendar-day"' + grid(index + 1, 1) + '>' +
      (day === today ? '<span class="calendar-today-label" aria-hidden="true">今天</span>' : '') +
      '<a href="' + href(month, { day }) + '" aria-label="' + day + ' 活動清單"' +
      (day === selectedDay ? ' aria-controls="calendar-date-details"' : '') + '><time datetime="' + day +
      '"' + (day === today ? ' aria-current="date"' : '') + '>' + Number(day.slice(-2)) + '</time></a></div>' : '').join('');
    const strips = shown.map(({ title, start, end, inferred }, index) => {
      const left = week.findIndex(day => day && day >= start);
      const right = week.findLastIndex(day => day && day <= end);
      const rangeText = title + ' · ' + start + ' 至 ' + end + (inferred ? ' · 依已確認活動日期彙整' : '');
      return '<div class="calendar-band" data-tone="' + familyTone(title) + '" title="' + escape(rangeText) + '"' +
        grid(left + 1, index + 2, right - left + 1) + '>' + (start < first ? '‹ ' : '開始 · ') +
        escape(title) + (end > last ? ' ›' : ' · 截止') + '</div>';
    }).join('');
    const counts = week.map((day, index) => {
      const chips = ['start', 'end'].map(kind => {
        const count = new Set((events.get(day) ?? []).filter(entry => entry.kind === kind).map(entry => entry.item.id)).size;
        return count ? '<a class="calendar-count calendar-count-' + kind + '" href="' + href(month, { day }) + '">' +
          count + ' 項' + (kind === 'start' ? '開始' : '截止') + '</a>' : '';
      }).join('');
      return '<div class="calendar-counts"' + grid(index + 1, countRow) + '>' + chips + '</div>';
    }).join('');
    return '<div class="calendar-week">' + backgrounds + dates + strips + counts + '</div>' +
      (bands.length > 3 ? '<a class="calendar-more" href="' + href(month, { day: selectedDay, expanded: !filters.expanded }) +
        '">' + (filters.expanded ? '收合主活動' : '展開另外 ' + (bands.length - 3) + ' 個主活動') + '</a>' : '');
  }).join('');
  const details = (events.get(selectedDay) ?? []);
  const detailGroups = ['start', 'end', 'claim'].map(kind => {
    const entries = details.filter(entry => entry.kind === kind);
    if (!entries.length) return '';
    const groups = [...new Set(entries.map(({ item }) => familyTitle(item)))];
    return '<h3>' + entries[0].label + '</h3>' + groups.map(title => '<h4>' + escape(title) + '</h4><ul>' +
      entries.filter(({ item }) => familyTitle(item) === title).map(({ item, method }) =>
        '<li><a href="/activities/' + item.id + (method ? '#' + method.id : '') + '">' +
        escape(item.title + (method ? ' › ' + method.title : '')) + '</a></li>').join('') + '</ul>').join('');
  }).join('');
  const options = activities.map(({ item, dates, reminders }) => {
    const known = dates.filter(entry => entry.point).length;
    const unavailable = dates.filter(entry => !entry.point);
    return '<li><label><input type="checkbox" name="activity" value="' + item.id + '"' + (selected.includes(item.id) ? ' checked' : '') +
      (known ? '' : ' disabled') + '> ' + escape(familyTitle(item) + ' › ' + item.title) + ' · ' + known + ' 項可匯出</label>' +
      (reminders.length ? '<div>' + [...new Set(reminders.map(rule => rule.frequency))].map(frequency =>
        '<label><input type="checkbox" name="reminder" value="' + item.id + ':' + frequency + '"> ' +
        (frequency === 'DAILY' ? '每日' : '每週') + '重置提醒</label> ').join('') + '</div>' :
        '<small> · 公告未提供可匯出的重置週期</small>') +
      (unavailable.length ? '<details><summary>無法匯出的日期</summary><ul>' + unavailable.map(entry => '<li>' +
        escape((entry.method ? entry.method.title + ' · ' : '') + entry.label + ' · ' +
          (entry.source?.text ? '日期待確認 · ' + entry.source.text : '公告未載明日期')) + '</li>').join('') + '</ul></details>' : '') + '</li>';
  }).join('');
  const filterFields = '<input type="hidden" name="month" value="' + month + '">';
  return page('活動日曆', primaryTabs('/calendar') + '<h1>活動日曆</h1><p><a href="' + href(nearby(-1)) +
    '">← 上個月</a> · <strong>' + month + '</strong> · <a href="' + href(nearby(1)) + '">下個月 →</a></p>' +
    '<form class="calendar-filters" method="get" action="/calendar">' + filterFields +
    '<label><input type="checkbox" name="watched" value="1"' + (filters.watched ? ' checked' : '') + '> 只看關注</label>' +
    '<label>主活動 <select name="family"><option value="">全部</option>' + families.map(title => '<option' +
      (title === filters.family ? ' selected' : '') + '>' + escape(title) + '</option>').join('') + '</select></label><button>套用篩選</button></form>' +
    '<div class="calendar-layout"><div class="calendar-scroll"><div class="calendar-grid" aria-label="' + month + ' 活動日曆">' +
    '<div class="calendar-week">' + [...'一二三四五六日'].map(day => '<div class="calendar-weekday">週' + day + '</div>').join('') +
    '</div>' + cells + '</div></div><section class="calendar-details" id="calendar-date-details"><h2>' +
    (selectedDay ? selectedDay.slice(5).replace('-', '/') + ' 活動清單' : '日期活動清單') + '</h2>' +
    (selectedDay ? detailGroups || '<p>這天沒有符合篩選的活動日期。</p>' : '<p>點選日期或項目數量，查看活動名稱。</p>') + '</section></div>' +
    '<h2>選取活動匯出</h2>' + (filters.changed.length ? '<p role="status">下列活動的日期或已匯出提醒已變更，請重新匯出：</p><ul>' +
      filters.changed.map(title => '<li>' + escape(title) + '</li>').join('') + '</ul>' : '') +
    (message ? '<p role="alert">' + escape(message) + '</p>' : '') +
    '<details' + (message ? ' open' : '') + '><summary>選取要匯出的活動</summary><form method="post" action="/calendar">' + filterFields +
    (filters.watched ? '<input type="hidden" name="watched" value="1">' : '') +
    '<input type="hidden" name="family" value="' + escape(filters.family) + '"><ul>' + options +
    '</ul><p>重新匯出後請在外部日曆管理先前匯入的事件。舊事件不會自動更新或刪除，重複匯入可能產生副本。</p>' +
    '<button>下載 .ics</button></form></details>');
}

function managementPage(saved, status, hasSnapshot) {
  return page('公告管理', primaryTabs('/manage') + '<h1>公告管理</h1>' +
    '<nav class="site-tabs" aria-label="公告管理功能">' +
    '<a href="/discover">公告探索</a><a href="/tracking">活動來源追蹤</a><a href="/schedule">每日更新排程</a><a href="/jobs">批次進度與重試</a>' +
    (hasSnapshot ? '<a href="/review">檢視與調整公告拆分</a><a href="/updates">來源與摘要更新</a><a href="/corrections">來源關聯與更正</a><a href="/edits">修正摘要</a>' : '') + '</nav>' +
    (status ? '<p role="status">' + escape(status) + '</p>' : '') +
    (saved?.capturedAt ? '<p>已保存摘要 · ' + escape(formatTimestamp(saved.capturedAt)) + '</p>' : '') +
    '<form method="post" action="/import"><button>匯入並整理公告 19129</button></form>');
}

function home(saved, query, now, hasSnapshot = Boolean(saved), listing, assist) {
  const hasSearch = query || listing?.filters.status || listing?.filters.type || listing?.filters.watched;
  const entries = listing ? searchCatalog(listing.items, listing.filters, now, listing.images,
    { includeMethods: listing.filters.watched }).filter(entry => !listing.filters.watched ||
      ((!entry.method || entry.reward) && listing.watches[watchKey(entry)])) : [];
  const back = listing?.back ?? '/';
  const offerAssist = listing && query && (!entries.length || entries.length > 8 || assist);
  let nameResults = listing ? catalogResults(entries, listing.snapshot === saved?.snapshot ? saved : null, listing.watches, back) :
    searchResults(saved, query, now);
  if (assist) nameResults = entries.length || !assist.matches?.length
    ? '<section><h2>名稱搜尋結果</h2>' + nameResults + '</section>' : '';
  return page('新楓之谷公告懶人包', primaryTabs('/') + '<h1>新楓之谷公告懶人包</h1><form method="get" action="/"><label for="q">搜尋獎勵或活動</label> <input id="q" name="q" value="' +
    escape(query) + '"> ' + (listing ? filterOptions('state', statuses, listing.filters.status, '活動狀態') + ' ' +
      filterOptions('type', rewardTypes, listing.filters.type, '獎勵類型') + ' <label><input type="checkbox" name="watched" value="1"' +
      (listing.filters.watched ? ' checked' : '') + '>只看關注</label> ' : '') +
    '<button>搜尋</button>' + (offerAssist ? ' <button formmethod="post" formaction="/assist/search">用 Agent 搜尋</button>' : '') +
    (hasSearch ? '<a class="search-home-link" href="/">回首頁</a>' : '') + '</form>' +
    (assist ? '<section><h2>Agent 搜尋結果</h2>' + (assist.error ? '<p role="alert">' + escape(assist.error) + '</p>' :
      assist.matches.length ? catalogResults(assist.matches, null, listing?.watches, back) + assistantModel(assist.metadata) :
        '<p>已收錄的活動與獎勵沒有明確符合的結果。</p>') + '</section>' : '') +
    nameResults +
    (hasSnapshot || listing ? '<p><a href="/activities">查看全部已收錄活動</a></p>' : ''));
}

function reviewPage(document, automatic, previous, message, route = '/review', officialUrl) {
  const options = automatic.flatMap(item => item.methods.filter(method => method.kind === 'method')
    .map(method => '<option value="' + method.id + '">' + escape(item.title + ' › ' + method.title) + '</option>')).join('');
  return page('檢視公告拆分', '<nav>' + managementBack + '</nav><h1>檢視公告拆分</h1>' +
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
  const hasBatchWork = Object.values(registry.queue ?? {}).some(job => ['pending', 'failed'].includes(job.state));
  return page('探索官方公告', '<nav>' + managementBack + '</nav><h1>探索官方公告</h1>' +
    '<p>最近 90 天（台北時間） · ' + window.start + ' 至 ' + window.end + '</p>' +
    '<form method="post"><button>檢查官方公告列表</button></form>' +
    (hasBatchWork ? '<p><a href="/jobs">處理待辦或重試公告</a></p>' : '') +
    '<form method="post" action="/discover/import"><p><label>手動補入官方網址 <input type="url" name="url" required></label> ' +
    '<button>保存來源</button></p></form>' + (message ? '<p role="status">' + escape(message) + '</p>' : '') +
    (run ? '<p>上次檢查 · ' + escape(formatTimestamp(run.at)) + ' · ' + run.start + ' 至 ' + run.end +
      ' · 讀取 ' + run.pages + ' 頁 · 範圍內可讀公告連結 ' + run.candidates + ' 筆 · 保存 ' + run.saved + ' 筆</p>' +
      (run.error ? '<p role="alert">列表檢查未完成 · ' + escape(run.error) + '</p>' : '') +
      (run.failures.length ? '<details><summary>正文取得失敗 ' + run.failures.length + ' 筆</summary><ul>' +
          run.failures.map(entry => '<li><a href="' + escape(entry.url) + '">' + escape(entry.title ?? entry.url) + '</a> · ' +
          escape(entry.message ?? entry.error) + '</li>').join('') + '</ul></details>' : '') : '') +
    '<h2>已保存來源</h2>' + (entries.length ? '<ul>' + entries.map(entry => '<li><a href="/discover/' + entry.id + '">' +
      escape(entry.title) + '</a> · ' + escape(entry.date ?? '發布日未載明') + ' · ' + labels[entry.kind] + ' · ' +
      (entry.kind !== 'version' ? '來源已保存' : entry.active ? '可查看活動' :
        entry.review?.snapshot === entry.snapshot ? '已人工確認 · 可整理摘要' : '來源已保存 · 拆分待確認') + '</li>').join('') +
      '</ul>' : '<p>尚未保存公告來源。</p>'));
}

function jobsPage(registry, jobs, activeJobId) {
  const sources = Object.values(registry.queue ?? {});
  const labels = { pending: '待處理', done: '已完成', failed: '需重試', removed: '公告已下架' };
  const items = [...sources.filter(job => job.state !== 'done'), ...Object.values(jobs)];
  const detail = job => '<li><strong>' + escape(job.title ?? job.url) + '</strong> · ' + (job.id === activeJobId ? '處理中' : labels[job.state]) +
    (job.label ? ' · ' + escape(job.label) : '') + (job.message ? '<p>' + escape(job.message) + '</p>' : '') +
    (job.attempts ? '<p>本次嘗試 ' + job.attempts + ' 次</p>' : '') +
    (job.provider ? '<p>模型 · ' + escape(job.provider === 'codex' ? '訂閱 Codex' : 'Gemini') +
      ' · 用量 ' + (job.usage ? escape(JSON.stringify(job.usage)) : '未知') + '</p>' : '') +
    (job.url ? '<p><a href="' + escape(job.url) + '">官方來源</a></p>' : '') +
    (job.activity ? '<p><a href="/activities/' + job.activity + '">查看活動</a></p>' : '') +
    (!['pending', 'failed'].includes(job.state) || job.id === activeJobId ? '' : '<form method="post" action="' + escape(job.action) + '">' +
      Object.entries(job.fields).map(([name, value]) => '<input type="hidden" name="' + escape(name) +
        '" value="' + escape(value) + '">').join('') + '<button>' + (job.state === 'failed' ? '重試這一項' : '處理這一項') +
      '</button></form>') +
    (job.url && job.state === 'failed' && job.id !== activeJobId ? '<form method="post" action="/discover/removed">' +
      '<input type="hidden" name="id" value="' + escape(job.id) + '"><button>標記公告已下架</button></form>' : '') + '</li>';
  return page('批次進度與重試', '<nav>' + managementBack + '</nav>' +
    '<h1>批次進度與重試</h1><p>公告來源 · 待處理 ' + sources.filter(job => job.state === 'pending').length +
    ' · 已完成 ' + sources.filter(job => job.state === 'done').length + ' · 需重試 ' +
    sources.filter(job => job.state === 'failed').length + '</p>' +
    (sources.some(job => job.state === 'pending') ? '<form method="post" action="/discover/continue"><button>繼續公告批次</button></form>' : '') +
    (items.length ? '<ul>' + items.map(detail).join('') + '</ul>' : '<p>目前沒有待處理或失敗項目。</p>'));
}

function schedulePage(state, enabled) {
  const scheduled = state.scheduled;
  const results = { running: '執行中', success: '完成', partial: '部分來源需重試', failed: '失敗', interrupted: '中斷' };
  return page('每日更新排程', '<nav>' + managementBack + '</nav>' +
    '<h1>每日更新排程</h1><p>程式運行且電腦清醒時，依台北時間執行。恢復運行後會補查最近一次錯過的排程。</p>' +
    (enabled ? '' : '<p>目前的伺服器未啟用背景排程。</p>') +
    '<form method="post"><label>每日檢查時間（台北） <input type="time" name="time" required value="' +
    escape(state.time ?? DEFAULT_SCHEDULE) + '"></label> <button>保存排程</button></form>' +
    '<form method="post" action="/discover"><button>立即檢查官方公告</button></form>' +
    '<dl><dt>上次成功檢查</dt><dd>' + escape(formatTimestamp(state.lastSuccessAt)) + '</dd>' +
    '<dt>最近失敗原因</dt><dd>' + (state.lastFailure ? escape(formatTimestamp(state.lastFailure.at) + ' · ' + state.lastFailure.reason) : '尚未記錄') +
    '</dd><dt>最近一次排程或補查</dt><dd>' + (scheduled ? escape(scheduled.day + ' · ' +
      (scheduled.type === 'catch-up' ? '錯過排程補查' : '固定排程') + ' · ' + results[scheduled.result] +
      ' · ' + formatTimestamp(scheduled.at)) : '尚未執行') + '</dd></dl>' +
    (['partial', 'interrupted'].includes(scheduled?.result) ? '<p><a href="/jobs">前往批次進度與重試</a></p>' : ''));
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

function activityDetail(item, now, summaries = {}, status = '', imageRecords = {}, provider = 'gemini', watches, edits = {}, issues = []) {
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
    const manual = edits[editKey(item, method)]?.fields ?? {};
    const summary = summaries[method.id];
    const auto = summary ? summaryForDisplay(summary, methodContext(item, method)) : {};
    const editableSummary = Object.entries(methodFields).map(([key, label]) => {
      const edit = manual[key];
      if (!edit) return facts(label, (auto[key] ?? []).map(fact => ({ text: fact.text, id: fact.source })));
      const changed = editChanged(edit.baseline, editEvidence(item, method, summary, key));
      return '<dt>' + label + ' · 個人修正</dt><dd>' + escape(edit.text) +
        (changed ? '<p role="status">來源或自動摘要已變更，請核對個人修正。</p>' : '') + '</dd>';
    }).join('');
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
      (summary || Object.keys(manual).length ? '<dl>' + editableSummary + '</dl>' : '<p>尚未整理這個方法。</p>') +
      '<p><a href="/edits?method=' + method.id + '">修正摘要</a></p>' +
      '<form method="post" action="/activities/' + item.id + '/' + method.id + '"><button>用預設模型整理這個方法</button></form></details></article>';
  }).join('');
  const shared = originalFlow(item.sources, item.images, '活動共用表格與圖片');
  const imageNotes = verifiedImageSources(item, imageRecords);
  return page(item.title, activityNav('/activities', '← 全部活動', item.title, item.officialUrl) + eventLabel(item) + '<h1>' + escape(item.title) + '</h1>' +
    (watches ? watchButton({ item }, watches, '/activities/' + item.id) : '') +
    (issues.length ? '<p>這個活動有 ' + issues.length + ' 筆官方問題紀錄。 <a href="/issues?activity=' + item.id +
      '">查看相關問題</a></p>' : '') + '<p>' +
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
  openAnnouncementPages = officialPages, fetchAnnouncement = officialAnnouncement,
  enableSchedule = false, scheduleInterval = 30000 } = {}) {
  let importing = false;
  let activeJobId = null;
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
  const issueSnapshots = registry => Object.values(registry.entries).filter(notice => notice.kind === 'routine')
    .flatMap(notice => [notice, ...(notice.previousSnapshots ?? []).filter(entry => entry.snapshot !== notice.snapshot)
      .map(entry => ({ ...entry, id: notice.id, url: notice.url }))]);
  let issueCache;
  async function readIssues(items) {
    const snapshots = issueSnapshots(await discoveryRegistry());
    const key = fingerprint([snapshots.map(({ snapshot }) => snapshot), items.map(({ id, title }) => [id, title])]);
    if (issueCache?.key === key) return issueCache.value;
    const documents = await Promise.all(snapshots.map(async entry => ({
      ...entry, html: await readFile(join(dir, entry.snapshot), 'utf8'),
    })));
    const value = issueIndex(documents, items);
    issueCache = { key, value };
    return value;
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
  async function writeJob(id, job) {
    const jobs = await readSaved('jobs.json') ?? {};
    jobs[id] = job;
    await save('jobs.json', JSON.stringify(jobs));
  }
  async function discoveryWork(registry, base, clock, { mode, input } = {}) {
    let items = await browsableItems(base);
    const queue = registry.queue ??= {};
    const persist = () => save('discovery.json', JSON.stringify(registry));
    const importOne = async candidate => {
      const id = fingerprint(candidate.url).slice(0, 24);
      const entry = await saveAnnouncement(candidate, items, fetchAnnouncement, save, registry.entries[id], clock);
      if (!entry) return false;
      if (entry.existing) {
        try {
          catalogFromSnapshot(await readFile(join(dir, entry.snapshot), 'utf8'));
          await save('activity-source.json', JSON.stringify({ snapshot: entry.snapshot, checkedAt: clock.toISOString() }));
          entry.active = true;
          if (!base) items = await browsableItems({ snapshot: entry.snapshot });
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
        }
      }
      registry.entries[id] = entry;
      return true;
    };
    const enqueue = candidate => {
      const id = fingerprint(candidate.url).slice(0, 24);
      queue[id] = { id, ...candidate, state: 'pending',
        queuedAt: clock.toISOString(), action: '/discover/retry', fields: { id } };
      return queue[id];
    };
    let work;
    if (mode === 'manual') work = [enqueue({ url: announcementUrl(input) })];
    else if (mode === 'retry') {
      const job = /^[a-f0-9]{24}$/.test(input ?? '') ? queue[input] : undefined;
      if (!job || !['pending', 'failed'].includes(job.state)) throw new Problem('找不到待處理的公告工作。', 404);
      work = [job];
    } else {
      if (mode !== 'continue') {
        const { candidates, ...run } = await collectAnnouncements(openAnnouncementPages, clock);
        const tracking = sourceTracking(items, registry.entries, clock);
        const tracked = new Set([...tracking].filter(([, activities]) => activities.some(item => item.track)).map(([url]) => url));
        const existing = new Map(Object.values(registry.entries).map(entry => [entry.url, entry]));
        const selected = new Map(candidates.filter(candidate =>
          !tracking.has(candidate.url) || tracked.has(candidate.url)).map(candidate => [candidate.url, candidate]));
        for (const url of tracked) {
          if (!selected.has(url)) selected.set(url, existing.get(url) ?? { url });
        }
        const sorted = [...selected.values()].sort((a, b) =>
          Number(b.kind === 'version' || b.url === official) - Number(a.kind === 'version' || a.url === official));
        for (const candidate of sorted) {
          const current = queue[fingerprint(candidate.url).slice(0, 24)];
          if (!current || (current.state === 'done' && tracked.has(candidate.url))) enqueue(candidate);
        }
        registry.run = { ...run, at: clock.toISOString(), candidates: candidates.length, saved: 0, failures: [] };
      }
      work = Object.values(queue).filter(job => job.state === 'pending')
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).slice(0, SOURCE_BATCH);
    }
    await persist();
    for (const job of work) {
      activeJobId = job.id;
      const result = await sourceAttempt(() => importOne(job));
      const failure = result.error ? jobFailure(result.error, 'source') : { state: 'done', label: '', message: '' };
      Object.assign(job, failure, { attempts: result.attempts, saved: Boolean(result.value) });
      if (registry.run) {
        registry.run.failures = Object.values(queue).filter(entry => entry.state === 'failed');
        if (job.saved && mode !== 'manual') registry.run.saved++;
      }
      await persist();
    }
    return { registry, work };
  }
  const scheduleState = async () => await readSaved('schedule.json') ?? {};
  const saveSchedule = state => save('schedule.json', JSON.stringify(state));
  function recordCheck(state, report, at) {
    const { registry, work } = report;
    const errors = work.filter(job => job.state === 'failed');
    const listError = registry.run?.error;
    if (!listError && !errors.length) state.lastSuccessAt = at;
    if (listError || errors.length) {
      state.lastFailure = { at, reason: listError ? '列表未完成 · ' + listError :
        errors.length + ' 筆來源需重試 · ' + errors[0].message };
    }
    return listError ? 'failed' : errors.length ? 'partial' : 'success';
  }
  async function runSchedule() {
    if (importing) return;
    const observed = await scheduleState();
    if (observed.startedAt && observed.scheduled?.result !== 'running' && !dueCheck(now(), observed)) return;
    if (importing || !server.listening) return;
    importing = true;
    try {
      const state = await scheduleState();
      const clock = now();
      const at = clock.toISOString();
      const firstStart = !state.startedAt;
      state.startedAt ??= at;
      if (state.scheduled?.result === 'running') {
        state.scheduled.result = 'interrupted';
        state.lastFailure = { at, reason: '上次排程中斷。請從批次進度繼續待處理工作。' };
        await saveSchedule(state);
      } else if (firstStart) await saveSchedule(state);
      const due = dueCheck(clock, state);
      if (!due) return;
      state.scheduled = { ...due, at, result: 'running' };
      await saveSchedule(state);
      try {
        const report = await discoveryWork(await discoveryRegistry(), await readSaved('activity-source.json') ?? await readSaved(), clock);
        state.scheduled.result = recordCheck(state, report, now().toISOString());
      } catch (error) {
        state.scheduled.result = 'failed';
        state.lastFailure = { at: now().toISOString(), reason: error.message };
      }
      await saveSchedule(state);
    } finally {
      importing = false;
      activeJobId = null;
    }
  }
  const server = createServer(async (req, res) => {
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
        return respond(200, page('活動來源追蹤', '<nav>' + managementBack + '</nav><h1>活動來源追蹤</h1>' +
          (details || '<p>確認活動後即可查看來源追蹤狀態。</p>')));
      }
      if (req.method === 'GET' && url.pathname === '/jobs') {
        return respond(200, jobsPage(await discoveryRegistry(), await readSaved('jobs.json') ?? {}, activeJobId));
      }
      if (url.pathname === '/watch') {
        if (req.method === 'POST') lockModel();
        const watches = await readSaved('watches.json') ?? {};
        const items = await browsableItems(await readSaved('activity-source.json') ?? await readSaved());
        const current = searchCatalog(items, { query: '', status: '', type: '' }, now(), await readSaved('official-images.json') ?? {},
          { includeMethods: true }).filter(entry => !entry.method || entry.reward);
        if (req.method === 'POST') {
          const form = await formData(req);
          const id = form.get('id');
          if (Object.hasOwn(watches, id)) delete watches[id];
          else {
            const entry = current.find(entry => watchKey(entry) === id);
            if (!entry) throw new Problem('找不到可關注的項目。', 404);
            watches[id] = { label: entry.reward?.name ?? entry.item.title, version: watchVersion(entry) };
          }
          await save('watches.json', JSON.stringify(watches));
          const back = form.get('back') ?? '';
          const safeBack = /^\/(?:watch$|activities\/[\w-]+$|\?[^\r\n]*$|$)/.test(back) ? back : '/watch';
          return res.writeHead(303, { Location: safeBack }).end();
        }
        if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
        const entries = current.filter(entry => watches[watchKey(entry)]);
        const keys = new Set(entries.map(watchKey));
        const missing = Object.entries(watches).filter(([id]) => !keys.has(id));
        return respond(200, page('我的關注', primaryTabs('/watch') + '<h1>我的關注</h1>' +
          (entries.length ? catalogResults(entries, null, watches, '/watch') : '<p>目前沒有可查看的關注項目。</p>') +
          missing.map(([id, record]) => '<p>' + escape(record.label) + ' · 來源待確認</p><form method="post">' +
            '<input type="hidden" name="id" value="' + escape(id) + '"><button>取消關注</button></form>').join('')));
      }
      if (url.pathname === '/calendar') {
        if (!['GET', 'POST'].includes(req.method)) throw new Problem('操作不支援。', 405);
        const params = req.method === 'POST' ? await formData(req) : url.searchParams;
        const requested = params.get('month') ?? '';
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now());
        const month = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(requested) ? requested : today.slice(0, 7);
        const items = await browsableItems(await readSaved('activity-source.json') ?? await readSaved());
        const all = items.map(calendarActivity);
        const history = await readSaved('calendar-exports.json') ?? {};
        const filters = { family: params.get('family') ?? '', watched: params.get('watched') === '1',
          day: params.get('day') ?? '', expanded: params.get('expanded') === '1',
          changed: all.filter(activity => {
            const previous = history[activity.item.id];
            return previous && previous.version !== exportVersion(activity, previous.frequencies);
          }).map(activity => activity.item.title) };
        const watches = filters.watched ? await readSaved('watches.json') ?? {} : {};
        const activities = all.filter(({ item }) => (!filters.family || familyTitle(item) === filters.family) &&
          (!filters.watched || watches[item.id] || item.methods.filter(method => method.kind === 'method').some(method =>
            activityRewards(item, method).some(reward => watches[watchKey({ item, method, reward })]))));
        if (req.method === 'GET') return respond(200, calendarPage(activities, all, month, today, filters));
        const ids = [...new Set(params.getAll('activity'))];
        const selected = activities.filter(({ item }) => ids.includes(item.id));
        if (!ids.length || selected.length !== ids.length || !selected.some(({ dates }) => dates.some(entry => entry.point))) {
          return respond(422, calendarPage(activities, all, month, today, filters, '請勾選至少一個有確定日期的活動。', ids));
        }
        lockModel();
        const currentHistory = await readSaved('calendar-exports.json') ?? {};
        const requestedReminders = new Set(params.getAll('reminder'));
        const options = {};
        const at = now();
        for (const activity of selected) {
          const id = activity.item.id;
          const frequencies = [...new Set(activity.reminders.map(rule => rule.frequency))].filter(frequency =>
            requestedReminders.has(id + ':' + frequency));
          options[id] = frequencies;
          currentHistory[id] = { version: exportVersion(activity, frequencies), frequencies, exportedAt: at.toISOString() };
        }
        const file = exportCalendar(selected, at, 'http://' + req.headers.host, options);
        await save('calendar-exports.json', JSON.stringify(currentHistory));
        return res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="maplestory-activities.ics"', 'X-Content-Type-Options': 'nosniff' })
          .end(file);
      }
      if (req.method === 'GET' && url.pathname === '/issues') {
        const items = await browsableItems(await readSaved('activity-source.json') ?? await readSaved());
        const activityId = url.searchParams.get('activity');
        const item = items.find(item => item.id === activityId);
        const state = url.searchParams.get('state') ?? '';
        const labels = { known: '已知問題', fixed: '已修復' };
        const records = (await readIssues(items)).filter(issue => (!activityId || issue.activities.some(activity => activity.id === activityId)) &&
          (!Object.hasOwn(labels, state) || issue.state === state));
        return respond(200, page('已知／修復問題', primaryTabs('/issues') + '<h1>已知／修復問題</h1>' +
          (item ? '<p><a href="/activities/' + item.id + '">← 回活動筆記</a> · <a href="/issues">查看全部問題</a></p>' : '') +
          '<form method="get">' + (item ? '<input type="hidden" name="activity" value="' + item.id + '">' : '') +
          '<label>官方狀態 <select name="state"><option value="">全部</option>' + Object.entries(labels).map(([key, label]) =>
            '<option value="' + key + '"' + (state === key ? ' selected' : '') + '>' + label + '</option>').join('') +
          '</select></label> <button>篩選</button></form>' +
          (records.length ? records.map(issue => '<article id="issue-' + issue.id + '"><h2>' + labels[issue.state] + '</h2><p>' +
            escape(issue.text) + '</p><p>最近公告 · ' + escape(issue.date ?? '日期未載明') + '</p>' +
            issue.activities.map(activity => '<p><a href="/activities/' + activity.id + '">' + escape(activity.title) + '</a></p>').join('') +
            '<details><summary>歷次公告與原文（' + issue.history.length + '）</summary><ul>' + issue.history.map(entry => '<li>' +
              escape((entry.date ?? '日期未載明') + ' · ' + entry.title + ' · ' + entry.heading) + '<pre>' + escape(entry.text) +
              '</pre><a href="' + escape(entry.url) + '">官方公告 ↗</a> · <a download href="/issues/source/' + entry.notice +
              '/' + entry.snapshot + '">下載已保存原文</a></li>').join('') + '</ul></details></article>').join('') : '<p>沒有符合的問題紀錄。</p>')));
      }
      if (req.method === 'GET' && /^\/issues\/source\/[a-f0-9]{24}\/discovered-[a-f0-9]{64}\.html$/.test(url.pathname)) {
        const [, , , id, snapshot] = url.pathname.split('/');
        const entry = issueSnapshots(await discoveryRegistry()).find(entry => entry.id === id && entry.snapshot === snapshot);
        if (!entry) throw new Problem('找不到已保存的公告。', 404);
        return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment; filename="official-notice.txt"' }).end(await readFile(join(dir, snapshot), 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/manage') {
        const saved = await readSaved();
        const source = await readSaved('activity-source.json') ?? saved;
        return respond(200, managementPage(saved, await readSaved('status.json'), Boolean(source) || (await discoveredItems()).length > 0));
      }
      if (url.pathname === '/edits') {
        if (req.method === 'POST') lockModel();
        const edits = await readSaved('manual-edits.json') ?? {};
        const summaries = (await readSaved('activity-methods.json'))?.methods ?? {};
        const items = await browsableItems(await readSaved('activity-source.json') ?? await readSaved());
        const methods = items.flatMap(item => item.methods.filter(method => method.kind === 'method')
          .map(method => ({ item, method, id: editKey(item, method) })));
        const form = req.method === 'POST' ? await formData(req) : url.searchParams;
        const selected = methods.find(({ method }) => method.id === form.get('method'));
        if (req.method === 'POST') {
          const id = form.get('id');
          const field = form.get('field');
          const action = form.get('action');
          const text = (form.get('text') ?? '').trim();
          if (!/^[a-f0-9]{64}$/.test(id ?? '') || !Object.hasOwn(methodFields, field) ||
              !['save', 'restore'].includes(action)) throw new Problem('請選擇有效的修正項目。');
          if (action === 'restore') {
            if (!edits[id]?.fields[field]) throw new Problem('找不到已保存的個人修正。', 404);
            delete edits[id].fields[field];
            if (!Object.keys(edits[id].fields).length) delete edits[id];
          } else {
            if (!selected || selected.id !== id || !text || text.length > 4000) throw new Problem('請選擇目前的方法並填寫修正內容。');
            const { item, method } = selected;
            const record = edits[id] ??= { activity: item.title, method: method.title, fields: {} };
            record.fields[field] = { text, baseline: editEvidence(item, method, summaries[method.id], field) };
          }
          await save('manual-edits.json', JSON.stringify(edits));
          const confirmed = selected ? '?method=' + encodeURIComponent(selected.method.id) : '';
          return res.writeHead(303, { Location: '/edits' + confirmed }).end();
        }
        if (req.method !== 'GET') throw new Problem('操作不支援。', 405);
        const query = (form.get('q') ?? '').trim();
        const formFields = (id, field, method = '') => '<input type="hidden" name="id" value="' + id +
          '"><input type="hidden" name="field" value="' + field + '"><input type="hidden" name="method" value="' + escape(method) + '">';
        const unavailable = Object.entries(edits).filter(([id]) => !methods.some(method => method.id === id));
        const editor = selected ? '<p><a href="/activities/' + selected.item.id + '#' + selected.method.id + '">查看活動筆記</a></p>' +
          Object.entries(methodFields).map(([field, label]) => {
            const edit = edits[selected.id]?.fields[field];
            const current = editEvidence(selected.item, selected.method, summaries[selected.method.id], field);
            const evidence = (title, record) => '<details><summary>' + title + '</summary><p>' +
              escape(record.facts.join('、') || '尚無自動摘要') + '</p><pre>' + escape(record.sources.join('\n\n')) + '</pre></details>';
            return '<article><h2>' + label + '</h2>' +
              (edit && editChanged(edit.baseline, current) ? '<p role="status">來源或自動摘要已變更，請比對後確認。</p>' +
                evidence('保存個人修正時的依據', edit.baseline) : '') + evidence('目前自動摘要與來源', current) +
              '<form method="post">' + formFields(selected.id, field, selected.method.id) + '<label>個人修正<textarea name="text" maxlength="4000">' +
              escape(edit?.text ?? current.facts.join('\n')) + '</textarea></label><button name="action" value="save">保存修正</button>' +
              (edit ? '<button name="action" value="restore">還原自動摘要</button>' : '') + '</form></article>';
          }).join('') : '';
        return respond(200, page('修正摘要', '<nav>' + managementBack + '</nav><h1>修正摘要</h1>' +
          '<form method="get"><label>搜尋活動或方法 <input name="q" value="' + escape(query) + '"></label><button>搜尋</button></form>' +
          (selected ? '' : '<ul>' + methods.filter(({ item, method }) => (item.title + ' ' + method.title).includes(query))
            .map(({ item, method }) => '<li><a href="/edits?method=' + method.id + '">' + escape(item.title + ' › ' + method.title) + '</a></li>').join('') + '</ul>') +
          unavailable.map(([id, record]) => '<article><h2>' + escape(record.activity + ' › ' + record.method) +
            '</h2><p>來源歸屬待確認，已保留個人修正。</p>' + Object.entries(record.fields).map(([field, edit]) =>
              '<p>' + escape(methodFields[field] + ' · ' + edit.text) + '</p><form method="post">' + formFields(id, field) +
              '<button name="action" value="restore">移除個人修正</button></form>').join('') + '</article>').join('') + editor));
      }
      if (url.pathname === '/schedule') {
        if (req.method === 'GET') return respond(200, schedulePage(await scheduleState(), enableSchedule));
        if (req.method !== 'POST') throw new Problem('操作不支援。', 405);
        lockModel();
        const time = (await formData(req)).get('time');
        if (!validSchedule(time)) throw new Problem('請輸入有效的台北時間，格式為 HH:mm。');
        await saveSchedule({ ...await scheduleState(), time });
        return res.writeHead(303, { Location: '/schedule' }).end();
      }
      if (['/discover', '/discover/import', '/discover/retry', '/discover/continue', '/discover/removed'].includes(url.pathname) ||
          /^\/discover\/[a-f0-9]{24}(?:\/source)?$/.test(url.pathname)) {
        const registry = await discoveryRegistry();
        const base = await readSaved('activity-source.json') ?? await readSaved();
        const clock = now();
        const window = discoveryWindow(clock);
        const [, , key, subpage] = url.pathname.split('/');
        if (req.method === 'GET' && !key) return respond(200, discoveryPage(window, registry));
        if (req.method === 'POST') lockModel();
        if (req.method === 'POST' && key === 'removed') {
          const id = (await formData(req)).get('id') ?? '';
          const job = /^[a-f0-9]{24}$/.test(id) ? registry.queue?.[id] : undefined;
          if (job?.state !== 'failed') throw new Problem('找不到需重試的公告工作。', 404);
          job.state = 'removed';
          job.removedAt = clock.toISOString();
          if (registry.run) registry.run.failures = registry.run.failures.filter(entry => entry.id !== id);
          await save('discovery.json', JSON.stringify(registry));
          return res.writeHead(303, { Location: '/jobs' }).end();
        }
        if (req.method === 'POST' && (!key || ['import', 'retry', 'continue'].includes(key))) {
          if (key === 'import') {
            const input = (await formData(req)).get('url')?.trim() ?? '';
            const { work: [job] } = await discoveryWork(registry, base, clock, { mode: 'manual', input });
            if (job.state === 'failed') return respond(502, discoveryPage(window, registry, job.label + ' · ' + job.message));
            if (!job.saved) return respond(200, discoveryPage(window, registry, '這份公告未找到可對應已收錄活動的異動。'));
            return res.writeHead(303, { Location: '/discover/' + job.id }).end();
          }
          const input = key === 'retry' ? (await formData(req)).get('id') : undefined;
          const report = await discoveryWork(registry, base, clock, { mode: key, input });
          if (!key) {
            const state = await scheduleState();
            recordCheck(state, report, now().toISOString());
            await saveSchedule(state);
          }
          return res.writeHead(303, { Location: key ? '/jobs' : '/discover' }).end();
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
        return respond(200, page('來源與摘要更新', '<nav>' + managementBack + '</nav><h1>來源與摘要更新</h1>' +
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
        return respond(200, page('來源關聯與更正', '<nav>' + managementBack + '</nav><h1>來源關聯與更正</h1>' +
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
          return respond(error.status, managementPage(await readSaved(), status, Boolean(await readSaved('activity-source.json'))));
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
          watches: await readSaved('watches.json') ?? {},
          back: '/?' + new URLSearchParams(params),
          filters: {
            query,
            status: statuses.includes(params.get('state')) ? params.get('state') : '',
            type: rewardTypes.includes(params.get('type')) ? params.get('type') : '',
              watched: params.get('watched') === '1',
          },
        } : undefined;
        let assist;
        let status = 200;
        if (agentSearch) {
          try {
            if (!query || query.length > 200) throw new Problem('請輸入 1–200 字的搜尋句。');
            const candidates = listing ? searchCatalog(items, { ...listing.filters, query: '' }, now(), listing.images,
              { includeMethods: true }).filter(entry => !listing.filters.watched || listing.watches[watchKey(entry)]) : [];
            lockModel();
            assist = await searchWithAgent(query, candidates, playerAssistant(await preferredProvider(), codexGenerate, generatePlayerAssistance));
          } catch (error) {
            if (!(error instanceof Problem)) throw error;
            assist = { error: error.message };
            status = error.status;
          }
        }
        return respond(status, home(saved, query, now(), Boolean(source), listing, assist));
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
          const imageAction = '/activities/' + item.id + '/images/' + extra;
          const imageJobId = 'image-' + item.id + '-' + extra + '-' + action;
          const imageJob = { title: item.title + ' › 官方圖片 ' + (item.images.indexOf(imageUrl) + 1),
            activity: item.id, action: imageAction, fields: { action } };
          if (action !== 'remove' && (!record.version || action === 'download')) {
            let image;
            try { image = await downloadImage(imageUrl); }
            catch (error) {
              if (['download', 'select', 'recognize'].includes(action)) await writeJob(imageJobId, { ...imageJob, ...jobFailure(error, 'image') });
              throw error;
            }
            const { bytes, mime, version } = image;
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
            try {
              record.recognition = await summarizeImage({ bytes: await readFile(join(dir, 'image-' + record.version)), mime: record.mime });
            } catch (error) {
              await writeJob(imageJobId, { ...imageJob, provider: 'gemini', ...jobFailure(error, 'model') });
              throw error;
            }
            await save('official-images.json', JSON.stringify(imageRecords, null, 2));
          }
          if ((await readSaved('jobs.json'))?.[imageJobId]) {
            await writeJob(imageJobId, { ...imageJob, state: 'done', provider: action === 'recognize' ? 'gemini' : undefined,
              usage: action === 'recognize' ? record.recognition?.model?.usage ?? null : undefined });
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
        if (req.method === 'GET' && !methodId) return respond(200, activityDetail(item, now(), summaries, pending, imageRecords, preferred,
          await readSaved('watches.json') ?? {}, await readSaved('manual-edits.json') ?? {},
          (await readIssues(items)).filter(issue => issue.activities.some(activity => activity.id === item.id))));
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
          const form = await formData(req);
          const requestedProvider = form.get('provider');
          const provider = batch ? 'codex' : ['gemini', 'codex'].includes(requestedProvider) ? requestedProvider : preferred;
          const ids = batch ? [...new Set(form.getAll('method'))] : [target.id];
          const targets = item.methods.filter(entry => entry.kind === 'method' && ids.includes(entry.id));
          if (!targets.length || targets.length !== ids.length) throw new Problem('請選擇本活動的取得方法。');
          const jobs = await readSaved('jobs.json') ?? {};
          const jobId = target => 'method-' + target.id + '-' + provider;
          for (const target of targets) {
            jobs[jobId(target)] = { id: jobId(target), title: item.title + ' › ' + target.title, activity: item.id,
              provider, state: 'pending', action: '/activities/' + item.id + '/' + (batch ? 'batch' : target.id),
              fields: batch ? { method: target.id } : { provider } };
          }
          await save('jobs.json', JSON.stringify(jobs));
          for (const target of targets.slice(0, METHOD_BATCH)) {
            const job = jobs[jobId(target)];
            activeJobId = job.id;
            let generated;
            try {
              const inputKey = methodFingerprint(item, target, imageRecords, provider, provider === 'codex' ? CODEX_MODEL : process.env.GEMINI_MODEL);
              if (summaries[target.id]?.inputKey === inputKey) {
                Object.assign(job, { state: 'done', usage: summaries[target.id].model?.usage ?? null });
                await save('jobs.json', JSON.stringify(jobs));
                continue;
              }
              const sources = methodContext(item, target);
              const input = { title: item.title, method: target.title, sources };
              generated = provider === 'codex' ? await summarizeMethod(input, async (instruction, input, properties) => {
                const parts = [{ text: JSON.stringify(input) }];
                for (const imageUrl of new Set([...target.images, ...(item.sharedImages ?? [])])) {
                  const record = imageRecords[imageKey(imageUrl)];
                  if (!record?.selected || item.shopImages?.includes(imageUrl)) continue;
                  const bytes = record.version ? await readFile(join(dir, 'image-' + record.version)).catch(() => null) : null;
                  if (!bytes) throw Object.assign(new Problem('請先保存已選入的官方原圖，再重試摘要。'), { missingImage: true });
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
              Object.assign(job, { state: 'done', usage: generated.metadata?.usage ?? null });
              await save('jobs.json', JSON.stringify(jobs));
            } catch (error) {
              Object.assign(job, jobFailure(error, error.missingImage ? 'image' : 'model'));
              job.usage ??= generated?.metadata?.usage ?? null;
              await save('jobs.json', JSON.stringify(jobs));
              throw error;
            }
          }
          if (batch && (await readSaved('pending-codex-batch.json'))?.activity === item.id) await save('pending-codex-batch.json', 'null');
          return res.writeHead(303, { Location: targets.length > METHOD_BATCH ? '/jobs' : '/activities/' + item.id + '#' + targets[0].id }).end();
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
        '</p><p><a href="/">回首頁</a> · <a href="/jobs">批次進度與重試</a></p>'));
    } finally {
      if (methodLocked) {
        importing = false;
        activeJobId = null;
      }
    }
  });
  if (enableSchedule) {
    let timer;
    const tick = () => runSchedule().catch(error => console.error('每日排程未能保存狀態：' + error.message));
    server.on('listening', () => {
      timer = setInterval(tick, scheduleInterval);
      timer.unref();
      void tick();
    });
    server.on('close', () => clearInterval(timer));
  }
  return server;
}
