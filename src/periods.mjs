const sourceDate = /(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g;
const taipei = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' });

function endpoint(match, years) {
  const [, explicit, month, day, hour, minute] = match;
  const possible = (explicit ? [explicit] : years).flatMap(year => {
    const date = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
    const utc = new Date(date + 'T00:00:00Z');
    return Number.isFinite(+utc) && utc.toISOString().startsWith(date) ? [date] : [];
  });
  if (possible.length !== 1) return null;
  const uncertain = /維護[前後]/.test(match.input);
  const exact = hour !== undefined && !uncertain && Number(hour) < 24 && Number(minute) < 60
    ? Date.parse(possible[0] + 'T' + hour.padStart(2, '0') + ':' + minute + ':00+08:00') : null;
  return { date: possible[0], exact };
}

function range(source, years) {
  if (!source) return { source };
  const matches = [...source.text.matchAll(sourceDate)];
  const points = matches.map(match => endpoint(match, years));
  if (points.some(point => !point) || points.length > 2) return { source };
  if (points.length === 2 && points[0].date > points[1].date) return { source };
  const [first, last] = points;
  if (last) return { start: first, end: last, source };
  if (first && /截止|期限|為止|維護前/.test(source.text)) return { end: first, source };
  if (first && /開始|開放|開領|維護後|起/.test(source.text)) return { start: first, source };
  return { source };
}

export function timeline(item, method) {
  const version = item.sources.find(source => source.scope.startsWith('版本共用期間'));
  const years = [...new Set([...(version?.text ?? '').matchAll(/(\d{4})\//g)].map(match => match[1]))];
  const sourceYears = years.length === 1 ? years : [];
  const own = method ? item.sources.filter(source => method.sourceIds.includes(source.id)) : item.local;
  const localDate = own.find(source => /^活動(?:日期|時間)|^參加(?:期間|時間|期限)/.test(source.text));
  const localClaim = own.find(source => /^(?:領獎|獎勵領取|領取)(?:期間|時間|期限|截止)/.test(source.text.replace(/^[^\p{L}\p{N}]+/u, '')));
  const localOpen = own.find(source => /^(?:開領|開放領取|獎勵開放領取)|(?:可在|可以在)\d{1,2}\/\d{1,2}維護後領取/.test(source.text));
  const base = method ? timeline(item) : null;
  const date = localDate ?? item.date;
  const permanent = /1900\/.*2100\//.test(date?.text ?? '');
  const participation = permanent ? { source: date, permanent } : range(date, sourceYears);
  return {
    participation,
    claim: localClaim ? range(localClaim, sourceYears) : base?.claim ?? { source: null },
    opening: localOpen ? range(localOpen, sourceYears) : base?.opening ?? { source: null },
    resets: own.filter(source => /初始化|重置/.test(source.text)),
  };
}

function compare(point, now) {
  if (!point) return null;
  if (point.exact !== null) return Math.sign(+now - point.exact);
  const today = taipei.format(now);
  return today === point.date ? null : today < point.date ? -1 : 1;
}

export function activityState(periods, now) {
  const { participation, claim, opening } = periods;
  if (participation.permanent) return '進行中';
  const start = compare(participation.start, now);
  const end = compare(participation.end, now);
  const claimStart = compare(claim.start ?? opening.start, now);
  const claimEnd = compare(claim.end, now);
  if (start === -1) return '尚未開始';
  if (start >= 0 && start !== null && end === -1) return '進行中';
  if (end >= 0 && end !== null) {
    if (claimStart === -1) return '尚未開領';
    if (claimEnd === -1 && (!(claim.start || opening.start) || claimStart !== null)) return '仍可領獎';
    if (claim.source && claimEnd === null) return '時間待確認';
    if (opening.source && !claim.source) return '時間待確認';
    return '已結束';
  }
  return '時間待確認';
}

export function periodText(period) {
  if (period.permanent) return '常駐活動';
  if (!period.source) return '公告未載明';
  const points = [period.start, period.end].filter(Boolean);
  if (!points.length) return period.source.text + '（時間待確認）';
  const year = points[0].date.slice(0, 4);
  const labels = points.map((point, index) => {
    const date = index && point.date.startsWith(year) ? point.date.slice(5) : point.date;
    return date.replaceAll('-', '/') + (point.exact === null ? '' : ' ' +
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(point.exact));
  });
  if (points.some(point => point.exact === null)) return labels.join(' ～ ') +
    (/維護[前後]/.test(period.source.text) ? '（' + period.source.text + '，時刻待確認）' : '（時刻未載明）');
  return labels.join(' ～ ');
}
