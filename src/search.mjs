import { methodContext } from './catalog.mjs';
import { activityState, timeline } from './periods.mjs';
import { imageKey } from './images.mjs';

export const rewardTypes = ['外觀與收藏', '成長與強化', '貨幣與點數', '其他'];
export const statuses = ['尚未開始', '進行中', '仍可領獎', '尚未開領', '時間待確認', '已結束'];

function rewardType(name) {
  if (/椅子|外觀|服裝|家具|帽子|勳章|背景|皮膚|髮型|臉型|海報|旗幟|名牌|聊天戒指/.test(name)) return rewardTypes[0];
  if (/寶石|方塊|符文|經驗|成長|強化|艾爾達|星火|技能|EXP|加速|卷軸/.test(name)) return rewardTypes[1];
  if (/硬幣|楓幣|點數|貨幣/.test(name)) return rewardTypes[2];
  return rewardTypes[3];
}

export function activityRewards(item, method) {
  const sources = methodContext(item, method).filter(source => method.sourceIds.includes(source.id) || item.local.includes(source));
  const possible = sources.some(source => /可能獲得的獎勵/.test(source.text));
  const rewards = [];
  const add = (name, quantity, source, group, typeContext = name) => {
    if (name && !rewards.some(reward => reward.name === name && reward.group === group)) {
      rewards.push({ name, quantity, source, possible, group, type: rewardType(typeContext) });
    }
  };
  for (const source of sources) {
    const rows = source.rows ?? [];
    if (rows[0]?.includes('Lv259以下') && rows[0]?.includes('Lv260以上')) {
      for (const row of rows.slice(2)) {
        for (const [index, level] of rows[0].entries()) {
          const [name, count] = row.slice(index * 2, index * 2 + 2);
          if (/^\d+$/.test(count)) add(name, count, source.id, level);
        }
      }
    } else if (rows[0]?.at(-2) === '獎勵' && rows[0]?.at(-1) === '數量') {
      for (const row of rows.slice(1)) {
        if (/^\d+$/.test(row.at(-1))) add(row.at(-2), row.at(-1), source.id);
      }
    } else {
      for (const match of source.text.matchAll(/(?:可(?:追加)?(?:領取|獲得)|並獲得|會獲得|取得)([^。；\n「]{0,15})「([^」]+)」/g)) {
        if (!match[1].includes('狩獵技能')) add(match[2], match[1].match(/(\d+)\s*個/)?.[1], source.id, undefined, match[0]);
      }
    }
  }
  return rewards;
}

export function searchCatalog(items, filters, now, images) {
  const { query, status, type } = filters;
  const needle = query.normalize('NFKC').toLocaleLowerCase('zh-TW');
  const match = name => name.normalize('NFKC').toLocaleLowerCase('zh-TW').includes(needle);
  const candidates = [];
  for (const item of items) {
    const periods = timeline(item);
    const state = activityState(periods, now);
    if (!type && (!status || status === state) && (!query || match(item.title))) candidates.push({ item, state, periods });
    if (!query && !type) continue;
    for (const method of item.methods.filter(method => method.kind === 'method')) {
      const methodPeriods = timeline(item, method);
      const methodState = activityState(methodPeriods, now);
      if (status && methodState !== status) continue;
      if (!type && query && !match(item.title) && match(method.title)) {
        candidates.push({ item, method, state: methodState, periods: methodPeriods });
      }
      for (const reward of activityRewards(item, method)) {
        if ((type && reward.type !== type) || (query && !match(reward.name))) continue;
        const image = [...method.images, ...(item.sharedImages ?? [])].map(imageKey)
          .find(key => images[key]?.appearance === reward.name && images[key]?.version && images[key]?.selected);
        candidates.push({ item, method, reward, state: methodState, periods: methodPeriods, image });
      }
    }
  }
  return candidates.sort((a, b) => {
    const priority = entry => entry.state === '已結束' ? 2 : entry.state === '時間待確認' ? 1 : 0;
    return priority(a) - priority(b) || (query ? Number(!a.reward) - Number(!b.reward) : 0);
  });
}
