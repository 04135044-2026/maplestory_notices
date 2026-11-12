export const DEFAULT_SCHEDULE = '14:10';
export const validSchedule = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? '');

const taipei = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium',
});

export function dueCheck(now, state) {
  const [today, time] = taipei.format(now).split(' ');
  const scheduled = state.time ?? DEFAULT_SCHEDULE;
  const day = time.slice(0, 5) >= scheduled ? today :
    new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  const dueAt = Date.parse(day + 'T' + scheduled + ':00+08:00');
  if ((state.scheduled?.day ?? '') >= day) return null;
  if (day !== today && (!state.startedAt || dueAt < Date.parse(state.startedAt))) return null;
  return { day, type: +now - dueAt < 60000 ? 'scheduled' : 'catch-up' };
}
