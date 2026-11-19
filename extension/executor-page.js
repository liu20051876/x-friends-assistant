/* 注入 X 帖子详情页的执行器。由 background 通过 chrome.scripting 载入并带参调用。
 * 流程：校验页面 → 打开回复框 → 写入草稿 → 发送 → 验证成功 → 点赞。
 * 每一步都有超时，失败即中止并返回明确原因。 */
(function () {
  if (window.__xfaExecutor) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.getClientRects().length > 0;
  }

  async function waitFor(fn, timeout = 10000, interval = 250) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /* ---------- 滚动：和名单读取同一套做法，但步长要克制 ----------
   * 1) behavior 用 instant：平滑动画在后台标签里既慢又会被合并，跳一半就停；
   * 2) 跳完立刻检查，不用"等 3×300ms"这种定时猜测；
   * 3) 步长只给 0.4 屏。跳太大会一步跨过还没渲染的区域，而虚拟列表不会回补
   *    被跨过的内容——表现就是"翻页太快，按钮反而不见了"；
   * 4) 触底不代表没内容：虚拟列表常触底后才追加，所以到底要等一会儿；
   *    位置和高度连续三次都没变化，才判定真的没有更多了。 */
  const scrollChunk = () => Math.min(420, Math.max(260, Math.floor((window.innerHeight || 800) * 0.4)));
  const pageHeight = () => document.documentElement.scrollHeight;
  const atBottom = () => (window.innerHeight + window.scrollY) >= pageHeight() - 4;

  function jumpBy(dy) {
    try { window.scrollTo({ top: Math.max(0, window.scrollY + dy), behavior: 'instant' }); }
    catch { try { window.scrollBy(0, dy); } catch {} }
  }
  function jumpTo(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    catch { try { el.scrollIntoView(); } catch {} }
  }

  /* 长帖的操作栏、内联回复框都在 article 底部附近。与其一屏一屏盲扫，
   * 不如把帖子底部挪到视口下方 3/4 处：不跨过 article 之外的内容，
   * 也不会跳过它自己的操作栏。 */
  function jumpNearArticle(article) {
    if (!article) return false;
    try {
      const r = article.getBoundingClientRect();
      const view = window.innerHeight || 800;
      const delta = r.bottom - view * 0.75;
      if (Math.abs(delta) > 60) jumpBy(delta);
      return true;
    } catch { return false; }
  }

  function scrollToTopOf(article) {
    try {
      if (article) {
        const top = article.getBoundingClientRect().top + window.scrollY - 120;
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    } catch {}
  }

  async function scanDown(find, timeout = 12000, onBottom, opts = {}) {
    const step = opts.step || scrollChunk();
    const settle = opts.settle || 420;
    let found = find();
    if (found) return found;
    const deadline = Date.now() + timeout;
    let lastH = pageHeight(), stalled = 0;
    while (!found && Date.now() < deadline) {
      if (atBottom()) {
        await sleep(settle + 300);
        const h = pageHeight();
        if (h > lastH) { lastH = h; stalled = 0; } else if (++stalled >= 3) break;
        if (onBottom) onBottom();
      } else {
        jumpBy(step);
        await sleep(settle);
      }
      found = find();
    }
    return found || null;
  }

  /* 认目标帖：只认 status id，别人帖子里的引用块 id 不同，天然被排除。
   * 匹配放宽：任何 href 里出现 /status/<id>（含 /quotes、/analytics 等子路径）都算。 */
  function findMainArticle(expectedId, expectedHandle) {
    const id = String(expectedId || '');
    const handle = String(expectedHandle || '').replace(/^@/, '').toLowerCase();
    if (!/^[0-9]+$/.test(id)) return null;
    const re = new RegExp(`/status/${id}(?:[/?#]|$)`, 'i');
    let byId = null;
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      for (const link of a.querySelectorAll('a[href]')) {
        try {
          const url = new URL(link.href, location.origin);
          if (url.origin !== location.origin || !re.test(url.pathname + url.search)) continue;
          const segs = url.pathname.toLowerCase().split('/').filter(Boolean);
          const h = (segs[0] || '').toLowerCase();
          if (!handle || h === handle || h === 'i') return a;
          if (!byId) byId = a; // handle 对不上但 id 唯一，留作兜底
        } catch {}
      }
    }
    return byId;
  }

  function firstArticle() {
    return document.querySelector('article[data-testid="tweet"]') || null;
  }

  /* 原帖被删、账号受限时，X 会在同一地址只渲染一句提示，页面上没有任何 article。
   * 这种页面必须单独认出来：否则会被当成"虚拟列表还没渲染"，白扫二十秒后报一个普通失败。 */
  const GONE_TEXT = /this post is unavailable|this post is no longer available|these posts are protected|account suspended|this account doesn.t exist|hmm.*page doesn.t exist|此帖不可用|该帖子不可用|此帖子不可用|帖子已被删除|帖子不存在|账号已被停用|该账号已被冻结|这些帖子受保护|账号不存在/i;

  function pageGone() {
    // 页面上还有帖子就说明不是"整页不可用"，避免把正文里恰好提到这些词的文章误判成删帖
    if (document.querySelector('article[data-testid="tweet"]')) return false;
    const body = document.body;
    const text = String((body && (body.innerText || body.textContent)) || '').slice(0, 1200);
    return GONE_TEXT.test(text);
  }

  function findReplyButton(expectedId, expectedHandle) {
    const article = findMainArticle(expectedId, expectedHandle);
    if (article) {
      const b = article.querySelector('[data-testid="reply"]');
      if (b) return b;
    }
    // 走到这里说明 article 没匹配上。run 开头已用 location.pathname 精确确认过页面就是目标帖，
    // 所以用首篇 article 的回复按钮兜底，而不是直接放弃（X 详情页首篇即焦点帖）。
    const first = firstArticle();
    return first?.querySelector('[data-testid="reply"]') || null;
  }

  function diagnosePage(expectedId, expectedHandle) {
    const nodes = document.querySelectorAll('article[data-testid="tweet"]');
    const replyBtns = document.querySelectorAll('[data-testid="reply"]').length;
    const editors = document.querySelectorAll('div[data-testid="tweetTextarea_0"]').length;
    // 把页面上各条帖子的 status id 打出来，能直接看出是"没认出目标"还是"没渲染"
    const ids = [...nodes].slice(0, 4).map(a => {
      const l = a.querySelector('a[href*="/status/"]');
      if (!l) return '?';
      const m = String(l.href).match(/\/status\/(\d+)/);
      return m ? m[1] : '?';
    });
    const matched = expectedId ? (findMainArticle(expectedId, expectedHandle) ? 'yes' : 'no') : 'n/a';
    return `path=${location.pathname},articles=${nodes.length},ids=[${ids.join(',')}],matched=${matched},replyBtns=${replyBtns},editors=${editors},scroll=${Math.round(window.scrollY)}/${pageHeight()},bottom=${atBottom()}`;
  }

  function isEditor(n) {
    return !!n && visible(n) && n.getAttribute('contenteditable') === 'true';
  }

  function findComposer() {
    const nodes = [
      ...document.querySelectorAll('div[data-testid="tweetTextarea_0"]'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]')
    ];
    return nodes.find(isEditor) || null;
  }

  /* 找折叠状态的回复框。两种情况都找：
   * 1) data-testid 存在但 contenteditable 还是 false；
   * 2) 折叠成纯占位文字"发布你的回复"/"Post your reply"，点它才展开。 */
  function findCollapsedComposer() {
    // 情况1：元素在但不可编辑
    const byAttr = [
      ...document.querySelectorAll('div[data-testid="tweetTextarea_0"]'),
      ...document.querySelectorAll('[role="textbox"]')
    ].find(n => !!n && n.getAttribute('contenteditable') !== 'true' && visible(n));
    if (byAttr) return byAttr;

    // 情况2：按占位文字找
    const words = ['发布你的回复', 'Post your reply', 'Post your Reply'];
    const all = [...document.querySelectorAll('div, span, p')];
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (words.includes(t) && visible(el)) {
        // 点整个容器（父级），而不是只点文字本身
        return el.closest('[data-testid="tweetTextarea_0"], [role="textbox"], div[class]') || el;
      }
    }
    return null;
  }

  function expandComposer(el) {
    if (!el) return;
    try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch {}
    try { el.click(); } catch {}
    try { el.focus(); } catch {}
  }

  /* 优先取弹窗里的输入框：帖详情页本来就有一个内联回复框，
   * 网速慢时弹窗还没起来，先抓到的往往是那个旧的，写进去也不会驱动弹窗的编辑器。 */
  function composerInDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    for (const d of dialogs) {
      const box = [...d.querySelectorAll('div[data-testid="tweetTextarea_0"], [contenteditable="true"][role="textbox"]')].find(isEditor);
      if (box) return box;
    }
    return null;
  }

  /* 找输入框自己的容器：最近的、内部同时含输入框和发送按钮的祖先。
   * 不做层数猜测，找不到就返回 null（宁可报错，也不去点别人家的按钮）。 */
  function composerContainer(box) {
    return buttonScope(box).container;
  }

  /* 容器定位分档：先上溯祖先（X 的编辑器可以嵌得很深，放宽到 30 级），
   * 再试弹窗与表单。祖先只看 tweetButton*，避免在高层撞上侧栏的“发帖”按钮；
   * 弹窗/表单足够窄，才允许用文字标签兜底。 */
  const isSubmitLabel = n => n &&
    n.getAttribute('data-testid') !== 'reply' &&
    /^(reply|回复|回覆|post|发布|发帖)$/i.test((n.innerText || n.getAttribute('aria-label') || '').trim());
  const hasTweetButton = node => !!node && node.querySelectorAll('[data-testid*="tweetButton"]').length > 0;
  const hasSubmit = node => !!node &&
    (hasTweetButton(node) || [...node.querySelectorAll('button, [role="button"]')].some(isSubmitLabel));

  function buttonScope(box) {
    let node = box.parentElement;
    for (let i = 0; i < 30 && node && node !== document.body; i++, node = node.parentElement) {
      if (node.contains(box) && hasTweetButton(node)) {
        // 身份门：容器里不该装着别人的帖子，否则那按钮很可能是另一条帖子的
        if (node.querySelectorAll('article[data-testid="tweet"]').length <= 1) return { container: node, depth: i + 1 };
        return { container: null, depth: `too-broad@${i + 1}` };
      }
    }
    const dialog = box.closest('[role="dialog"]');
    if (hasSubmit(dialog)) return { container: dialog, depth: 'dialog' };
    const form = box.closest('form');
    if (hasSubmit(form)) return { container: form, depth: 'form' };
    return { container: null, depth: 0 };
  }

  /* 模拟真人激活编辑器：X 的编辑器要收到 mousedown/mouseup 才会进入可编辑状态，
   * 只调用 focus() 有时只是“看起来聚焦了”。 */
  function activateEditor(box) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      try { box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch {}
    }
    try { box.focus(); } catch {}
    placeCaretAtEnd(box);
  }

  /* 输入框到根的祖先链，附带层数，用来给按钮配对 */
  function ancestorIndex(el) {
    const map = new Map();
    let n = el, i = 0;
    while (n && n !== document.documentElement) { map.set(n, i++); n = n.parentElement; }
    return map;
  }

  /* X 有时把提交按钮渲染在与输入框不同的子树里（同一层布局下的旁支），
   * 上溯找不到容器。此时按“与输入框的共同祖先最近”配对，而不是全页随便挑：
   * 共同祖先必须落在 body 之内，body 级就等同于全页面任选，不能接受。 */
  function nearestButton(box, buttons) {
    const up = ancestorIndex(box);
    let best = null;
    for (const btn of buttons) {
      let n = btn, dist = 0, lca = null;
      while (n && dist <= 60) {
        if (up.has(n)) { lca = n; break; }
        n = n.parentElement; dist++;
      }
      if (!lca || lca === document.body || lca === document.body.parentElement) continue;
      const score = up.get(lca) + dist;
      if (!best || score < best.score) best = { button: btn, score, lca };
    }
    return best;
  }

  function editorCount() {
    const nodes = [
      ...document.querySelectorAll('div[data-testid="tweetTextarea_0"]'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]')
    ];
    return new Set(nodes.filter(isEditor)).size;
  }

  /* 定位发送按钮。返回 {button, container, candidates, tier}。
   * 文本兜底只在容器内执行，绝不在全文档按文本找，以免点到侧栏的“发帖”按钮。 */
  function locateSendButton(box) {
    const enabled = n => visible(n) && !n.disabled && n.getAttribute('aria-disabled') !== 'true';
    const all = [...document.querySelectorAll('[data-testid*="tweetButton"]')];
    const { container } = buttonScope(box);

    if (container) {
      // 1) 容器内按 testid
      const list = [...container.querySelectorAll('[data-testid*="tweetButton"]')];
      const known = list.find(enabled);
      if (known) return { button: known, container, candidates: list, tier: 'container' };

      // 2) 容器内按文本
      const byLabel = [...container.querySelectorAll('button, [role="button"]')].find(n => isSubmitLabel(n) && enabled(n));
      if (byLabel) return { button: byLabel, container, candidates: list, tier: 'container-label' };

      return { button: null, container, candidates: list, tier: 'container-none' };
    }

    // 3) 认不出容器：按共同祖先最近配对（限 body 内部，不跨层乱点）
    const near = nearestButton(box, all.filter(enabled));
    if (near) return { button: near.button, container: near.lca, candidates: all, tier: `nearest+${near.score}` };

    // 4) 全页只有一个可用提交按钮、且只有一个编辑器：只可能是它
    const usable = all.filter(enabled);
    const editors = editorCount();
    if (usable.length === 1 && editors <= 1) return { button: usable[0], container: null, candidates: all, tier: 'unique' };

    // 认不出容器：只做诊断，不发送
    return { button: null, container: null, candidates: all, tier: `none(usable=${usable.length},editors=${editors})` };
  }

  function findSendButton(box) {
    return locateSendButton(box).button;
  }

  function describeCandidates(info) {
    const parts = info.candidates
      .map(n => {
        const id = n.getAttribute('data-testid') || (n.innerText || '').trim().slice(0, 8) || '?';
        return `${id}:${n.getAttribute('aria-disabled') ?? '无'}:${visible(n) ? '可见' : '隐藏'}`;
      })
      .join(' | ');
    return `候选=${info.candidates.length}${parts ? ` [${parts}]` : ''}；容器=${info.container ? '已识别' : '未识别'}；匹配=${info.tier || '?'}`;
  }

  function clickLike(article) {
    if (!article) return { clicked: false, reason: '未找到主帖' };
    const unlike = article.querySelector('[data-testid="unlike"]');
    if (unlike && visible(unlike)) return { clicked: false, reason: 'already' };
    const like = article.querySelector('[data-testid="like"]');
    if (!like || !visible(like)) return { clicked: false, reason: '未找到点赞按钮' };
    like.click();
    return { clicked: true, reason: '' };
  }

  /* 把光标放到输入框末尾。execCommand 只有在选区落在 contenteditable 内才生效，
   * 之前写入“看似成功、实则没有驱动编辑器状态”，多半就是漏了这一步。 */
  function placeCaretAtEnd(box) {
    try {
      box.focus();
      const sel = window.getSelection && window.getSelection();
      if (!sel || !document.createRange) return false;
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch { return false; }
  }

  function clearComposer(box) {
    if (!composerText(box)) return;
    placeCaretAtEnd(box);
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {}
    if (composerText(box)) box.textContent = '';
  }

  /* 用某一种注入方式写入草稿。返回“框内文字是否与草稿逐字一致”；
   * 注意这只说明 DOM 里有字，不代表 X 的编辑器收到了输入——所以调用方还要看按钮是否解禁。 */
  function writeDraft(box, text, method) {
    activateEditor(box);
    clearComposer(box);
    placeCaretAtEnd(box);
    try {
      if (method === 'exec') {
        document.execCommand('insertText', false, text);
      } else if (method === 'paste') {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } else if (method === 'beforeinput') {
        box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        document.execCommand('insertText', false, text);
      } else {
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } catch {}
    return composerText(box) === text;
  }

  /* 文字在框里、按钮却是灰的：补事件，再插一个空格删掉，制造一次真实内容变更。 */
  async function wakeEditor(box, text) {
    try {
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
    await sleep(300);
    if (locateSendButton(box).button) return;
    try {
      placeCaretAtEnd(box);
      document.execCommand('insertText', false, ' ');
      document.execCommand('delete', false, null);
      if (composerText(box) !== text) writeDraft(box, text, 'exec');
    } catch {}
    await sleep(400);
  }

  function composerText(box) {
    return (box?.innerText || box?.textContent || '').trim();
  }

  async function run(opts) {
    const expectHandle = String(opts.expectHandle || '').replace(/^@/, '').toLowerCase();
    const expectId = String(opts.expectId || '');
    const text = String(opts.text || '').trim();

    if (!text) return { ok: false, error: '草稿为空，已中止' };
    if (!/^[0-9]+$/.test(expectId) || !/^[a-z0-9_]{1,15}$/.test(expectHandle)) return { ok: false, error: '目标帖子信息不完整，已中止' };
    if (text.length > 280) return { ok: false, error: `草稿超过 280 字符（${text.length}）` };
    if (location.hostname !== 'x.com') return { ok: false, error: '当前页面不是 x.com' };

    const route = location.pathname;
    if (/\/i\/(flow|challenge)|\/account\/access|\/login/.test(route))
      return { ok: false, error: '页面要求登录或人机验证，已中止' };
    if (route.toLowerCase() !== `/${expectHandle}/status/${expectId}`)
      return { ok: false, error: '页面与目标帖不匹配，已中止' };

    const sidebar = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!sidebar) return { ok: false, error: '未能确认登录状态，已中止' };

    // 原帖已删 / 账号受限：整页只有一句不可用提示。这是"这条帖子没了"，不是执行器坏了，
    // 带上 gone 标记让后台跳过这一条并继续下一条，而不是把整批停下来。
    if (pageGone()) return { ok: false, gone: true, error: `原帖已删除或不可用（${location.pathname}）` };

    // 链接匹配失败时用首篇 article 兜底（路由已确认，见 findReplyButton 注释）
    const target = findMainArticle(expectId, expectHandle) || firstArticle();

    // 1. 找到回复按钮。先在当前位置找；不在就先把帖子底部挪进来（长帖的操作栏就在那儿），
    //    还找不到才向下小步扫描；最后再退回帖子顶部用更小的步子重走一遍，
    //    避免"跳过头"之后虚拟列表不补渲染、反而彻底找不到。
    let reply = findReplyButton(expectId, expectHandle);
    if (!reply) {
      jumpNearArticle(target);
      await sleep(600);
      reply = findReplyButton(expectId, expectHandle);
    }
    if (!reply) reply = await scanDown(() => findReplyButton(expectId, expectHandle), 8000);
    if (!reply) {
      scrollToTopOf(target);
      await sleep(500);
      reply = await scanDown(() => findReplyButton(expectId, expectHandle), 8000, null, { step: 150, settle: 520 });
    }
    if (!reply) {
      if (pageGone()) return { ok: false, gone: true, error: `原帖已删除或不可用（${location.pathname}）` };
      return { ok: false, error: `未找到回复按钮（扫描到底仍未渲染；${diagnosePage(expectId, expectHandle)}）` };
    }
    jumpTo(reply);
    await sleep(250);
    if (!visible(reply)) {
      // 节点在但渲染尺寸为 0：多半是虚拟列表还没挂上，原地再等一小会儿
      await sleep(600);
      if (!visible(reply)) return { ok: false, error: `回复按钮存在但不可点击；${diagnosePage(expectId, expectHandle)}` };
    }
    reply.click();

    // 2. 等待输入框。X 的内联回复框默认是折叠的（显示"发布你的回复"占位），
    //    点文章的回复图标后 X 不一定自动展开——需要我们主动点一下折叠框。
    //    长文页面框在文章下方，还没滚到那里时虚拟滚动不挂载它，用同一套扫描往下找。
    let box = composerInDialog() || findComposer();
    // 等 X 自己先处理回复点击（它可能会滚动页面）
    await sleep(1200);

    let expandTries = 0;
    const findBoxOrExpand = () => {
      const b = composerInDialog() || findComposer();
      if (b) return b;
      if (expandTries < 2) {
        const collapsed = findCollapsedComposer();
        if (collapsed) { expandComposer(collapsed); expandTries++; }
      }
      return null;
    };
    if (!box) {
      // 回复框也在帖子底部下方一点，先对准帖子底部再小步找
      jumpNearArticle(target);
      await sleep(600);
      box = composerInDialog() || findComposer();
    }
    if (!box) box = await scanDown(findBoxOrExpand, 15000, findBoxOrExpand);
    if (!box) {
      scrollToTopOf(target);
      await sleep(500);
      box = await scanDown(findBoxOrExpand, 12000, findBoxOrExpand, { step: 150, settle: 520 });
    }
    if (!box) return { ok: false, error: `回复框未出现（扫描到底并尝试展开折叠框 ${expandTries} 次，仍未挂载编辑器；${diagnosePage(expectId, expectHandle)}）` };

    // 跳进视口中央，然后重新取一次引用（虚拟滚动重挂载后旧节点已脱离文档）
    jumpTo(box);
    await sleep(300);
    box = composerInDialog() || findComposer() || box;
    if (!visible(box)) return { ok: false, error: '回复框已出现但不可见，未发出' };
    if (box.isConnected === false) return { ok: false, error: '回复框引用已失效（页面重挂载），未发出' };

    // 3+4. 写入草稿，判定标准是“发送按钮解禁且内容逐字一致”。
    //     只比“框里有字”是不够的：DOM 里写进去的字，X 的编辑器可能完全没收到，按钮会一直是灰的。
    let typed = false;
    let info = null;
    const tried = [];
    for (const method of ['exec', 'paste', 'beforeinput', 'dom']) {
      tried.push(method);
      let matched = false;
      try { matched = writeDraft(box, text, method); } catch {}
      await sleep(400);
      info = locateSendButton(box);
      if (matched && info.button) { typed = true; break; }
      // 字对但按钮还灰：先唤醒，不行就换下一种注入方式
      await wakeEditor(box, text);
      info = locateSendButton(box);
      if (composerText(box) === text && info.button) { typed = true; break; }
    }

    if (!typed) {
      const now = locateSendButton(box);
      return {
        ok: false,
        error: `回复提交按钮不可用或未找到，未发出（${describeCandidates(now)}；已尝试=${tried.join('/')}；框内文字=${composerText(box) === text ? '一致' : '不一致'}）`
      };
    }
    const send = info.button;
    const oldToast = document.querySelector('[data-testid="toast"]');
    const oldToastText = oldToast && visible(oldToast) ? oldToast.innerText.trim() : '';
    send.click();

    // 5. 发送结果判定。X 发回复时并不总会弹“已发送”提示，只认 toast 会把成功误判成未确认。
    //    因此同时接受：明确成功提示 / 回复框关闭或不可见。明确失败提示优先，避免误判。
    const boxGone = () => {
      if (!box || !document.body) return false;
      return !document.body.contains(box) || !visible(box);
    };

    let outcome = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const toast = document.querySelector('[data-testid="toast"]');
      const message = toast && visible(toast) ? toast.innerText.trim() : '';
      const fresh = message && (toast !== oldToast || message !== oldToastText);
      if (fresh && /failed|could(n't| not)|try again|出错|失败|无法发送/i.test(message)) {
        outcome = { ok: false, reason: message };
        break;
      }
      if (fresh && /(your (reply|post) (was|has been) sent|reply sent|post sent|已发送|发送成功)/i.test(message)) {
        outcome = { ok: true, by: 'toast' };
        break;
      }
      if (boxGone()) { outcome = { ok: true, by: 'composer-closed' }; break; }
      await sleep(400);
    }

    if (!outcome) {
      return {
        ok: false,
        uncertain: true,
        error: '发送结果未确认：回复框仍在且未见成功提示。回复可能已经发出，请先到 X 核实，切勿直接重试'
      };
    }
    if (!outcome.ok) return { ok: false, error: `发送失败：${outcome.reason}` };

    await sleep(800);

    // 6. 回复成功后才点赞
    const article = findMainArticle(expectId, expectHandle) || firstArticle();
    const like = clickLike(article);
    let liked = false;
    if (like.clicked) {
      liked = !!(await waitFor(() => {
        const a = findMainArticle(expectId, expectHandle) || firstArticle();
        const un = a?.querySelector('[data-testid="unlike"]');
        return un && visible(un) ? un : null;
      }, 5000));
    }

    return {
      ok: true,
      sent: true,
      liked,
      likeReason: like.reason,
      verifiedBy: outcome.by
    };
  }

  window.__xfaExecutor = opts => run(opts).catch(e => ({ ok: false, error: e.message || '执行异常' }));
})();
