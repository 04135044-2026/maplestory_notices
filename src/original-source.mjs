import { createHash } from 'node:crypto';
import { load } from 'cheerio';

const headings = /^h[1-6]$/;
const containers = new Set(['main', 'div', 'section', 'article', 'header', 'footer', 'aside', 'p', 'blockquote', 'ul', 'ol', 'li', 'br', 'hr']);
const tableTags = new Set(['table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'br', 'p', 'ul', 'ol', 'li']);
export const officialImageOrigins = [
  'https://tw.hicdn.beanfun.com', 'https://beanfun-event.beanfun.com',
  'https://maplestory-event.beanfun.com', 'https://maplestory.beanfun.com',
];
const compact = text => text.replace(/\s+/g, ' ').trim();

export function originalBlocks(html, url) {
  const $ = load(html);
  $('script,style,iframe,object,embed,noscript,template,form,svg').remove();
  const mains = $('body').find('main, article.bulletin_main')
    .filter((_, node) => !$(node).parents('main, article.bulletin_main').length).toArray();
  const roots = mains.length ? mains : $('body').toArray();
  const blocks = [];
  const version = createHash('sha256').update(html).digest('hex').slice(0, 12);
  const add = block => blocks.push({ ...block, id: 'original-' + version + '-' + (blocks.length + 1) });

  function imageAt(node) {
    for (const field of ['data-src', 'src']) {
      const value = $(node).attr(field);
      if (!value) continue;
      try {
        const image = new URL(value, url);
        if (officialImageOrigins.includes(image.origin) && !image.username && !image.password) {
          return { image: image.href, text: $(node).attr('alt') ?? '' };
        }
      } catch {
        // Try the remaining image attribute.
      }
    }
  }

  function tableParts(nodes) {
    return nodes.flatMap(node => {
      if (node.type === 'text') return [node.data];
      if (node.type !== 'tag') return [];
      if (node.tagName === 'img') {
        const image = imageAt(node);
        return image ? [image] : [];
      }
      const children = tableParts(node.children ?? []);
      if (!tableTags.has(node.tagName)) return children;
      const cell = node.tagName === 'th' || node.tagName === 'td';
      return [{ tag: node.tagName, children, colspan: cell ? Number($(node).attr('colspan')) : undefined,
        rowspan: cell ? Number($(node).attr('rowspan')) : undefined }];
    });
  }

  function walk(nodes) {
    let pending = '';
    const flush = () => {
      const text = compact(pending);
      if (text) add({ text });
      pending = '';
    };
    for (const node of nodes) {
      if (node.type === 'text') { pending += node.data; continue; }
      if (node.type !== 'tag') continue;
      const tag = node.tagName;
      if (tag === 'img') {
        flush();
        const image = imageAt(node);
        if (image) add(image);
      } else if (tag === 'table') {
        flush();
        add({ table: tableParts([node]) });
      } else if (headings.test(tag)) {
        flush();
        const text = compact($(node).text());
        if (text) add({ heading: true, text });
        $(node).find('img').each((_, img) => {
          const image = imageAt(img);
          if (image) add(image);
        });
      } else if (containers.has(tag) || $(node).find('img,table,div,section,p,h1,h2,h3,h4,h5,h6').length) {
        flush();
        walk(node.children ?? []);
      } else pending += $(node).text();
    }
    flush();
  }
  for (const root of roots) walk(root.children ?? []);
  return blocks;
}
