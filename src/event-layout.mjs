import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { isPermanentDateLabel, phaseDateLabel } from './periods.mjs';
import { dateLabel, eligibilityLabel, noticeMetadata } from './segmentation.mjs';
import { mergeManual, reviewDocument } from './review.mjs';

const clean = text => text.trim().replace(/\s+/g, ' ');
const comparable = text => clean(text.normalize('NFKC')).replace(/[×x]/gi, '×');
const idFor = (prefix, value) => prefix + createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = values => [...new Set(values)];
const confirmedDateAliases = {
  '楓之谷學院': { '維多利亞船艇競賽': '楓之谷競速' },
};
const confirmedBodyTitles = {
  '星夜馬戲團in地球防衛總部': '星夜馬戲團',
  '挑戰者伺服器第二季': '挑戰者伺服器S2',
};
const confirmedPeerGroups = {
  '維多利亞盃': new Set(['運動會小遊戲', '運動會狩獵支援', '運動會拳擊機']),
};

function combineGameAndRewards(sections) {
  const [game, rewards] = sections;
  if (sections.length !== 2 || game.title !== '遊戲說明' || rewards.title !== '活動獎勵' ||
      !rewards.blocks.some(block => /根據遊戲結果獲得.*分數/.test(block.text)) ||
      !rewards.blocks.some(block => block.rows)) return sections;
  return [{ ...game, title: '遊戲玩法與獎勵', blocks: [...game.blocks, ...rewards.blocks],
    sectionHeadingIds: [game.blocks[0].id, rewards.blocks[0].id] }];
}

export function eventTitle($) {
  return clean($('.content h1, .bulletin_main h1, .box > .title > h1').first().text());
}

export const savedEventTitle = html => eventTitle(load(html));

export function reconcileEventReview(items, entries) {
  const manual = mergeManual([], entries.map(entry => {
    const destination = items.find(item => item.legacyActivityId === entry.id &&
      item.methods.some(method => method.legacyId === entry.methods[0].id));
    return destination ? { ...entry, id: destination.id, title: destination.title } : entry;
  }));
  const matching = (a, b) => comparable(a).replace(/\s/g, '') === comparable(b).replace(/\s/g, '');
  return manual.reduce((catalog, saved) => {
    const target = catalog.find(item => matching(item.title, saved.title));
    if (!target) {
      // An earlier review may store multiple official subactivities in one activity.
      const reviewedSections = new Set(saved.methods.map(method => comparable(method.title)));
      const covered = catalog.filter(item => reviewedSections.has(comparable(item.title)));
      if (!covered.length) return [...catalog, saved];
      const periods = covered[0].sources.filter(block => block.scope === '版本共用期間');
      return [...catalog.filter(item => !covered.includes(item)), {
        ...saved, sources: [...new Map([...saved.sources, ...periods].map(block => [block.id, block])).values()],
      }];
    }
    const sameMethod = (method, previous) => {
      if (method.legacyId === previous.id) return true;
      if (matching(previous.title, method.title)) return true;
      const overlap = method.sourceIds.filter(id => previous.sourceIds.includes(id)).length;
      return overlap > 0 && overlap >= Math.ceil(method.sourceIds.length / 2) &&
        overlap >= Math.ceil(previous.sourceIds.length / 2);
    };
    const additions = target.methods.filter(method => !saved.methods.some(previous => sameMethod(method, previous)));
    const reviewed = saved.methods.map(method => {
      const inferred = target.methods.find(candidate => sameMethod(candidate, method));
      return { groupTitle: inferred?.groupTitle, dateSourceId: inferred?.dateSourceId,
        inheritParticipation: inferred?.inheritParticipation, legacyId: inferred?.legacyId, ...method };
    });
    const sources = new Map([...target.sources, ...saved.sources].map(source => [source.id, source]));
    // Keep program scope metadata for periods while retaining every manually selected source.
    for (const source of target.sources) sources.set(source.id, source);
    return catalog.map(item => item === target ? {
      ...target, id: saved.id, methods: [...reviewed, ...additions], images: unique([...target.images, ...saved.images]),
      sources: [...sources.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    } : item);
  }, items);
}

function heading($, node, block, afterDivider) {
  if (!/^p$|^h[1-6]$/.test(node.tagName) || block.text.length > 80 || block.rows) return null;
  const bracketed = /^(?:【([^【】]+)】|〖([^〖〗]+)〗)$/.exec(block.text);
  const styled = $(node).find('[style]').addBack('[style]');
  const bold = styled.toArray().some(el => /font-weight:\s*(?:700|bold)\b/.test($(el).attr('style')));
  const large = styled.toArray().some(el => /font-size:\s*20pt\b/.test($(el).attr('style')));
  const anchor = $(node).find('[id]').toArray().some(el => !$(el).attr('id').startsWith('docs-internal-guid'));
  if (!/^h/.test(node.tagName) && !(bold && (bracketed || (large && afterDivider)))) return null;
  return { title: bracketed?.[1] ?? bracketed?.[2] ?? block.text, large, afterDivider, anchoredBoundary: anchor && afterDivider };
}

const asSources = (blocks, scope) => blocks.map(block => ({ ...block, scope }));
const localScope = '活動共用條件與說明';

export function splitEventPage(html, notice) {
  const shared = [];
  const sections = [{ blocks: [] }];
  let title;
  let valid = false;
  let divider;
  reviewDocument(html, ($, node, block) => {
    const container = $(node).closest('.content, .bulletin_main');
    if (!container.length) return;
    if (title === undefined) {
      title = eventTitle($);
      const labels = container.children('div').map((_, el) => clean($(el).children('h3').text())).get().filter(Boolean);
      valid = Boolean(title && labels.length >= 3 && /^活動時間[：:]$/.test(labels[0])
        && [title, confirmedBodyTitles[title]].filter(Boolean).some(name => comparable(labels[1]) === comparable(name))
        && labels.at(-1) === '注意事項' && labels.slice(2, -1).every(name => name === '編輯紀錄'));
    }
    if (!valid) return;
    const pane = $(node).parentsUntil(container).addBack().toArray().find(el => el.parent === container[0]);
    const label = clean($(pane).children('h3').text());
    if (node.tagName === 'h3' || !label) return;
    if (/^活動時間[：:]$/.test(label)) {
      if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(block.text)) shared.push(...asSources([block], '版本共用期間'));
      return;
    }
    if (label === '注意事項') {
      shared.push(...asSources([block], '共用注意事項'));
      return;
    }
    if (label === '編輯紀錄') {
      shared.push(...asSources([block], '編輯紀錄'));
      return;
    }
    const previous = $(node).prevAll().toArray().find(el => el.tagName === 'hr' || clean($(el).text()));
    if (previous?.tagName === 'hr') divider = true;
    const header = heading($, node, block, divider);
    if (header) {
      sections.push({ ...header, blocks: [block] });
      divider = false;
    } else {
      sections.at(-1).blocks.push(block);
      if (block.text) divider = false;
    }
  });
  if (!valid || shared.filter(source => source.scope === '版本共用期間').length !== 1) return [];
  const [intro, ...named] = sections;
  const qualification = section => section.blocks.find(block => eligibilityLabel.test(block.text));
  const date = section => section.blocks.find(block => dateLabel.test(block.text));
  const independent = named.filter(section => {
    const localDate = date(section);
    return localDate && (qualification(section) || isPermanentDateLabel(localDate.text));
  });
  if (!independent.length && !qualification(intro)) return [];
  const pageConditions = intro.blocks.filter(block => dateLabel.test(block.text) || eligibilityLabel.test(block.text));
  const activities = [];
  if (independent.length) {
    let current;
    let group;
    let peerGroup;
    let datedGroup;
    if (date(intro)) {
      current = { title, local: pageConditions, sections: [] };
      activities.push(current);
    }
    for (const [index, section] of named.entries()) {
      const next = named[index + 1];
      if (section.large) {
        datedGroup = !date(section) && !qualification(section) && next && !next.large && date(next) ? section.title : undefined;
        peerGroup = undefined;
      }
      const transfer = qualification(section) && section.blocks.some(block =>
        /最後可轉移時間為\d{4}年/.test(block.text));
      if (independent.includes(section) || (datedGroup && !section.large && date(section)) || transfer) {
        group = undefined;
        const local = section.blocks.filter(block => block === section.blocks[0] || block === date(section) ||
          block === qualification(section) || phaseDateLabel.test(block.text));
        const body = section.blocks.filter(block => !local.includes(block));
        current = { title: section.title, local, groupTitle: datedGroup, noSharedPeriod: Boolean(transfer),
          sections: body.length ? [{ title: '參與方式', blocks: body,
            reviewBoundary: transfer && !date(section) }] : [] };
        activities.push(current);
      } else if (datedGroup && section.title === datedGroup) {
        shared.push(...asSources(section.blocks, '活動分組'));
      } else if (current) {
        if (confirmedPeerGroups[title]?.has(section.title)) {
          peerGroup = { title: section.title, local: section.blocks, sections: [], noSharedPeriod: true };
          current.relatedGroups ??= [];
          current.relatedGroups.push(peerGroup.title);
          peerGroup.legacyTitle = current.title;
          activities.push(peerGroup);
          continue;
        }
        if (peerGroup) {
          peerGroup.sections.push(section);
          continue;
        }
        if (section.large) {
          group = section.afterDivider && qualification(section) && next && !next.large && !independent.includes(next)
            ? section.title : undefined;
        }
        if (group === section.title) current.sections.push({ ...section, group, groupOverview: true, keepMethodId: true,
          reviewBoundary: true });
        else current.sections.push(group ? { ...section, group, keepMethodId: true } : section);
      }
      else shared.push(...asSources(section.blocks, '活動歸屬待確認'));
    }
    shared.push(...asSources(intro.blocks, '版本共用條件與說明'));
  } else {
    const introContent = intro.blocks.filter(block => !pageConditions.includes(block));
    const activity = { title, local: pageConditions, sections: [] };
    activities.push(activity);
    const hasGroups = named.some((section, index) => section.large &&
      named[index + 1] && !named[index + 1].large && !named[index + 1].anchoredBoundary);
    const overview = introContent.filter(block => block.text);
    if (overview.length) {
      const reference = named.length && !overview.some(block => /獲得.*獎勵|[擲投]骰/.test(block.text));
      activity.sections.push({ title: reference ? '活動說明' : '參與方式', blocks: introContent, reference });
    } else activity.local.push(...introContent);
    let group;
    for (const section of named) {
      if (hasGroups && (section.large || section.anchoredBoundary)) {
        group = section.title;
        const index = named.indexOf(section);
        if (named[index + 1] && !named[index + 1].large && !named[index + 1].anchoredBoundary) {
          if (section.blocks.length > 1) activity.sections.push({ ...section, group, groupOverview: true, reference: true });
          continue;
        }
        activity.sections.push(section);
      } else activity.sections.push({ ...section, group: section.afterDivider ? undefined : group });
    }
  }
  const seen = new Set();
  return activities.flatMap(({ title: activityTitle, local, sections, groupTitle, relatedGroups, legacyTitle, noSharedPeriod }, sourceOrder) => {
    const methods = combineGameAndRewards(sections);
    const id = idFor('beanfun-event-', notice.url + '\n' + activityTitle);
    if (seen.has(id)) return [];
    seen.add(id);
    const conditions = [...shared, ...asSources(local, localScope)];
    const sources = [...conditions];
    const warnings = shared.filter(block => block.scope === '活動歸屬待確認')
      .map(block => block.id + ' 的活動歸屬待確認。');
    const groups = new Map(methods.filter(section => section.groupOverview).map(section => [section.group, section]));
    const methodsSeen = new Set();
    const scopedMethods = (methods.length ? methods : [{ title: '參與方式', blocks: [] }]).flatMap(section => {
      const methodId = idFor(id + '-method-', [section.keepMethodId ? undefined : section.group, section.title].join('\n'));
      if (methodsSeen.has(methodId)) {
        warnings.push('「' + section.title + '」有重複標題，請核對段落 ' + section.blocks.map(block => block.id).join('、') + '。');
        sources.push(...asSources(section.blocks, '活動歸屬待確認'));
        return [];
      }
      methodsSeen.add(methodId);
      const scoped = asSources(section.blocks, section.group ? section.group + ' › ' + section.title : section.title);
      sources.push(...scoped);
      if (section.reviewBoundary) warnings.push(section.title === '參與方式'
        ? '「' + activityTitle + '」的日期可能超出公告共用期間，請核對適用範圍。'
        : '「' + section.title + '」有獨立資格，請核對是否與「' + activityTitle + '」並列。');
      const separateShopUpdate = /商店/.test(section.title) && scoped.some(block => /版本更新後.*新增/.test(block.text));
      const groupBlocks = groups.get(section.group)?.blocks ?? [];
      const groupEligibility = groupBlocks.find(block => eligibilityLabel.test(block.text));
      const applicableConditions = groupEligibility ? conditions.filter(block =>
        block.scope !== localScope || (!eligibilityLabel.test(block.text) && !dateLabel.test(block.text) &&
          !phaseDateLabel.test(block.text))) : conditions;
      const dateTitle = confirmedDateAliases[title]?.[section.title] ?? section.title;
      const groupDate = groupBlocks.find(block => block.text.startsWith('└') && block.text.includes(dateTitle + '：')
        && /\d+\/\d+.*[~～]/.test(block.text));
      if (!groupDate && groupBlocks.some(block => block.text.startsWith('└') && /\d+\/\d+.*[~～]/.test(block.text))
        && scoped.some(block => /排名|積分/.test(block.text)) && !section.groupOverview) {
        warnings.push('「' + section.title + '」的分批日期待確認。對照 ' +
          groupBlocks.filter(block => block.text.startsWith('└') && /\d+\/\d+.*[~～]/.test(block.text)).map(block => block.id).join('、') + '。');
      }
      return {
        id: methodId, title: section.title, groupTitle: section.group, kind: section.reference || separateShopUpdate ||
          /^關於/.test(section.title) ? 'reference' : 'method',
        legacyId: legacyTitle && idFor(idFor('beanfun-event-', notice.url + '\n' + legacyTitle) + '-method-', '\n' + section.title),
        reviewBoundary: section.reviewBoundary,
        sourceIds: scoped.map(block => block.id),
        sharedSourceIds: separateShopUpdate ? [] : unique([...applicableConditions, ...groupBlocks.filter(block =>
          !block.text.startsWith('└') || !/\d+\/\d+.*[~～]/.test(block.text) || block === groupDate)].map(block => block.id)),
        dateSourceId: groupDate?.id,
        sectionHeadingIds: section.sectionHeadingIds,
        inheritParticipation: !separateShopUpdate && !groupEligibility,
        images: unique(scoped.flatMap(block => block.images)),
      };
    });
    const byOrder = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    sources.sort(byOrder);
    return [{
      id, title: activityTitle, pageTitle: title, officialUrl: notice.url, sourceOrder, groupTitle, noSharedPeriod,
      legacyActivityId: legacyTitle && idFor('beanfun-event-', notice.url + '\n' + legacyTitle),
      legacyGroupId: legacyTitle && idFor(idFor('beanfun-event-', notice.url + '\n' + legacyTitle) + '-method-', '\n' + activityTitle),
      relatedGroupIds: relatedGroups?.map(name => idFor('beanfun-event-', notice.url + '\n' + name)),
      ...noticeMetadata(html, title), template: 'beanfun-event-layout-v1', sources,
      methods: scopedMethods, local: conditions.filter(block => block.scope === localScope),
      eligibility: qualification({ blocks: local }), date: date({ blocks: local }),
      images: unique(sources.flatMap(block => block.images)), sharedImages: unique(local.flatMap(block => block.images)),
      shopImages: unique(scopedMethods.filter(method => /商店/.test(method.title)).flatMap(method => method.images)),
      warnings,
    }];
  });
}
