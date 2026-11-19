/* 定向交友页面执行器，由 background 通过 chrome.scripting 载入并带参调用。
 * 已停用（0.6.2）：background 不再注入本文件，关注流程整体下线；文件保留以便恢复。
 * 两种模式：
 *  - collect：在搜索结果页滚动采集「带蓝V、当前未关注」的帖子作者；
 *  - follow：在个人主页点击关注并确认状态变化。
 * 滚动步长与回复执行器一致（0.4 屏），避免虚拟列表跨过未渲染内容。 */
(function () {
  if (window.__xfaFollow) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getClientRects().length > 0;
  };

  /* ---------- 滚动（与 executor-page 同一套） ---------- */
  const scrollChunk = () => Math.min(420, Math.max(260, Math.floor((window.innerHeight || 800) * 0.4)));
  const pageHeight = () => document.documentElement.scrollHeight;
  const atBottom = () => (window.innerHeight + window.scrollY) >= pageHeight() - 4;
  function jumpBy(dy) {
    try { window.scrollTo({ top: Math.max(0, window.scrollY + dy), behavior: 'instant' }); }
    catch { try { window.scrollBy(0, dy); } catch {} }
  }
  async function scrollScan(onEach, { maxScreens = 30, settle = 450 } = {}) {
    let screens = 0;
    let lastH = pageHeight(), stalled = 0;
    while (screens < maxScreens) {
      onEach();
      if (atBottom()) {
        await sleep(settle + 300);
        const h = pageHeight();
        if (h > lastH) { lastH = h; stalled = 0; }
        else if (++stalled >= 3) break;
      } else {
        jumpBy(scrollChunk());
        screens++;
        await sleep(settle);
      }
    }
  }

  /* ---------- 采集模式 ---------- */
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

  /* 蓝V：认证图标。蓝标与金标在部分版本同用 icon-verified，
   * 用 aria-label 区分机构标，区分不了时按蓝标处理并在诊断里透出。 */
  function hasBlueBadge(article) {
    const icons = article.querySelectorAll('svg[data-testid="icon-verified"], [data-testid="icon-verified"]');
    for (const icon of icons) {
      const label = (icon.getAttribute('aria-label') || icon.querySelector('title')?.textContent || '').toLowerCase();
      if (label.includes('organization') || label.includes('business') || label.includes('official organization')) continue;
      return { yes: true, label };
    }
    return icons.length ? { yes: true, label: 'unclassified' } : { yes: false, label: '' };
  }

  function statusLink(article, handle) {
    const re = new RegExp(`^/${handle}/status/[0-9]+$`, 'i');
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      try {
        const u = new URL(a.href, location.origin);
        if (u.origin === location.origin && re.test(u.pathname)) return u.href;
      } catch {}
    }
    return '';
  }

  async function collect(opts) {
    const keyword = String(opts.keyword || '').trim();
    if (!location.pathname.startsWith('/search')) return { ok: false, error: '不在搜索页，无法采集' };
    if (!keyword) return { ok: false, error: '缺少搜索关键词' };
    const found = new Map();
    let articlesSeen = 0;
    const scan = () => {
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        articlesSeen++;
        const handle = handleFromArticle(article);
        if (!handle || found.has(handle)) continue;
        const badge = hasBlueBadge(article);
        if (!badge.yes) continue;
        // 帖子卡片上存在可见关注按钮，说明当前未关注
        const followBtn = [...article.querySelectorAll('[data-testid="followButton"]')].find(visible);
        if (!followBtn) continue;
        found.set(handle, {
          handle,
          name: nameFromArticle(article),
          tweetUrl: statusLink(article, handle),
          keyword,
          badge: 'blue',
          badgeLabel: badge.label
        });
      }
    };
    await scrollScan(scan, { maxScreens: Number(opts.maxScreens) || 30 });
    return {
      ok: true,
      candidates: [...found.values()],
      diagnostic: `path=${location.pathname} articles=${articlesSeen} picked=${found.size} scroll=${Math.round(window.scrollY)}/${pageHeight()}`
    };
  }

  /* ---------- 关注模式（个人主页） ---------- */
  function followButton() {
    return [...document.querySelectorAll('[data-testid="followButton"]')].find(visible) || null;
  }
  function alreadyFollowing() {
    // 已关注时按钮变成 Following/关注中，或出现 unfollow 控件
    const unfollow = [...document.querySelectorAll('[data-testid="-unfollow"], [data-testid="placementTracking"]')].find(visible);
    if (unfollow) return true;
    for (const btn of document.querySelectorAll('button[aria-label], a[role="button"][aria-label]')) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (/(following|followed|关注中|已关注)/.test(label) && !/follow @|关注 @/.test(label)) return true;
    }
    return false;
  }
  async function confirmSheet() {
    for (let i = 0; i < 8; i++) {
      const confirmBtn = [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].find(visible);
      if (confirmBtn) { confirmBtn.click(); return true; }
      await sleep(250);
    }
    return false;
  }

  async function follow(opts) {
    const expected = String(opts.handle || '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(expected)) return { ok: false, error: '账号无效' };
    // 路由是权威门：地址栏必须是该账号主页
    const segs = location.pathname.split('/').filter(Boolean);
    if (segs.length !== 1 || segs[0].toLowerCase() !== expected) {
      return { ok: false, error: `页面账号与目标不一致 path=${location.pathname}` };
    }
    if (alreadyFollowing()) return { ok: true, skipped: true, by: 'already-following' };

    const button = followButton();
    if (!button) return { ok: false, uncertain: true, error: '未找到关注按钮，可能已关注，请核实' };
    button.click();
    // 部分账号会弹确认框
    await confirmSheet();

    // 最多 12 秒等状态翻转；连续两次确认，防重渲染误判
    let hits = 0;
    for (let i = 0; i < 48; i++) {
      await sleep(250);
      if (alreadyFollowing()) {
        if (++hits >= 2) return { ok: true, by: 'following-state' };
      } else {
        hits = 0;
      }
    }
    return { ok: false, uncertain: true, error: '关注后状态未确认，请在 X 核实，勿重复点击' };
  }

  window.__xfaFollow = opts => {
    const o = opts || {};
    return (o.mode === 'collect' ? collect(o) : follow(o))
      .catch(e => ({ ok: false, error: e.message }));
  };
})();
