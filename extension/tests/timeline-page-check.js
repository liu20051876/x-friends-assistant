/* 时间线采集执行器单测：node tests/timeline-page-check.js
 * 覆盖卡片解析、广告/纯转发标记、引用帖、回复按钮门控、id 去重、路由门与结束停止。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeEl(spec = {}) {
  return {
    getBoundingClientRect: () => ({ width: spec.visible === false ? 0 : 10, height: spec.visible === false ? 0 : 10, top: 0, bottom: 10 }),
    getClientRects: () => ({ length: spec.visible === false ? 0 : 1 }),
    getAttribute: name => spec.attrs?.[name] ?? null,
    href: spec.href || '',
    textContent: spec.text || '',
    innerText: spec.innerText ?? spec.text ?? '',
    parentElement: spec.parentElement || null,
    querySelector: sel => (spec.qs || {})[sel] || null,
    querySelectorAll: sel => (spec.qsa || {})[sel] || [],
    closest: sel => (sel === 'article' ? (spec.linkOwner ? spec.linkOwner.value : null) : null)
  };
}

const VIEWS_TEXT = { alice: '535', promoted: '3.6M', repost: '535', quoted: '1.2万', noreply: '535', dup: '535', nouser: null, quoteonly: null, low: '42', comma: '1,234', arabic: '900', mixed: '640' };
/* 语种样本：纯阿语帖要拦，中文帖里夹带一个阿语词不能误伤 */
const TEXT_BY_KIND = {
  arabic: 'مرحبا بكم جميعا، هذا منشور باللغة العربية عن اللعبة الجديدة',
  mixed: '今晚八点直播，开场想说一句 السلام عليكم 就开打'
};

function articleEl(kind) {
  const handle = kind === 'bob' ? 'bob' : kind === 'low' ? 'erin' : 'alice';
  const idByKind = { alice: 123, dup: 123, promoted: 124, repost: 125, quoted: 126, noreply: 127, bob: 456, nouser: 128, quoteonly: 129, low: 777, comma: 888, arabic: 130, mixed: 131 };
  const statusId = idByKind[kind];
  const userCell = makeEl({
    qsa: {
      'a[href^="/"]': [makeEl({ href: `https://x.com/${handle}` })],
      span: [makeEl({ text: handle === 'alice' ? 'Alice' : 'Bob' })]
    }
  });
  const ownOwner = { value: null };
  const ownLink = makeEl({ href: `https://x.com/${handle}/status/${statusId}`, linkOwner: ownOwner });
  // 引用帖里的嵌套链接：属于另一篇 article，不能当成本卡 id
  const nestedOwner = { value: makeEl({}) };
  const nestedLink = makeEl({ href: 'https://x.com/carol/status/999', linkOwner: nestedOwner });

  /* 动作行：点赞按钮的直接父级，里面放回复按钮和柱状图浏览数（浏览数不在按钮内） */
  const replyBtn = makeEl({ visible: kind !== 'noreply' });
  const likeBtn = makeEl({});
  const viewsText = VIEWS_TEXT[kind];
  const row = makeEl({
    qs: { '[data-testid="reply"]': replyBtn },
    qsa: { span: viewsText ? [makeEl({ text: viewsText })] : [] }
  });
  likeBtn.parentElement = row;
  const qsa = {
    'a[href*="/status/"]': kind === 'quoteonly' ? [nestedLink] : [ownLink],
    '[data-testid="placementTracking"]': kind === 'promoted' ? [makeEl({})] : [],
    '[data-testid="socialContext"], span': kind === 'repost' ? [makeEl({ text: 'Bob reposted' })] : [],
    '[data-testid="socialContext"]': kind === 'repost' ? [makeEl({ text: 'Bob reposted' })] : [],
    article: kind === 'quoted' ? [makeEl({})] : [],
    '[data-testid="reply"]': [replyBtn],
    '[data-testid="like"], [data-testid="unlike"]': [likeBtn]
  };
  const qs = {
    '[data-testid="User-Name"]': kind === 'nouser' ? null : userCell,
    '[data-testid="tweetText"]': makeEl({ text: TEXT_BY_KIND[kind] || 'hello world timeline' }),
    'time[datetime]': makeEl({ attrs: { datetime: '2026-11-07T08:00:00.000Z' } })
  };
  const article = makeEl({ qsa, qs });
  ownOwner.value = article;
  return article;
}

/* 构造一张最小可用卡片：用于模拟「长卡片 + 虚拟列表」的真实首页结构。 */
function cardEl({ handle, id, views }) {
  const userCell = makeEl({
    qsa: {
      'a[href^="/"]': [makeEl({ href: `https://x.com/${handle}` })],
      span: [makeEl({ text: handle })]
    }
  });
  const owner = { value: null };
  const statusLink = makeEl({ href: `https://x.com/${handle}/status/${id}`, linkOwner: owner });
  const replyBtn = makeEl({});
  const likeBtn = makeEl({});
  const viewsSpan = views == null ? null : makeEl({ text: String(views) });
  const row = makeEl({ qs: { '[data-testid="reply"]': replyBtn }, qsa: { span: viewsSpan ? [viewsSpan] : [] } });
  likeBtn.parentElement = row;
  const article = makeEl({
    qsa: {
      'a[href*="/status/"]': [statusLink],
      '[data-testid="placementTracking"]': [],
      '[data-testid="socialContext"]': [],
      article: [],
      '[data-testid="reply"]': [replyBtn],
      '[data-testid="like"], [data-testid="unlike"]': [likeBtn]
    },
    qs: {
      '[data-testid="User-Name"]': userCell,
      '[data-testid="tweetText"]': makeEl({ text: 'post ' + id }),
      'time[datetime]': makeEl({ attrs: { datetime: '2026-11-07T08:00:00.000Z' } })
    }
  });
  owner.value = article;
  return article;
}

/* 模拟真实首页：卡片很高（cardHeight），虚拟列表只保留视口附近几张，
 * 滚动会真的改变 scrollY 并触达后面的卡片。 */
async function runVirtualTimeline({ count, cardHeight, args }) {
  const cards = [];
  for (let i = 0; i < count; i++) cards.push(cardEl({ handle: 'u' + i, id: 2000 + i, views: 1000 }));
  const state = { scrollY: 0, height: count * cardHeight };
  const win = {
    innerHeight: 800,
    get scrollY() { return state.scrollY; },
    scrollTo(o) { state.scrollY = Math.min(Math.max(0, o.top || 0), state.height - 800); },
    scrollBy(_, dy) { state.scrollY = Math.min(Math.max(0, state.scrollY + dy), state.height - 800); },
    dispatchEvent() {}
  };
  /* 给每张卡真实的几何信息与 scrollIntoView：真实 X 上这个调用会把
   * 「最后一张卡」贴到视口底部，长卡片因此可能一次跳两屏多——这正是要防的。 */
  cards.forEach((c, i) => {
    const top = i * cardHeight;
    c.getBoundingClientRect = () => ({ top: top - state.scrollY, bottom: top + cardHeight - state.scrollY, height: cardHeight });
    c.scrollIntoView = () => { state.scrollY = Math.min(Math.max(0, top + cardHeight - 800), state.height - 800); };
  });
  const document = {
    documentElement: { get scrollHeight() { return state.height; } },
    visibilityState: 'visible',
    querySelectorAll: sel => {
      if (sel !== 'article[data-testid="tweet"]') return [];
      const first = Math.max(0, Math.floor(state.scrollY / cardHeight) - 1);
      return cards.slice(first, first + 4); // 虚拟窗口：只渲染眼前几张
    }
  };
  const ctx = vm.createContext({ window: win, document, location: { pathname: '/home', origin: 'https://x.com' }, URL, Event, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'timeline-page.js'), 'utf8'), ctx);
  return ctx.window.__xfaTimeline(args || {});
}

async function runTimeline({ pathname, articles, args }) {
  const document = {
    documentElement: { scrollHeight: 10000 },
    visibilityState: 'hidden',
    querySelectorAll: sel => sel === 'article[data-testid="tweet"]' ? articles : []
  };
  const ctx = vm.createContext({
    window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} },
    document,
    location: { pathname, origin: 'https://x.com' },
    URL,
    Event,
    setTimeout // 真实定时器：配合小步长 pollMs/waitMs 验证自适应等待
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'timeline-page.js'), 'utf8'), ctx);
  return ctx.window.__xfaTimeline(args || {});
}

async function main() {
  const articles = [
    articleEl('alice'),
    articleEl('promoted'),
    articleEl('repost'),
    articleEl('quoted'),
    articleEl('noreply'),
    articleEl('dup'),
    articleEl('nouser'),
    articleEl('quoteonly'),
    articleEl('low'),
    articleEl('comma'),
    articleEl('arabic'),
    articleEl('mixed')
  ];
  const r = await runTimeline({ pathname: '/home', articles, args: { maxScrolls: 10, maxCandidates: 60, pollMs: 20, waitMs: 60, stallLimit: 5, minViews: 500, target: 20 } });
  assert.strictEqual(r.ok, true, r.error);
  // alice 与 dup 同 id 去重 → 10 条有效（新增阿语帖、中英夹带帖各一）；quoteonly 只有嵌套链接，应被丢弃
  assert.strictEqual(r.candidates.length, 10, 'dedup by id, nested quote link ignored');
  assert.ok(r.candidates.every(c => c.id !== '129'), 'nested quote id must not be adopted');
  assert.ok(r.candidates.some(c => c.id === '128'), 'card without User-Name cell still parsed from its status link');
  const byId = new Map(r.candidates.map(c => [c.id, c]));
  const alice = byId.get('123');
  assert.strictEqual(alice.handle, 'alice');
  assert.strictEqual(alice.replyVisible, true);
  assert.strictEqual(alice.promoted, false);
  assert.strictEqual(alice.repost, false);
  assert.strictEqual(alice.quoted, false);
  assert.strictEqual(alice.date, '2026-11-07T08:00:00.000Z');

  /* 浏览量解析：535 直读、3.6M=360万、1.2万=1.2万、1,234 千分位、无动作行数字为 null、42 低于门槛仅统计 */
  assert.strictEqual(alice.views, 535, 'plain views number read');
  assert.strictEqual(byId.get('124').views, 3600000, '3.6M suffix parsed');
  assert.strictEqual(byId.get('126').views, 12000, '1.2万 suffix parsed');
  assert.strictEqual(byId.get('888').views, 1234, 'thousands separator parsed');
  assert.strictEqual(byId.get('128').views, null, 'card without views number -> null');
  assert.strictEqual(byId.get('777').views, 42, 'low-view card still returned at page layer, background filters');

  /* 阿拉伯文帖：页面层就要打上标记，合格判定里排除；中文帖夹一个阿语词不受影响 */
  assert.strictEqual(byId.get('130').arabic, true, 'Arabic post flagged');
  assert.strictEqual(byId.get('131').arabic, false, 'Chinese post with one Arabic word is not flagged');
  assert.match(r.diagnostic, /arab=1/, 'arabic counter recorded');

  /* 诊断串新字段 */
  assert.match(r.diagnostic, /views=9/, 'viewsOk counter');
  assert.match(r.diagnostic, /noviews=1/, 'noViews counter');
  assert.match(r.diagnostic, /vlow=1/, 'vlow counter with minViews=500');
  assert.match(r.diagnostic, /norow=1/, 'noReply card counted as norow');
  assert.match(r.diagnostic, /h=10000-10000/, 'height min-max recorded');
  assert.match(r.diagnostic, /dom=12/, 'concurrent card count recorded');
  assert.match(r.diagnostic, /skel=0/, 'skeleton counter recorded');
  assert.match(r.diagnostic, /vis=hidden/, 'visibility state recorded');
  assert.match(r.diagnostic, /fp=/, 'structural fingerprint present');

  /* 合格候选计数（排除广告与阿语帖，转发帖照收）：
   * 123 通过、125 纯转发通过、126 引用帖通过、888 千分位通过、131 夹带阿语的中文帖通过；
   * 124 广告、127 无回复按钮、128 无浏览数、777 低于门槛、130 阿语帖 → 5 条 */
  assert.strictEqual(r.hits, 5, 'eligible count = 5');
  assert.strictEqual(r.target, 20);
  assert.strictEqual(r.reachedTarget, false, 'target not reached');
  assert.match(r.diagnostic, /hit=5/, 'hit counter in diagnostic');
  assert.match(r.diagnostic, /tgt=20/, 'target echoed in diagnostic');

  const promoted = r.candidates.find(c => c.promoted);
  assert.ok(promoted, 'promoted card is flagged, not dropped at page layer');
  const repost = r.candidates.find(c => c.repost);
  assert.ok(repost, 'plain repost is flagged');
  const quoted = r.candidates.find(c => c.quoted);
  assert.ok(quoted, 'quoted post is kept and marked quoted');
  const noReply = r.candidates.find(c => !c.replyVisible);
  assert.ok(noReply, 'hidden reply button is marked');

  /* 引用帖的嵌套 status 链接不得顶替外层 id：alice 卡只有外层 /alice/status/123 被识别 */
  assert.strictEqual(alice.url, 'https://x.com/alice/status/123');

  /* 路由门：不在 /home 直接失败 */
  const wrong = await runTimeline({ pathname: '/search', articles: [], args: {} });
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.error, /不在首页时间线/);

  /* 刷到底即停：只有一张卡、触底无新内容时循环不会挂死，且返回该卡 */
  const single = await runTimeline({ pathname: '/home', articles: [articleEl('bob')], args: { maxScrolls: 30, pollMs: 20, waitMs: 60, stallLimit: 5 } });
  assert.strictEqual(single.ok, true);
  assert.strictEqual(single.candidates.length, 1);
  assert.strictEqual(single.candidates[0].id, '456');

  /* 攒够目标条数即停：目标 2 条，首屏就有 4 条合格 → 一次滚动都不该发生 */
  const tgt = await runTimeline({ pathname: '/home', articles, args: { maxScrolls: 30, pollMs: 20, waitMs: 60, stallLimit: 5, minViews: 500, target: 2 } });
  assert.strictEqual(tgt.ok, true);
  assert.strictEqual(tgt.reachedTarget, true, 'target 2 reached on first screen');
  assert.match(tgt.diagnostic, /scrolls=0/, 'no scrolling once target already met');

  /* 名单过滤在页面层预判：只认 alice 时合格数为 5（原创 123 + 转发 125 + 引用 126 + 千分位 888 +
   * 夹带阿语的中文帖 131）；纯阿语帖 130 也属 alice，被语种规则拦下 */
  const roster = await runTimeline({ pathname: '/home', articles, args: { maxScrolls: 30, pollMs: 20, waitMs: 60, stallLimit: 5, minViews: 500, target: 6, allowedHandles: ['alice'] } });
  assert.strictEqual(roster.hits, 5, 'only alice cards qualify with roster filter (Arabic one excluded)');
  assert.match(roster.diagnostic, /notRoster=1/, 'erin counted as not in roster at page layer');
  assert.strictEqual(roster.reachedTarget, false);

  /* 长卡片 + 虚拟列表：卡片高 2400px，必须靠放大步长才能跨过卡片，
   * 且「无进展距离」未到 2 屏前不能记停顿 —— 否则会像实机那样滚 8 次就死。 */
  const tall = await runVirtualTimeline({
    count: 40, cardHeight: 2400,
    args: { maxScrolls: 30, maxCandidates: 60, pollMs: 20, waitMs: 60, stallLimit: 5, minViews: 500, target: 8 }
  });
  assert.strictEqual(tall.ok, true, tall.error);
  assert.strictEqual(tall.reachedTarget, true, 'tall-card feed reaches target instead of stalling');
  assert.ok(tall.candidates.length >= 8, 'collected at least 8 unique cards, got ' + tall.candidates.length);
  const tallScrolls = Number(/scrolls=(\d+)/.exec(tall.diagnostic)[1]);
  assert.ok(tallScrolls > 8, 'did not stop at 8 scrolls like the real run, got ' + tallScrolls);
  const tallDist = Number(/dist=(\d+)/.exec(tall.diagnostic)[1]);
  assert.match(tall.diagnostic, /dist=\d{4,}/, 'traveled distance recorded');
  /* 长卡片贴底补滚必须被限幅：单次平均位移超过 1.2 个步长（≈960px）就说明
   * "把最后一张卡顶到底部"又把视口甩飞了，中间那张卡会被虚拟列表换掉。 */
  assert.ok(tallDist / Math.max(1, tallScrolls) < 960,
    'per-scroll travel stays bounded, got avg ' + Math.round(tallDist / tallScrolls));

  console.log('PASS: timeline parse, views, threshold counters, target stop, roster prefilter, tall-card traversal, fingerprint, dedup, route gate and stop');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
