/* 时间线采集页面执行器，由 background 通过 chrome.scripting 载入并带参调用（0.6.3）。
 * 在 x.com/home 后台标签里小步滚动首页 feed，把渲染出的 article 卡片解析成候选。
 * 页面侧拿不到互关名单，因此只做标记与去重，作者/广告/纯转发的过滤判定放在 background。
 * 滚动步长与回复执行器一致（0.4 屏，约 320px、上限 420），避免虚拟列表跨过未渲染内容。 */
(function () {
  if (window.__xfaTimeline) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getClientRects().length > 0;
  };

  /* ---------- 滚动（与 executor-page / follow-page 同一套） ---------- */
  /* 步长按视口比例给：首页卡片常是长文+大图（一张两三千 px），
   * 用了 0.4 屏会在同一张卡里空滚十来次；但步长太大又会把虚拟列表里
   * 只画了半张的卡片甩过去。取 0.7 屏，比人滚一屏略小一点。 */
  const scrollChunk = () => Math.min(840, Math.max(480, Math.floor((window.innerHeight || 800) * 0.7)));
  const pageHeight = () => document.documentElement.scrollHeight;
  const atBottom = () => (window.innerHeight + window.scrollY) >= pageHeight() - 4;
  function jumpBy(dy) {
    try { window.scrollTo({ top: Math.max(0, window.scrollY + dy), behavior: 'instant' }); }
    catch { try { window.scrollBy(0, dy); } catch {} }
    // 兜底：确保 scroll 事件真的派发出去，虚拟列表据此才会换窗口
    try { window.dispatchEvent(new Event('scroll')); } catch {}
  }
  /* 把最后一张卡推到视口底部：等价于「人滚到这一屏末尾」，
   * 比单纯加 scrollY 更能触发 X 的懒加载。
   * 但长卡片（两三千 px）会把它变成一次大跳，直接把中间那张卡甩出渲染窗口——
   * 所以只允许它补一小段（不超过 0.35 屏），超出就不做。 */
  function scrollLastIntoView(maxDelta) {
    const cards = document.querySelectorAll('article[data-testid="tweet"]');
    const last = cards[cards.length - 1];
    if (!last || typeof last.scrollIntoView !== 'function') return false;
    const rect = last.getBoundingClientRect();
    const delta = rect.bottom - (window.innerHeight || 800);
    if (delta <= 0) return false;                       // 已经整张在视口里，不用再推
    if (delta > (maxDelta || 300)) return false;        // 会拖飞，交给固定步长慢慢走
    try { last.scrollIntoView({ block: 'end', behavior: 'instant' }); return true; } catch { return false; }
  }

  /* ---------- 卡片解析 ---------- */
  /* 阿拉伯文字帖：X 上阿语/波斯语/乌尔都语共用一套字母表，发布量很大。
   * 判据是「阿语系字母占全部字母的一半以上」，中文或英文帖夹带一两个词不会误伤，
   * 纯数字/emoji 帖也不会被误判。注入脚本不依赖外部模块，独立实现一份。 */
  function isArabicText(text) {
    const t = String(text || '');
    const letters = t.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const arabic = letters.filter(ch => /\p{Script=Arabic}/u.test(ch)).length;
    if (!arabic) return false;
    return arabic >= 3 && arabic / letters.length >= 0.5;
  }

  function handleFromArticle(article) {
    const cell = article.querySelector('[data-testid="User-Name"]');
    if (!cell) return null;
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const segs = new URL(a.href, location.origin).pathname.split('/').filter(Boolean);
      if (segs.length === 1 && /^[a-z0-9_]{1,15}$/i.test(segs[0])) return segs[0].toLowerCase();
    }
    return null;
  }

  function nameFromArticle(article) {
    const cell = article.querySelector('[data-testid="User-Name"]');
    if (!cell) return '';
    for (const span of cell.querySelectorAll('span')) {
      const t = (span.textContent || '').trim();
      if (t && !t.startsWith('@') && t !== '·' && !/^[·\s]+$/.test(t)) return t.slice(0, 80);
    }
    return '';
  }

  /* 取这张卡片自己的 status 链接：以「不属于任何嵌套 article」为准。
   * 首页卡片的时间戳链接是唯一权威 id 来源；不再要求与 User-Name 里的 handle 拼字面匹配，
   * 因为虚拟列表里部分卡片的用户名区尚未渲染完成，硬匹配会把整屏都判成无效。 */
  function canonicalStatus(article) {
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (typeof a.closest === 'function' && a.closest('article') !== article) continue; // 跳过引用帖里的嵌套链接
      try {
        const u = new URL(a.href, location.origin);
        if (u.origin !== location.origin) continue;
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length >= 3 && segs[1] === 'status' && /^[0-9]+$/.test(segs[2]) && /^[a-z0-9_]{1,15}$/i.test(segs[0])) {
          return { handle: segs[0].toLowerCase(), id: segs[2], url: u.href };
        }
      } catch {}
    }
    return null;
  }

  /* 广告：推广帖带 placementTracking，或社交上下文写着 Promoted/广告/推广。 */
  function isPromoted(article) {
    if (article.querySelectorAll('[data-testid="placementTracking"]').length) return true;
    for (const ctx of article.querySelectorAll('[data-testid="socialContext"], span')) {
      const t = (ctx.textContent || '').trim().toLowerCase();
      if (/promoted|广告|推广/.test(t) && t.length <= 30) return true;
    }
    return false;
  }

  /* 纯转发（无自己评论）：社交上下文出现 reposted/转推。引用转发另有自己的正文，不在此列。 */
  function isPlainRepost(article) {
    for (const ctx of article.querySelectorAll('[data-testid="socialContext"]')) {
      const t = (ctx.textContent || '').trim().toLowerCase();
      if (/reposted|repost|转推|转发/.test(t) && t.length <= 40) return true;
    }
    return false;
  }

  /* 本卡归属门：嵌套引用帖里的元素不算本卡的。 */
  function ownGate(el, article) {
    try { return typeof el.closest !== 'function' || !el.closest('article') || el.closest('article') === article; }
    catch { return true; }
  }

  /* 浏览量：动作行里柱状图图标旁边的数字（3.6M / 1.2万 / 1,234 / 535）。
   * X 不把它放在按钮内（回复/转发/点赞数都在按钮里），所以「不在 button 内」就是关键过滤。
   * 锚点取本卡自己的 like 按钮，向上一两层就是动作行容器。
   * 逗号按千分位去掉，点号只在没有逗号时当小数（3.6M 与 1,234 才不打架）。 */
  const VIEWS_RE = /^([\d.,]+)\s*([kmb万])?$/i;
  function parseViews(article) {
    let anchor = null;
    for (const b of article.querySelectorAll('[data-testid="like"], [data-testid="unlike"]')) {
      if (ownGate(b, article)) { anchor = b; break; }
    }
    let row = anchor;
    for (let i = 0; i < 4 && row && row.parentElement; i++) {
      row = row.parentElement;
      if (row && typeof row.querySelector === 'function' && row.querySelector('[data-testid="reply"]')) break;
    }
    const scope = row || article;
    for (const el of scope.querySelectorAll('span')) {
      if (!ownGate(el, article)) continue;
      try { if (typeof el.closest === 'function' && el.closest('button')) continue; } catch {}
      const t = (el.textContent || '').trim();
      const m = t.match(VIEWS_RE);
      if (!m) continue;
      const numText = m[1];
      const digits = numText.includes(',') ? numText.replace(/,/g, '') : numText;
      const n = parseFloat(digits);
      if (!Number.isFinite(n)) continue;
      const suf = (m[2] || '').toLowerCase();
      const mult = suf === 'm' ? 1e6 : suf === 'k' ? 1e3 : suf === 'b' ? 1e9 : suf === '万' ? 1e4 : 1;
      return { views: Math.round(n * mult), raw: t };
    }
    return null;
  }

  /* 结构指纹：第一张解析成功的卡里有哪些关键 testid，X 改版时一眼能看出缺了哪块。 */
  function fingerprint(article) {
    const ids = [];
    for (const t of ['User-Name', 'tweetText', 'time', 'reply', 'retweet', 'like', 'bookmark']) {
      try { if (article.querySelector(`[data-testid="${t}"]`)) ids.push(t); } catch {}
    }
    return ids.join(',') || 'none';
  }

  /* 解析失败时返回 reason，供诊断串统计，避免「采不到却不知道为什么」。 */
  function parseArticle(article) {
    const status = canonicalStatus(article);
    if (!status) return { reason: 'nostatus' };
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const timeEl = article.querySelector('time[datetime]');
    const replyBtn = [...article.querySelectorAll('[data-testid="reply"]')].find(visible);
    const views = parseViews(article);
    const ownText = (textEl?.innerText || textEl?.textContent || '').trim();
    // 纯图/纯引用帖没有自己的正文，就按被引用的那段判断语种
    const quoteEl = article.querySelectorAll('article').length > 0
      ? article.querySelector('article [data-testid="tweetText"]')
      : null;
    const arabic = ownText ? isArabicText(ownText) : isArabicText(quoteEl?.innerText || '');
    return {
      id: String(status.id),
      handle: status.handle || handleFromArticle(article) || '',
      name: nameFromArticle(article),
      url: status.url,
      text: ownText,
      date: timeEl?.getAttribute('datetime') || '',
      quoted: article.querySelectorAll('article').length > 0,
      repost: isPlainRepost(article),
      promoted: isPromoted(article),
      replyVisible: !!replyBtn,
      arabic,
      views: views ? views.views : null,
      viewsRaw: views ? views.raw : ''
    };
  }

  /* 自适应等待：滚完后在 timeout 内反复扫描，直到出现新内容。
   * 后台标签渲染慢，固定短等待会把「还没渲染」误判成「刷到底」。 */
  async function waitForGrowth(scanFn, hasGrowth, timeoutMs, pollMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      scanFn();
      if (hasGrowth()) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async function collect(opts) {
    if (!/^\/home(\/|$|\?)/.test(location.pathname)) return { ok: false, error: '不在首页时间线，无法采集' };
    const maxScrolls = Math.max(1, Number(opts.maxScrolls) || 30);
    const maxCandidates = Math.max(1, Number(opts.maxCandidates) || 60);
    const waitMs = Math.max(100, Number(opts.waitMs) || 6000);   // 每次滚动后最多等多久
    const pollMs = Math.max(20, Number(opts.pollMs) || 500);     // 复查间隔
    const stallLimit = Math.max(1, Number(opts.stallLimit) || 5); // 连续几轮无新内容才停
    const minViews = Math.max(0, Number(opts.minViews) || 0);     // 热帖门槛（0=不过滤，仅统计）
    const target = Math.max(1, Number(opts.target) || 20);        // 目标条数：合格候选攒够就停
    const allowed = new Set((Array.isArray(opts.allowedHandles) ? opts.allowedHandles : [])
      .map(h => String(h || '').replace(/^@/, '').toLowerCase())
      .filter(h => /^[a-z0-9_]{1,15}$/.test(h)));
    const found = new Map();
    const hits = new Set();   // 合格候选（名单内 + 非广告/纯转发 + 可回复 + 浏览数达标）
    let articlesSeen = 0;
    let nostatus = 0;      // 找不到自己的 status 链接（可能是横幅、占位骨架或结构改版）
    let duplicates = 0;    // 同一 id 重复出现
    let viewsOk = 0;       // 成功读出浏览量的卡片数
    let noViews = 0;       // 有 id 但动作行读不到浏览数（太新，或选择器没对上）
    let noRow = 0;         // 有 id 但回复按钮都不可见（动作行结构异常）
    let vLow = 0;          // 浏览数低于门槛的卡片数
    let notRoster = 0;     // 作者不在名单内
    let arabicCards = 0;   // 阿拉伯文帖（阿语/波斯语/乌尔都语），一律不采
    let fp = '';
    let maxDom = 0;        // 单轮扫描里同时存在的卡片数（判断虚拟列表窗口大小）
    let maxSkel = 0;       // 单轮扫描里加载占位（role=progressbar）数量
    let heightMin = pageHeight();
    let heightMax = heightMin;
    let stalled = 0;
    let screens = 0;

    /* 合格判定：与 background 的过滤口径一致（排除广告和阿拉伯文帖，转发帖照收；
     * 名单仅在显式传入时作为范围限定），目的是提前算「够不够目标条数」。 */
    const qualifies = c => !c.promoted && !c.arabic && c.replyVisible
      && (!allowed.size || allowed.has(String(c.handle || '').toLowerCase()))
      && c.views != null && c.views >= minViews;

    // 先把首屏已渲染的卡片收进来
    const scan = () => {
      const all = document.querySelectorAll('article[data-testid="tweet"]');
      let skel = 0;
      try { skel = document.querySelectorAll('[role="progressbar"]').length; } catch {}
      if (all.length > maxDom) maxDom = all.length;
      if (skel > maxSkel) maxSkel = skel;
      const h = pageHeight();
      if (h < heightMin) heightMin = h;
      if (h > heightMax) heightMax = h;
      for (const article of all) {
        articlesSeen++;
        const card = parseArticle(article);
        if (!card || !card.id) { nostatus++; continue; }
        if (found.has(card.id)) { duplicates++; continue; }
        if (!fp) fp = fingerprint(article);
        if (card.views == null) noViews++; else { viewsOk++; if (card.views < minViews) vLow++; }
        if (!card.replyVisible) noRow++;
        if (card.arabic) arabicCards++;
        if (!allowed.size || allowed.has(String(card.handle || '').toLowerCase())) {
          if (qualifies(card)) hits.add(card.id);
        } else notRoster++;
        found.set(card.id, card);
      }
    };
    scan();

    /* 进度判定：出现新的唯一卡片，或页面高度增长，都算「还有内容」。
     * 只认新卡片会在「卡片渲染了但解析不出 id」时提前停死。 */
    let lastH = pageHeight();
    const progressed = before => found.size > before || pageHeight() > lastH;
    const reached = () => hits.size >= target;

    /* 停顿按「无进展距离」判定：一张卡可能高两三屏，滚一步看不到新卡是正常的。
     * 累计无进展距离达到 2 屏才记一次停顿，避免长卡片把整轮采集提前判死。 */
    const stallDist = Math.max(800, Math.floor((window.innerHeight || 800) * 2));
    let noProgressDist = 0;
    let dist = 0;

    /* 停止条件三选一：攒够目标条数 / 滚满 maxScrolls / 连续 stallLimit 轮没进展。 */
    while (screens < maxScrolls && found.size < maxCandidates && !reached()) {
      if (atBottom()) {
        const h0 = pageHeight();
        const grew = await waitForGrowth(scan, () => pageHeight() > h0, waitMs, pollMs);
        if (grew) { lastH = pageHeight(); stalled = 0; noProgressDist = 0; continue; }
        if (++stalled >= stallLimit) break;
        continue;
      }
      const before = found.size;
      lastH = pageHeight();
      const step = scrollChunk();
      const y0 = window.scrollY;
      // 两步走：先按固定步长滚，再小幅把最后一张卡贴到视口底部（超长卡片不补，免得甩过去）
      jumpBy(step);
      scrollLastIntoView(Math.floor((window.innerHeight || 800) * 0.35));
      const moved = Math.max(0, window.scrollY - y0);
      dist += moved || step;
      screens++;
      const got = await waitForGrowth(scan, () => progressed(before), waitMs, pollMs);
      if (got) {
        lastH = pageHeight(); stalled = 0; noProgressDist = 0;
        // 多给一拍让这一屏画完：只看到一张新卡就立刻跳，会漏掉同屏还没渲染出来的卡片
        await sleep(pollMs);
        scan();
      }
      else {
        noProgressDist += moved || step;
        if (noProgressDist >= stallDist) { noProgressDist = 0; if (++stalled >= stallLimit) break; }
      }
    }

    return {
      ok: true,
      candidates: [...found.values()],
      hits: hits.size,
      target,
      reachedTarget: hits.size >= target,
      diagnostic: `path=${location.pathname} articles=${articlesSeen} unique=${found.size} hit=${hits.size} tgt=${target} dup=${duplicates} nostatus=${nostatus} arab=${arabicCards} views=${viewsOk} noviews=${noViews} vlow=${vLow} norow=${noRow} notRoster=${notRoster} scrolls=${screens} stalls=${stalled} dist=${Math.round(dist)} pos=${Math.round(window.scrollY)}/${pageHeight()} dom=${maxDom} skel=${maxSkel} h=${heightMin}-${heightMax} vis=${document.visibilityState} fp=${fp}`
    };
  }

  window.__xfaTimeline = opts => collect(opts || {}).catch(e => ({ ok: false, error: e.message }));
})();
