const sourceDate = /(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g;
const taipei = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' });

export const isPermanentDateLabel = text => /^活動(?:日期|時間)[：:]\s*永久[。.]?$/.test(text);
export const phaseDateLabel = /^第[一二三四五六七八九十\d]+波[：:]\s*(?=(?:\d{4}\/)?\d{1,2}\/\d{1,2})/;

function endpoint(match, years, bounds) {
  const [, explicit, month, day, hour, minute] = match;
  const possible = (explicit ? [explicit] : years).flatMap(year => {
    const date = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
    const utc = new Date(date + 'T00:00:00Z');
    const inBounds = explicit || !bounds || (date >= bounds.start.date && date <= bounds.end.date);
    return inBounds && Number.isFinite(+utc) && utc.toISOString().startsWith(date) ? [date] : [];
  });
  if (possible.length !== 1) return null;
  const uncertain = /^\s*維護[前後]/.test(match.input.slice(match.index + match[0].length));
  const exact = hour !== undefined && !uncertain && Number(hour) < 24 && Number(minute) < 60
    ? Date.parse(possible[0] + 'T' + hour.padStart(2, '0') + ':' + minute + ':00+08:00') : null;
  return { date: possible[0], exact };
}

function range(source, years, bounds) {
  if (!source) return { source };
  const text = source.text.replace(/\s*[（(](?:\d{4}\/)?\d{1,2}\/\d{1,2}\s*(?:編輯|更新)[）)]\s*[。.]?$/, '');
  const matches = [...text.matchAll(sourceDate)];
  const points = matches.map(match => endpoint(match, years, bounds));
  if (points.some(point => !point) || points.length > 2) return { source };
  if (points.length === 2 && points[0].date > points[1].date) return { source };
  const [first, last] = points;
  if (last) return { start: first, end: last, source };
  if (first && /截止|期限|為止|維護前|維持至|持續至|到期|可領取時間.*至|可領取時間.*~/.test(source.text)) return { end: first, source };
  if (first && /開始|開放|開領|維護後|起/.test(source.text)) return { start: first, source };
  return { source };
}

export function versionPeriod(item) {
  return range(item.sources.find(source => source.scope.startsWith('版本共用期間')), []);
}

export function timeline(item, method) {
  const manualRanges = item.template === 'manual-v1' ? item.local.filter(source =>
    /^\d{4}\/\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*[~～]\s*\d{4}\/\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?$/.test(source.text)
    && !/1900\/.*2100\//.test(source.text)) : [];
  const manualRange = manualRanges.length === 1 ? manualRanges[0] : undefined;
  const version = item.sources.find(source => source.scope.startsWith('版本共用期間')) ?? manualRange;
  const years = [...new Set([...(version?.text ?? '').matchAll(/(\d{4})\//g)].map(match => match[1]))];
  const shared = range(version, []);
  const bounds = shared.start && shared.end && !/1900\/.*2100\//.test(version?.text ?? '') ? shared : undefined;
  const sourceYears = bounds ? years : [];
  const own = method ? item.sources.filter(source => method.sourceIds.includes(source.id)) : item.local;
  const localDate = own.find(source => /^(?:活動(?:日期|時間)|參加(?:期間|時間|期限)|活動從\d)/.test(
    source.text.replace(/^[^\p{L}\p{N}]+/u, ''))) ?? item.sources.find(source => source.id === method?.dateSourceId);
  const localClaim = own.find(source => !source.rows && (/^(?:領獎|獎勵領取|領取|(?:排行|排名)獎勵可領取)(?:期間|時間|期限|截止)/.test(
    source.text.replace(/^[^\p{L}\p{N}]+/u, '')) || /可領取時間為|可以領取排名獎勵/.test(source.text)));
  const effect = own.find(source => !source.rows && /(?:Buff|效果).*(?:維持至|持續至|到期)/i.test(source.text));
  const localOpen = own.find(source => /^(?:開領|開放領取|獎勵開放領取)|(?:可在|可以在)\d{1,2}\/\d{1,2}維護後領取/.test(source.text));
  const base = method ? timeline(item) : null;
  const date = localDate ?? item.date ?? manualRange;
  const permanent = isPermanentDateLabel(date?.text ?? '') || /1900\/.*2100\//.test(date?.text ?? '');
  let participation = permanent ? { source: date, permanent } : date ? range(date, sourceYears, bounds) :
    item.template === 'beanfun-event-layout-v1' && !item.noSharedPeriod ? shared : { source: date };
  if (!method && item.noSharedPeriod && !date) {
    const transfer = item.sources.find(source => !source.rows &&
      /\d{4}年\d{1,2}月\d{1,2}日之後.*最後可轉移時間為\d{4}年\d{1,2}月\d{1,2}日/.test(source.text));
    if (transfer) {
      participation = { ...range({ ...transfer, text: transfer.text.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, '$1/$2/$3') }, []),
        source: transfer };
    }
  }
  if (date && own.includes(date) && /^活動(?:日期|時間)[：:]$/.test(date.text)) {
    const phases = [];
    for (const source of own.slice(own.indexOf(date) + 1)) {
      if (!phaseDateLabel.test(source.text)) break;
      phases.push(range(source, sourceYears, bounds));
    }
    if (phases.length && phases.every(phase => phase.start && phase.end)) {
      const contiguous = phases.every((phase, index) => !index ||
        Date.parse(phase.start.date) - Date.parse(phases[index - 1].end.date) === 86400000);
      participation = { source: date, phases, ...(contiguous ? { start: phases[0].start, end: phases.at(-1).end } : {}) };
    }
  }
  if (!method && !participation.phases && (manualRange || item.template === 'beanfun-event-layout-v1') && date !== version && participation.start && participation.end &&
      participation.start.date === shared.start?.date &&
      participation.end?.date === shared.end?.date) participation = shared;
  if (method && !localDate) participation = method.inheritParticipation === false ? {} : base.participation;
  if (method && localDate && participation.start && !participation.end && base.participation.end &&
      participation.start.date <= base.participation.end.date && /開始|維護後/.test(localDate.text)) {
    participation = { ...participation, end: base.participation.end };
  }
  const outsideParticipation = item.template === 'beanfun-event-layout-v1' && years.length === 1;
  const deadlineBounds = outsideParticipation ? undefined : bounds;
  const makeup = own.filter(source => !source.rows && /補完|補簽|補領/.test(source.text) &&
    /\d{1,2}\/\d{1,2}.*(?:維護後|起|開始|截止|為止)/.test(source.text))
    .map(source => range(source, sourceYears, deadlineBounds));
  const claim = localClaim ? range(localClaim, sourceYears, deadlineBounds) : base?.claim ?? { source: null };
  if (claim.end && !claim.start && /自活動開始|為活動開始/.test(localClaim?.text ?? '') && participation.start) {
    claim.start = participation.start;
  }
  const corrected = (period, change) => {
    if (!change) return period;
    const end = endpoint([...change.endText.matchAll(sourceDate)][0], []);
    if (!end || (period.start && end.date < period.start.date)) return period;
    return { ...period, end, permanent: false, original: period, change, source: period.source ?? { text: change.quote } };
  };
  return {
    participation: method ? participation : corrected(participation, item.changes?.participation),
    claim: claim.change ? claim : corrected(claim, localClaim && method ? null : item.changes?.claim),
    opening: localOpen ? range(localOpen, sourceYears, bounds) : base?.opening ?? { source: null },
    effect: range(effect, sourceYears, deadlineBounds),
    makeup: method ? [...(base.makeup ?? []), ...makeup.filter(rule => !base.makeup.some(entry => entry.source.id === rule.source.id))] : makeup,
    resets: own.filter(source => !source.rows && /初始化|重置/.test(source.text)),
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
  if (period.phases) return period.phases.map(phase => phase.source.text.match(phaseDateLabel)[0] + periodText(phase)).join('；');
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
