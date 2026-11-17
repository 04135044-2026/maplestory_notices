import test from 'node:test';
import assert from 'node:assert/strict';
import { answerPlayer } from '../src/player-assist.mjs';

const url = 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=19129';
const eligibility = { id: 'qualification', scope: '應援參加資格', text: '角色至少 Lv200，兩種應援只能選一種。' };
const correction = { id: 'correction', scope: '已核對官方更正', text: '領獎期限更正為 2026/12/03。', url };
const header = ['角色等級', '每週獎勵', '數量'];
const rows = Array.from({ length: 20 }, (_, index) => ['Lv' + (index + 250), '獎勵' + index, String(index + 1)]);
const table = { id: 'table', scope: '每週獎勵表', rows: [header, ...rows], text: [header, ...rows].join('\n') };
const method = { id: 'cheer', kind: 'method', title: '燃燒之城應援', sourceIds: [table.id], sharedSourceIds: [eligibility.id, correction.id] };
const item = { id: 'event', title: '粉絲俱樂部招募', officialUrl: url, sources: [eligibility, table, correction], local: [], methods: [method] };

test('活動問答引用指定等級的獎勵列，並保留表頭、適用資格及官方更正', async () => {
  const rival = { ...table, id: 'rival-table', rows: [header, ...rows.map(row => [row[0], '另一隊獎勵', row[2]])] };
  const twoMethods = { ...item, sources: [rival, ...item.sources], methods: [
    { ...method, id: 'rival', title: '墮落雷霆應援', sourceIds: [rival.id] }, method,
  ] };
  const result = await answerPlayer(twoMethods, '燃燒之城應援 Lv260 的每週獎勵有哪些？', async (_task, input) => {
    const reward = input.sources.find(source => source.text.includes('Lv260 | 獎勵10 | 11'));
    assert.ok(reward);
    assert.ok(input.sources.length < rows.length);
    assert.match(reward.text, /^角色等級 \| 每週獎勵 \| 數量\n/);
    assert.ok(input.methods.find(method => method.title === '燃燒之城應援').sources.includes(reward.id));
    assert.ok(input.sources.every(source => !source.text.includes('另一隊獎勵')));
    assert.ok(input.sources.some(source => source.text === eligibility.text));
    assert.ok(input.sources.some(source => source.text === correction.text));
    return { result: { facts: [{ text: 'Lv260 可領獎勵10 ×11。', sources: [reward.id] }], incomplete: false } };
  }, [], () => assert.fail('等級與獎勵表已有明確命中'));
  assert.deepEqual(result.facts[0].sources[0].rows, [header, rows[10]]);
  assert.equal(result.facts[0].sources[0].url, url);
});

test('關鍵字不足時用向量補找已核對圖片，向量無候選仍可依文字標示待確認', async () => {
  const image = { id: 'image', methodId: method.id, scope: '官方圖片 · 已核對文字',
    text: '獎勵：星光寶座', image: '/images/verified' };
  const question = '有東西可以坐嗎？';
  const ask = async (_task, input) => {
    const source = input.sources.find(source => source.text === image.text);
    return { result: { facts: source ? [{ text: '有星光寶座。', sources: [source.id] }] : [],
      incomplete: !source } };
  };
  const found = await answerPlayer(item, question, ask, [image], async (candidates, query) => {
    assert.equal(query, question);
    return candidates.filter(candidate => candidate.source.id === image.id);
  });
  assert.equal(found.facts[0].sources[0].image, image.image);
  const unavailable = await answerPlayer(item, question, ask, [image], async () => []);
  assert.deepEqual(unavailable.facts, []);
  assert.equal(unavailable.incomplete, true);
});
