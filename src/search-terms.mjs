export const normalizeSearch = value => value.normalize('NFKC').toLocaleLowerCase('zh-TW')
  .replaceAll('露西妲', '露希妲').replaceAll('祕', '秘').replace(/\s+/gu, '');

const aliases = [
  [['附加', '附加方塊'], /珍貴附加方塊$/u],
  [['碎片'], /靈魂艾爾達碎片(?:\([^)]*\))?(?:交換券)?$/u],
  [['靈魂', '大靈魂'], /^靈魂艾爾達$/u],
  [['加速器'], /^vip加速器$/u],
  [['3倍券'], /^經驗值3倍券\(30分(?:鐘)?\)$/u],
  [['4倍券'], /^經驗值4倍券\(30分(?:鐘)?\)$/u],
  [['285水'], /^真究極成長秘藥(?:\([^)]*\))?$/u],
  [['260水'], /^真終極成長秘藥(?:\([^)]*\))?$/u],
  [['249水'], /^極限成長秘藥(?:\([^)]*\))?$/u],
  [['269水'], /^超越成長秘藥(?:\([^)]*\))?$/u],
  [['桑拿'], /^vip桑那使用券$/u],
  [['點裝', '套服'], /服裝|套服/u],
].flatMap(([terms, target]) => terms.map(term => ({ term: normalizeSearch(term), target })));

const categories = ['成長秘藥', '椅子', '服裝'];
const generic = new Set(['活動', '獎勵', '取得', '商店', '參與方式', '領取獎勵']);

export function rewardKeyword(reward, query) {
  const needle = normalizeSearch(query);
  const alias = aliases.find(({ term }) => term === needle);
  const name = normalizeSearch(reward.name);
  const category = normalizeSearch(reward.category ?? '');
  if (alias) return alias.target.test(name) || alias.target.test(category);
  return name.includes(needle) || category.includes(needle);
}

export function semanticKeywords(documents, query) {
  const input = normalizeSearch(query);
  if (input && !generic.has(input)) {
    const direct = documents.filter(({ entry }) => entry.reward && rewardKeyword(entry.reward, input));
    if (direct.length) return direct;
  }
  const terms = new Set([
    ...aliases.map(({ term }) => term), ...categories,
    ...documents.map(({ entry }) => normalizeSearch(entry.reward?.name ?? entry.method?.title ?? entry.item.title))
      .filter(term => term.length >= 2 && !generic.has(term)),
  ]);
  const term = [...terms].filter(term => input.includes(term)).sort((a, b) => b.length - a.length)[0];
  if (term) {
    const hits = documents.filter(({ entry }) => entry.reward && rewardKeyword(entry.reward, term));
    if (hits.length || aliases.some(alias => alias.term === term) || categories.includes(term)) return hits;
    return documents.filter(({ entry }) => !entry.reward && normalizeSearch(entry.method?.title ?? entry.item.title) === term);
  }
  return [];
}
