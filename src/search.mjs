import { methodContext } from './catalog.mjs';
import { activityState, rewardAvailability, timeline } from './periods.mjs';
import { imageKey } from './images.mjs';
import { normalizeSearch, rewardKeyword } from './search-terms.mjs';

export const rewardTypes = ['外觀與收藏', '成長與強化', '貨幣與點數', '其他'];
export const statuses = ['尚未開始', '進行中', '仍可領獎', '尚未開領', '時間待確認', '已結束'];

const appearanceCategory = /椅子|外觀|服裝|家具|帽子|勳章|背景|皮膚|髮型|臉型|海報|旗幟|名牌|聊天戒指/;

function rewardClassification(name, context) {
  const category = context?.match(appearanceCategory)?.[0] ?? name.match(appearanceCategory)?.[0];
  if (category) return { category, type: rewardTypes[0] };
  if (/寶石|方塊|符文|經驗|成長|強化|艾爾達|星火|技能|EXP|加速|卷軸/.test(name)) return { type: rewardTypes[1] };
  if (/硬幣|楓幣|點數|貨幣/.test(name)) return { type: rewardTypes[2] };
  return { type: rewardTypes[3] };
}

export function activityRewards(item, method, images = {}) {
  const sources = methodContext(item, method).filter(source => method.sourceIds.includes(source.id) || item.local.includes(source));
  const possible = sources.some(source => /可能獲得的獎勵/.test(source.text));
  const rewards = [];
  function add(name, quantity, source, { group, context, condition, imageSource } = {}) {
    if (!name) return;
    const reward = { name, quantity, source, possible: imageSource ? false : possible, group,
      ...rewardClassification(name, context), condition, imageSource };
    const index = rewards.findIndex(prior => prior.name === name && prior.group === group);
    if (index < 0) rewards.push(reward);
    else if ((!rewards[index].condition && condition) || (!rewards[index].category && reward.category)) {
      rewards[index] = { ...reward, quantity: reward.quantity ?? rewards[index].quantity,
        condition: condition ?? rewards[index].condition, category: reward.category ?? rewards[index].category,
        type: reward.category ? reward.type : rewards[index].type };
    }
  }
  for (const source of sources) {
    const rows = source.rows ?? [];
    if (rows[0]?.includes('Lv259以下') && rows[0]?.includes('Lv260以上')) {
      for (const row of rows.slice(2)) {
        for (const [index, group] of rows[0].entries()) {
          const [name, count] = row.slice(index * 2, index * 2 + 2);
          if (/^\d+$/.test(count)) add(name, count, source.id, { group });
        }
      }
    } else if (['獎勵', '獎勵名稱'].includes(rows[0]?.at(-2)) && rows[0]?.at(-1) === '數量') {
      for (const row of rows.slice(1)) {
        if (/^\d+$/.test(row.at(-1))) add(row.at(-2), row.at(-1), source.id, { context: row.at(-3) });
      }
    } else {
      for (const sentence of source.text.split(/[。；\n]/)) {
        for (const match of sentence.matchAll(/(可(?:追加)?(?:領取|獲得)|並獲得|會獲得|取得)([^。「」]{0,15})「([^」]+)」/g)) {
          const [, action, context, name] = match;
          if (context.includes('狩獵技能')) continue;
          const prefix = sentence.slice(0, match.index).replace(/^[^\p{L}\p{N}]+|[，,、\s]+$/gu, '');
          const condition = action.includes('追加') && prefix.endsWith('後') ? prefix : undefined;
          add(name, context.match(/(\d+)\s*個/)?.[1], source.id, { context, condition });
        }
      }
    }
  }
  const keys = new Set((item.images ?? []).map(imageKey));
  if (item.announcement) {
    for (const [key, record] of Object.entries(images)) {
      if (record.verifiedText?.[item.id]?.snapshot === item.discoverySnapshot) keys.add(key);
    }
  }
  for (const key of keys) {
    const record = images[key];
    const note = record?.verifiedText?.[item.id];
    if (!record?.version || note?.version !== record.version || note.methodId !== method.id ||
        item.announcement && note.snapshot !== item.discoverySnapshot) continue;
    for (const line of note.text.split(/\r?\n/)) {
      const match = line.match(/^獎勵[：:]\s*([^｜|]+?)(?:\s*[｜|]\s*(.+))?\s*$/u);
      if (!match) continue;
      const [, name, condition] = match;
      add(name.trim(), undefined, key, { condition: condition?.trim(), imageSource: key });
    }
  }
  return rewards;
}

export function searchCatalog(items, filters, now, images, { includeMethods = false, onlyAvailable = false } = {}) {
  const { query, status, type } = filters;
  const needle = normalizeSearch(query);
  const match = name => normalizeSearch(name).includes(needle);
  const rewardMatches = reward => rewardKeyword(reward, query);
  const candidates = [];
  const matchedRewardOwners = new Set();
  for (const item of items) {
    const periods = timeline(item);
    const state = activityState(periods, now);
    const methods = item.methods.filter(method => method.kind === 'method').map(method => {
      const periods = timeline(item, method);
      return { method, periods, state: activityState(periods, now), availability: onlyAvailable ? rewardAvailability(periods, now) : null };
    });
    const available = !onlyAvailable || (methods.length ? methods.some(entry => entry.availability) : rewardAvailability(periods, now));
    if (available && !type && (!status || status === state) && (!query || match(item.title))) candidates.push({ item, state, periods });
    if (!query && !type && !includeMethods) continue;
    for (const entry of methods) {
      const { method, availability } = entry;
      const rewards = activityRewards(item, method, images);
      if (onlyAvailable && query && rewards.some(rewardMatches)) {
        matchedRewardOwners.add(item);
        matchedRewardOwners.add(method);
      }
      if ((onlyAvailable && !availability) || (status && entry.state !== status)) continue;
      if (!type && ((!query && includeMethods) || (query && !match(item.title) && match(method.title)))) {
        candidates.push({ item, ...entry });
      }
      for (const reward of rewards) {
        if ((type && reward.type !== type) || (query && !rewardMatches(reward))) continue;
        const image = [...method.images, ...(item.sharedImages ?? [])].map(imageKey)
          .find(key => images[key]?.appearance === reward.name && images[key]?.version && images[key]?.selected);
        candidates.push({ item, ...entry, reward, image });
      }
    }
  }
  return candidates.filter(entry => entry.reward || !matchedRewardOwners.has(entry.method ?? entry.item)).sort((a, b) => {
    const priority = entry => entry.state === '已結束' ? 2 : entry.state === '時間待確認' ? 1 : 0;
    return priority(a) - priority(b) || (query ? Number(!a.reward) - Number(!b.reward) : 0);
  });
}
