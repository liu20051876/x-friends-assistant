/* Isolated checks: no browser, network, or account actions. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');

async function schedulerCheck() {
  let clock = 1700000000000, listener, opened = 0, clears = 0;
  const timers = [];
  const storage = {};
  const clone = x => x === undefined ? undefined : structuredClone(x);
  const fakeDate = class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } getHours() { return 12; } };
  const chrome = {
    runtime: { id: 'test', lastError: null, sendMessage: async () => {}, onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} } },
    storage: { local: { get(k, cb) { cb({ [k]: clone(storage[k]) }); }, set(v, cb) { Object.assign(storage, clone(v)); cb?.(); } } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    permissions: { contains: async () => true },
    tabs: { create: async () => { opened++; throw Error('unexpected tab'); } }
  };
  const ctx = vm.createContext({ chrome, console, Date: fakeDate, Math, importScripts() {},
    OriginalStore: { recover: async () => {}, claimDue: async () => null, get: async () => ({ task: null, nextDueAt: 0 }) },
    QueueStore: { list: async () => [{ id: '1', status: 'approved' }], todaySentCount: async () => 0, update: async () => {}, clearAll: async () => { clears++; } },
    AIService: { getConfig: async () => ({ minDelay: 15, maxDelay: 15, dailyLimit: 30, workStart: 0, workEnd: 24 }) },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  const send = type => new Promise(resolve => listener({ type }, { id: 'test' }, resolve));
  assert.strictEqual((await send('xfa-start-runner')).ok, true);
  assert.strictEqual((await send('xfa-clear-data')).ok, false);
  assert.strictEqual(clears, 0);
  const oldTimer = timers[0];
  await send('xfa-stop-runner');
  assert.strictEqual((await send('xfa-clear-data')).ok, true);
  assert.strictEqual(clears, 1);
  assert.strictEqual((await send('xfa-start-runner')).ok, true);
  clock += 16000;
  oldTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(opened, 0, 'stale timer must not start a send after restart');
}

async function executorCheck(message, articleId = '123', mode = 'known', gateY = 0, quoteFirst = false, linkMismatch = false) {
  let clock = 0, replyClicks = 0, sendClicks = 0, likeClicks = 0, toast = null;
  let composer = null;
  // 模拟虚拟列表：回复按钮在滚过 gateY 之前根本不存在于 DOM 里
  let scrollY = 0, jumps = 0;
  const gateOpen = () => gateY === 0 || scrollY >= gateY;
  const visible = { getBoundingClientRect: () => ({ width: 10, height: 10 }), getClientRects: () => [1] };
  const fakeDate = class extends Date { static now() { return clock; } };
  // 页面地址跟随 articleId：模拟"标签实际停在哪个帖子"，用于验证路由门控
  const location = { hostname: 'x.com', origin: 'https://x.com', pathname: `/friend/status/${articleId}` };
  const button = { ...visible, innerText: '回复', getAttribute: () => null, disabled: false, click() { sendClicks++; toast = { ...visible, innerText: message }; } };
  const disabled = { ...visible, innerText: '回复', getAttribute: name => name === 'aria-disabled' ? 'true' : null, click() { throw Error('disabled button clicked'); } };
  const container = { contains: () => true, querySelectorAll(s) {
    if (s === '[data-testid="tweetButtonInline"]') return mode === 'known' ? [disabled, button] : [];
    if (s === '[data-testid*="tweetButton"]') return mode === 'fallback' || mode === 'no-container' ? [] : [disabled, button];
    if (s === 'button, [role="button"]') return mode === 'fallback' ? [disabled, button] : [];
    return [];
  } };
  const box = { ...visible, innerText: '', textContent: '', getAttribute: () => 'true', closest: () => (['no-container', 'split', 'ambiguous'].includes(mode) ? null : container), focus() { document.activeElement = box; }, scrollIntoView() { jumps++; } };
  const reply = { ...visible, click() { replyClicks++; composer = box; }, scrollIntoView() { jumps++; } };
  const like = { ...visible, click() { likeClicks++; } };
  const article = { querySelector(s) {
    // quoteFirst：模拟"帖子内嵌引用帖，第一个 time 链接属于被引用那条（id 555）"
    if (s === 'time') return { closest: () => ({ href: `https://x.com/friend/status/${quoteFirst ? '555' : articleId}`, closest: () => article }) };
    if (s === '[data-testid="reply"]') return gateOpen() ? reply : null;
    if (s === '[data-testid="like"]') return like;
    if (s === 'a[href*="/status/"]') {
      return { href: linkMismatch ? 'https://x.com/other/status/555' : `https://x.com/friend/status/${articleId}` };
    }
    return null;
  }, querySelectorAll(s) {
    if (s === 'a[href]' || s === 'a[href*="/status/"]') {
      const own = linkMismatch ? 'https://x.com/other/status/555' : `https://x.com/friend/status/${articleId}`;
      const links = [{ href: own }];
      return quoteFirst ? [{ href: 'https://x.com/other/status/555' }, ...links] : links;
    }
    return [];
  }, getBoundingClientRect: () => ({ top: 0, bottom: 1400 }) };
  const document = {
    activeElement: null,
    documentElement: { scrollHeight: 6000 },
    body: mode === 'composer-closed'
      ? { contains: () => false }
      : (mode === 'gone' ? { contains: () => false, innerText: 'This post is unavailable.' } : undefined),
    execCommand(cmd, unused, text) { box.innerText = text; return true; },
    querySelector(s) {
      if (s === 'article[data-testid="tweet"]') return mode === 'gone' ? null : article;
      if (s === '[data-testid="SideNav_AccountSwitcher_Button"]') return {};
      if (s === '[data-testid="toast"]') return toast;
      if (s === '[data-testid="reply"]') return gateOpen() ? reply : null;
      return null;
    },
    querySelectorAll(s) {
      if (s === 'article[data-testid="tweet"]') return mode === 'gone' ? [] : [article];
      if (s === 'div[data-testid="tweetTextarea_0"]') return composer ? [composer] : [];
      if (s === '[data-testid="tweetButtonInline"]') return composer && mode !== 'no-container' ? [button] : [];
      if (s === '[data-testid*="tweetButton"]') {
        if (mode === 'known') return [button];
        if (mode === 'split') return [button];       // 提交按钮在页面里，但与输入框不同子树
        if (mode === 'ambiguous') return [button, button]; // 两个可用提交按钮，无法唯一认定
        return [];
      }
      return [];
    }
  };
  const win = { innerHeight: 800, scrollTo({ top }) { scrollY = Math.max(0, top); jumps++; }, scrollBy(x, y) { scrollY += y; jumps++; } };
  Object.defineProperty(win, 'scrollY', { get: () => scrollY });
  const ctx = vm.createContext({ window: win, document, location, URL, Date: fakeDate, setTimeout(fn, ms) { clock += ms; fn(); } });
  vm.runInContext(fs.readFileSync(path.join(root, 'executor-page.js'), 'utf8'), ctx);
  const result = await ctx.window.__xfaExecutor({ text: 'Hello there!', expectId: '123', expectHandle: 'friend' });
  return { result, replyClicks, sendClicks, likeClicks, jumps };
}

async function main() {
  const { compute } = require('../graph-logic.js');
  const following = [{ handle: 'a' }, { handle: 'b' }, { handle: 'c', theyFollowMe: false }];
  let result = compute(following, [{ handle: 'a' }], { followersComplete: false });
  assert.deepStrictEqual([result.counts.mutual, result.counts.notMutual, result.counts.unknown], [1, 1, 1]);
  result = compute(following, [{ handle: 'a' }], { followersComplete: true });
  assert.deepStrictEqual([result.counts.mutual, result.counts.notMutual, result.counts.unknown], [1, 2, 0]);
  await schedulerCheck();
  const wrong = await executorCheck('Your reply was sent.', '999');
  assert.strictEqual(wrong.replyClicks, 0, 'wrong article must not receive a reply');
  const failure = await executorCheck('Your reply failed to send.');
  assert.strictEqual(failure.sendClicks, 1);
  assert.strictEqual(failure.result.ok, false);
  assert.strictEqual(failure.likeClicks, 0, 'failure toast must not trigger a like');
  const success = await executorCheck('Your reply was sent.');
  assert.strictEqual(success.result.ok, true);
  assert.strictEqual(success.likeClicks, 1);
  const fallback = await executorCheck('Your reply was sent.', '123', 'fallback');
  assert.strictEqual(fallback.result.ok, true);
  assert.strictEqual(fallback.sendClicks, 1, 'reply-labeled enabled button should be selected');
  const noContainer = await executorCheck('Your reply was sent.', '123', 'no-container');
  assert.strictEqual(noContainer.sendClicks, 0, 'text fallback must not target outside the reply editor');

  // 提交按钮与输入框不在同一子树（上溯找不到容器）：全页唯一可用按钮 + 唯一编辑器 → 认它
  const split = await executorCheck('Your reply was sent.', '123', 'split');
  assert.strictEqual(split.result.ok, true, 'unique submit button should still be used');
  assert.strictEqual(split.sendClicks, 1);

  // 同样认不出容器，但页面有两个可用提交按钮：无法唯一认定，宁可不发
  const ambiguous = await executorCheck('Your reply was sent.', '123', 'ambiguous');
  assert.strictEqual(ambiguous.sendClicks, 0, 'ambiguous submit buttons must not be clicked');
  assert.match(ambiguous.result.error, /不可用或未找到/);

  // X 发回复常常没有 toast，只关闭回复框：这种情况必须判成功，否则会把成功误报成未确认
  const closed = await executorCheck('', '123', 'composer-closed');
  assert.strictEqual(closed.result.ok, true, 'closed composer should count as sent');
  assert.strictEqual(closed.result.verifiedBy, 'composer-closed');
  assert.strictEqual(closed.likeClicks, 1, 'closed composer should still allow the like');

  // 既没有提示、回复框也没关：判为待核实，不点赞、不当普通失败
  const unsure = await executorCheck('Something unrelated');
  assert.strictEqual(unsure.result.ok, false);
  assert.strictEqual(unsure.result.uncertain, true, 'unverifiable send must be flagged uncertain');
  assert.strictEqual(unsure.likeClicks, 0);

  // 帖子内嵌引用帖时，第一个 time 链接属于被引用的那条：必须按 status id 认目标，不能认错
  const quoted = await executorCheck('Your reply was sent.', '123', 'known', 0, true);
  assert.strictEqual(quoted.result.ok, true, 'quoted post must not break target matching');
  assert.strictEqual(quoted.replyClicks, 1);

  // 页面所有链接都对不上目标 id，但路由（pathname）已确认是目标帖：用首篇 article 兜底，不能直接放弃
  const mismatched = await executorCheck('Your reply was sent.', '123', 'known', 0, false, true);
  assert.strictEqual(mismatched.result.ok, true, 'route-verified page must fall back to first article');
  assert.strictEqual(mismatched.replyClicks, 1);
  assert.strictEqual(mismatched.likeClicks, 1, 'like should also use the fallback article');

  // 虚拟列表：回复按钮要滚到 1200px 之后才挂载。按 0.4 屏步长走，不该反复空扫太多次
  const scrolled = await executorCheck('Your reply was sent.', '123', 'known', 1200);
  assert.strictEqual(scrolled.result.ok, true);
  assert.strictEqual(scrolled.replyClicks, 1, 'button that mounts after scrolling must still be clicked');
  assert.ok(scrolled.jumps <= 6, `过 1200px 不该跳这么多次（实际 ${scrolled.jumps}）`);

  // 根本不存在回复按钮：应停在"扫描到底"并报出来，而不是空转到超时
  const missing = await executorCheck('Your reply was sent.', '123', 'known', 1e9);
  assert.strictEqual(missing.replyClicks, 0);
  assert.match(missing.result.error, /未找到回复按钮/);

  // 原帖已删：整页只有一句"此帖不可用"，必须判成 gone（跳过并继续），而不是白扫二十秒后当普通失败
  const gone = await executorCheck('', '123', 'gone');
  assert.strictEqual(gone.result.gone, true, 'unavailable page must be flagged as gone');
  assert.strictEqual(gone.replyClicks, 0);
  assert.strictEqual(gone.sendClicks, 0);
  assert.strictEqual(gone.likeClicks, 0, 'gone post must not be liked');
  assert.match(gone.result.error, /已删除或不可用/);

  console.log('PASS: incomplete follower list, stale timer, target matching, send confirmation');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
