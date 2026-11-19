/* 阿拉伯文字帖过滤：好友链路（filter-rules）与时间线链路（timeline-page）各测一遍。
 * 两条链路都能在 Node 里跑，不需要浏览器。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FilterRules = require(path.join(__dirname, '..', 'filter-rules.js'));
const root = path.join(__dirname, '..');

const AR_POST = 'مرحبا بكم جميعا، هذا منشور باللغة العربية عن اللعبة الجديدة';
const AR_SHORT = 'شكرا';
const ZH_POST = '今晚八点直播，开场想说一句 السلام عليكم 就开打';
const ZH_PURE = '进流量池了，过一会就 1000 浏览';
const EN_POST = 'the timeline scroll is a little too fast today';
const NUM_ONLY = '١٢٣٤٥ ٦٧٨٩';

async function main() {
  /* ---------- 判定函数 ---------- */
  assert.strictEqual(FilterRules.isArabicText(AR_POST), true, '纯阿语帖应判为阿语');
  assert.strictEqual(FilterRules.isArabicText(AR_SHORT), true, '短阿语（4 个字母）也应判为阿语');
  assert.strictEqual(FilterRules.isArabicText(ZH_POST), false, '中文帖夹一个阿语词不能误伤');
  assert.strictEqual(FilterRules.isArabicText(ZH_PURE), false, '纯中文帖不是阿语');
  assert.strictEqual(FilterRules.isArabicText(EN_POST), false, '英文帖不是阿语');
  assert.strictEqual(FilterRules.isArabicText(NUM_ONLY), false, '阿拉伯数字不是阿语字母');
  assert.strictEqual(FilterRules.isArabicText(''), false, '空文本不判阿语');

  /* ---------- 好友链路：filterPosts 直接丢掉阿语帖 ---------- */
  const now = new Date().toISOString();
  const posts = [
    { id: '1', url: 'https://x.com/a/status/1', handle: 'a', date: now, text: AR_POST, type: '原创' },
    { id: '2', url: 'https://x.com/a/status/2', handle: 'a', date: now, text: ZH_PURE, type: '原创' },
    { id: '3', url: 'https://x.com/b/status/3', handle: 'b', date: now, text: '', quoteText: AR_POST, type: '引用转发' },
    { id: '4', url: 'https://x.com/c/status/4', handle: 'c', date: now, text: EN_POST, type: '原创' }
  ];
  const kept = FilterRules.filterPosts(posts, { days: 7, maxPerUser: 5, includeQuotes: true });
  assert.deepStrictEqual(kept.map(p => p.id), ['2', '4'],
    '阿语原创帖与被引用内容是阿语的引用帖都要丢掉，中文/英文帖保留');

  /* 纯图帖没有正文时按引用内容判语种 */
  assert.strictEqual(FilterRules.isArabicPost({ text: '', quoteText: AR_POST }), true);
  assert.strictEqual(FilterRules.isArabicPost({ text: ZH_PURE, quoteText: AR_POST }), false,
    '自己的正文是中文时，引用里出现阿语不影响判定');

  /* ---------- 时间线链路：注入脚本里同样的判定 + 打标 ---------- */
  const src = fs.readFileSync(path.join(root, 'timeline-page.js'), 'utf8');
  const ctx = vm.createContext({ window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} }, document: { visibilityState: 'hidden' }, location: { pathname: '/home' }, URL, Event, setTimeout });
  vm.runInContext(src, ctx);
  const fn = ctx.window.__xfaTimeline;
  assert.strictEqual(typeof fn, 'function', '时间线执行器应挂到 window');
  assert.match(src, /arabic/, '注入脚本里应有 arabic 字段');
  assert.match(src, /isArabicText/, '注入脚本里应有语种判定');

  /* 造两张卡：一张阿语、一张中文，验证页面层只会把阿语那张排除在合格候选外 */
  const mk = spec => ({
    textContent: spec.text || '',
    innerText: spec.text || '',
    href: spec.href,
    getAttribute: k => (spec.attrs || {})[k] || null,
    parentElement: spec.parentElement || null,
    querySelector: sel => (spec.qs || {})[sel] || null,
    querySelectorAll: sel => (spec.qsa || {})[sel] || [],
    closest: sel => (sel === 'article' ? (spec.linkOwner ? spec.linkOwner.value : null) : null),
    getBoundingClientRect: () => ({ width: 20, height: 20, top: 0, bottom: 20 }),
    getClientRects: () => [{ width: 20, height: 20 }]
  });
  function card(handle, id, text, top) {
    const owner = { value: null };
    const statusLink = mk({ href: `https://x.com/${handle}/status/${id}`, linkOwner: owner });
    const replyBtn = mk({});
    const likeBtn = mk({});
    const row = mk({ qs: { '[data-testid="reply"]': replyBtn }, qsa: { span: [mk({ text: '800' })] } });
    likeBtn.parentElement = row;
    const article = mk({
      qsa: {
        'a[href*="/status/"]': [statusLink],
        '[data-testid="placementTracking"]': [],
        '[data-testid="socialContext"]': [],
        article: [],
        '[data-testid="reply"]': [replyBtn],
        '[data-testid="like"], [data-testid="unlike"]': [likeBtn]
      },
      qs: {
        '[data-testid="User-Name"]': mk({ qsa: { 'a[href^="/"]': [mk({ href: `https://x.com/${handle}` })], span: [mk({ text: handle })] } }),
        '[data-testid="tweetText"]': mk({ text }),
        'time[datetime]': mk({ attrs: { datetime: '2026-11-18T08:00:00.000Z' } })
      }
    });
    owner.value = article;
    article.getBoundingClientRect = () => ({ top: top || 0, bottom: (top || 0) + 400, height: 400 });
    article.scrollIntoView = () => {};
    return article;
  }
  const articles = [card('ar_friend', 501, AR_POST, 0), card('zh_friend', 502, ZH_PURE, 400)];
  const doc = {
    documentElement: { scrollHeight: 10000 },
    visibilityState: 'hidden',
    querySelectorAll: sel => (sel === 'article[data-testid="tweet"]' ? articles : [])
  };
  const ctx2 = vm.createContext({ window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} }, document: doc, location: { pathname: '/home', origin: 'https://x.com' }, URL, Event, setTimeout });
  vm.runInContext(src, ctx2);
  const r = await ctx2.window.__xfaTimeline({ maxScrolls: 2, pollMs: 20, waitMs: 40, minViews: 500, target: 5 });
  assert.strictEqual(r.ok, true, r.error);
  const ar = r.candidates.find(c => c.id === '501');
  const zh = r.candidates.find(c => c.id === '502');
  assert.strictEqual(ar.arabic, true, '阿语卡被标记');
  assert.strictEqual(zh.arabic, false, '中文卡不被标记');
  assert.strictEqual(r.hits, 1, '只有中文卡算合格候选');
  assert.match(r.diagnostic, /arab=1/, '诊断串记录阿语帖数量');

  console.log('PASS: Arabic-script filter applies to both roster (filterPosts) and timeline (page layer + hit count)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
