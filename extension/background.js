/* 后台：AI 草稿服务调用、发送队列调度（chrome.alarms 唤醒，抗 SW 休眠） */
importScripts('queue-store.js', 'filter-rules.js', 'ai-service.js', 'auto-review.js', 'original-store.js');

const RUNNER_KEY = 'xfa-runner-v1';
const ALARM_NAME = 'xfa-send';
/* 单条失败不中断整批，但连续失败到这个数就暂停：
 * 偶发失败（某帖按钮没渲染）可以放过，连续失败通常意味着账号受限、权限失效或页面改版。 */
const MAX_FAIL_STREAK = 5;

let runner = { running: false, nextAt: 0, lastError: '', idleReason: '', failStreak: 0 };
let scheduledTimer = null;
let processing = false;
let starting = false;
let clearing = false;
let scheduleGeneration = 0;
let stopRequested = false;

async function loadRunner() {
  const saved = await new Promise(r => chrome.storage.local.get(RUNNER_KEY, x => r(x[RUNNER_KEY])));
  if (saved) runner = { ...runner, ...saved };
  return runner;
}

async function saveRunner(patch) {
  runner = { ...runner, ...patch };
  await new Promise(r => chrome.storage.local.set({ [RUNNER_KEY]: runner }, r));
  return runner;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/* 仅生成原创草稿。中断的请求需要人工重试，避免后台重复调用。 */
let originalBusy = false;
const ORIGINAL_ALARM = 'xfa-original-due';
const originalReady = OriginalStore.recover().catch(e => console.error('原创草稿状态恢复失败', e));

/* 让 alarm 对齐下一次到期时间，SW 休眠也能被唤醒。
 * 有未完成任务（失败/中断）时不设闹钟，等用户点重试。 */
async function syncOriginalAlarm() {
  try {
    await chrome.alarms.clear(ORIGINAL_ALARM);
    const s = await OriginalStore.get();
    // 暂停期间不设闹钟；有未完成任务（失败/中断）时也不设，等用户处理
    if (s.enabled !== false && !s.task && typeof s.nextDueAt === 'number') {
      await chrome.alarms.create(ORIGINAL_ALARM, { when: s.nextDueAt });
    }
  } catch (e) { console.error('原创闹钟同步失败', e); }
}

async function processOriginal() {
  await originalReady;
  if (originalBusy) return;
  originalBusy = true;
  try {
    while (true) {
      const task = await OriginalStore.claimDue();
      if (!task) break;
      broadcast({ type: 'xfa-original-changed' });
      try {
        const result = await AIService.generateOriginal();
        // 原创帖硬规则：不合格不入库，标失败让用户一键重试生成
        const review = AutoReview.checkOriginalDraft(result.en);
        if (!review.ok) {
          await OriginalStore.fail(task.id, `原创草稿未通过校验：${review.reason}`);
          break;
        }
        await OriginalStore.complete(task.id, result.en);
      } catch (e) {
        await OriginalStore.fail(task.id, e.message);
        break;
      } finally { broadcast({ type: 'xfa-original-changed' }); }
    }
    await syncOriginalAlarm();
  } finally { originalBusy = false; }
}
originalReady.then(() => processOriginal()).catch(console.error);

/* ---------- 草稿生成 ---------- */

async function generateDrafts(regenerate = false) {
  let queue = await QueueStore.loadQueue();
  const pending = queue.filter(x => x.status === 'pending' || (regenerate && x.status === 'ready'));
  if (!pending.length) return { ok: true, generated: 0, autoApproved: 0, needReview: 0, message: '没有待生成草稿的帖子' };

  const cfg = await AIService.getConfig();
  const secrets = await AIService.getSecrets();
  const hasKey = cfg.provider === 'deepseek' ? !!secrets.deepseekKey : !!secrets.siliconflowKey;

  // 过审用上下文：本批已有的草稿文本、今天已经通过/已发过的好友
  const seenDrafts = new Set(queue.filter(x => x.draft).map(x => AutoReview.norm(x.draft)));
  const handleToday = new Set(queue.filter(x => ['approved', 'sent'].includes(x.status)).map(x => String(x.handle || '').toLowerCase()));
  // 已发出去就归档了，队列里查不到，靠当日 handle 账本兜住"同一人一天一条"
  for (const h of await QueueStore.todayHandles()) handleToday.add(h);
  // 时间线来源改用「本批去重」：同一人当天被访问过不影响它，但同一批里不重复
  const handleBatch = new Set();

  let generated = 0, autoApproved = 0, needReview = 0;
  const failures = [];
  // 超短回复（≤10 字）一批最多 5 条自动过审，其余回落人工，免得 20 条全是"典""乐"看着像刷屏
  let shortUsed = 0;
  for (const post of pending) {
    try {
      const draft = await AIService.generateDraft(post);
      // 重新生成时，队列里存着这条自己的旧草稿，不能拿它当"重复"把自己拦下
      const others = new Set(seenDrafts);
      if (post.draft) others.delete(AutoReview.norm(post.draft));
      let verdict = draft.source.startsWith('ai:')
        ? AutoReview.check({ post, draft, seenDrafts: others, handleToday, handleBatch })
        : { ok: false, reason: '模板兜底生成，需人工确认' };
      if (verdict.ok && AutoReview.isShortReply(draft.en) && shortUsed >= AutoReview.MAX_SHORT_PER_BATCH) {
        verdict = { ok: false, reason: `本批超短回复已达 ${AutoReview.MAX_SHORT_PER_BATCH} 条上限` };
      }
      const nextStatus = verdict.ok ? 'approved' : 'ready';
      const changed = await QueueStore.updateIfUnchanged(post.id, { status: post.status, draft: post.draft, draftSource: post.draftSource }, {
        status: nextStatus,
        draft: draft.en,
        draftKind: draft.kind,
        draftSource: draft.source,
        error: draft.fallbackReason || '',
        autoApproved: verdict.ok,
        autoReason: verdict.ok ? '自动过审：格式、语言、长度、去重均通过' : verdict.reason
      });
      if (changed) {
        generated++;
        if (verdict.ok) {
          autoApproved++;
          if (AutoReview.isShortReply(draft.en)) shortUsed++;
          const h = String(post.handle || '').toLowerCase();
          handleToday.add(h);
          handleBatch.add(h);
        } else needReview++;
        if (draft.source === 'template') failures.push(post.handle);
        seenDrafts.add(AutoReview.norm(draft.en));
      }
    } catch (e) {
      await QueueStore.updateIfUnchanged(post.id, { status: post.status, draft: post.draft, draftSource: post.draftSource }, { status: 'ready', error: e.message, autoApproved: false, autoReason: `生成失败：${e.message}` });
      needReview++;
    }
  }
  return {
    ok: true,
    generated,
    autoApproved,
    needReview,
    fallback: failures.length,
    hasKey,
    message: hasKey
      ? `已生成 ${generated} 条：自动过审 ${autoApproved} 条，需你审 ${needReview} 条${failures.length ? `（模板兜底 ${failures.length} 条）` : ''}`
      : `未配置密钥，${generated} 条全部用模板生成，需你逐条确认`
  };
}

/* ---------- 发送执行 ---------- */

function isWithinWorkHours(cfg) {
  const h = new Date().getHours();
  return h >= cfg.workStart && h < cfg.workEnd;
}

function randomDelay(cfg) {
  const a = Math.max(15, Number(cfg.minDelay) || 15);
  const b = Math.max(a, Number(cfg.maxDelay) || 120);
  return a + Math.floor(Math.random() * (b - a + 1));
}

/* 双保险调度：setTimeout 负责短间隔精确触发（SW 存活时）；
 * alarm 作为兜底（SW 被终止后仍能唤醒）。两者都到会由 runOne 开头的 clear 去重。 */
function scheduleNext(delaySec) {
  if (scheduledTimer !== null) clearTimeout(scheduledTimer);
  const generation = ++scheduleGeneration;
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + (delaySec + 25) * 1000 });
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    if (generation === scheduleGeneration) runOne().catch(console.error);
  }, delaySec * 1000);
}

function cancelScheduled() {
  scheduleGeneration++;
  if (scheduledTimer !== null) clearTimeout(scheduledTimer);
  scheduledTimer = null;
  chrome.alarms.clear(ALARM_NAME);
}

/* 等标签加载到目标地址。返回 { ok, redirected }。
 * redirected：页面已经加载完，却停在别的 x.com 地址——原帖被删/账号受限时 X 会把地址重定向走。
 * 这种情况不必再等到 25 秒超时，直接交给调用方按"这条帖子没了"处理。 */
async function waitForTabReady(tabId, expectPath, timeoutMs = 25000) {
  const start = Date.now();
  let redirectSeen = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = (tab.url || '').toLowerCase();
      if (tab.status === 'complete') {
        if (!expectPath || url.includes(expectPath.toLowerCase())) return { ok: true, redirected: false, url };
        if (url.startsWith('https://x.com/') && !/\/i\/flow|\/i\/challenge|\/account\/access|\/login/i.test(url)) {
          // 连续两次都停在别的地址才算重定向，避免 SPA 换址瞬间的误判
          if (++redirectSeen >= 2) return { ok: false, redirected: true, url };
        }
      } else redirectSeen = 0;
    } catch { return { ok: false, redirected: false, url: '' }; }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ok: false, redirected: false, url: '' };
}

/* 发送用的后台工作标签：整批只开一个，逐帖用 tabs.update 改地址。
 * 不再每帖 create/remove —— 那样标签栏会一条接一条地闪，也不像一个人连着看几个帖。
 * 页面不在目标帖上就继续等，避免把上一条的页面当成新帖去执行。 */
let workerTabId = null;

/* 扩展自己开的工作标签：X 页面悬浮窗不在这些标签里出现，免得遮挡页面或抢走输入焦点。
 * 记在 storage.session，SW 休眠重启后仍有效，浏览器关闭即清空。 */
const AUTOMATION_KEY = 'xfa-automation-tabs';
let automationTabs = null;

function automationSet() {
  automationTabs ??= (async () => {
    try { return new Set((await chrome.storage.session.get(AUTOMATION_KEY))[AUTOMATION_KEY] || []); }
    catch { return new Set(); }
  })();
  return automationTabs;
}

async function markAutomation(tabId, on = true) {
  if (!Number.isInteger(tabId)) return;
  const set = await automationSet();
  if (on) set.add(tabId);
  else if (!set.delete(tabId)) return;
  try { await chrome.storage.session.set({ [AUTOMATION_KEY]: [...set] }); } catch {}
}

async function createWorkTab(opts) {
  const tab = await chrome.tabs.create(opts);
  await markAutomation(tab.id);
  return tab;
}

chrome.tabs?.onRemoved?.addListener(id => { markAutomation(id, false); });

async function rememberWorker(id) {
  try { await chrome.storage.local.set({ 'xfa-worker-tab': id }); } catch {}
}

async function forgetWorker() {
  try { await chrome.storage.local.remove('xfa-worker-tab'); } catch {}
}

async function useWorkerTab(url, focus) {
  if (workerTabId !== null) {
    try { await chrome.tabs.get(workerTabId); } catch { workerTabId = null; }
  }
  if (workerTabId === null) {
    const tab = await createWorkTab({ url, active: !!focus });
    workerTabId = tab.id;
    rememberWorker(workerTabId);
    return workerTabId;
  }
  await chrome.tabs.update(workerTabId, { url, active: !!focus });
  return workerTabId;
}

function closeWorkerTab() {
  if (workerTabId === null) return;
  const id = workerTabId;
  workerTabId = null;
  forgetWorker();
  chrome.tabs.remove(id).catch(() => {});
}

async function executeOne(item, cfg) {
  const tabId = await useWorkerTab(item.url, cfg.focusTab);
  try {
    const ready = await waitForTabReady(tabId, `/${item.handle}/status/${item.id}`);
    if (!ready.ok) {
      // 地址被改走、且连 status id 都不在了 → 帖子被删/受限，跳过；不是这个 id 的地址差异按普通失败处理
      if (ready.redirected && !String(ready.url || '').includes(`/status/${item.id}`)) {
        const gone = Error('原帖已删除或不可用（页面被重定向到别处）');
        gone.gone = true; // 这条帖子没了，跳过它，别停整批
        throw gone;
      }
      throw Error('页面加载超时');
    }
    await new Promise(r => setTimeout(r, 1200));

    // 先加载执行器脚本，再带参数调用
    await chrome.scripting.executeScript({ target: { tabId }, files: ['executor-page.js'] });
    const call = await chrome.scripting.executeScript({
      target: { tabId },
      func: opts => window.__xfaExecutor ? window.__xfaExecutor(opts) : { ok: false, error: '执行器未加载' },
      args: [{ text: item.draft, expectHandle: item.handle, expectId: item.id }]
    });
    const result = call?.[0]?.result;
    if (!result) throw Error('执行器无返回结果');
    if (!result.ok) {
      const err = Error(result.error || '执行失败');
      if (result.uncertain) err.uncertain = true; // 结果未知：可能已发出，不能当普通失败重试
      if (result.gone) err.gone = true;           // 原帖已删：跳过这一条，整批继续
      throw err;
    }
    return result;
  } catch (e) {
    // 工作标签坏了就丢掉，下一条重新开
    if (/页面加载超时|执行器未加载|Receiving end does not exist|No tab with id/i.test(e.message || '')) closeWorkerTab();
    throw e;
  }
}

async function runOne() {
  if (processing) return;
  processing = true;
  try {
  await loadRunner();
  if (!runner.running || stopRequested) return;
  if (runner.inFlight) {
    await QueueStore.update(runner.inFlight, { status: 'uncertain', error: '上次执行意外中断，发送结果未知；请先到 X 核实，切勿直接重试' });
    await saveRunner({ running: false, inFlight: null, nextAt: 0, lastError: '上次执行意外中断，请先核实发送结果' });
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }
  if (runner.nextAt && Date.now() < runner.nextAt) return;
  cancelScheduled();

  const cfg = await AIService.getConfig();

  // 执行前先确认 scripting 权限仍有效，避免每条都失败
  const perm = { permissions: ['scripting'], origins: ['https://x.com/*'] };
  if (!await chrome.permissions.contains(perm)) {
    await saveRunner({ running: false, lastError: 'X 页面权限已被撤销，请点顶部的「授权 X」重新授权' });
    broadcast({ type: 'xfa-runner-status', runner: { ...runner, reason: '权限已撤销' } });
    return;
  }

  if (!isWithinWorkHours(cfg)) {
    await saveRunner({ running: false, idleReason: '已到非工作时段，自动停止' });
    broadcast({ type: 'xfa-runner-status', runner: { ...runner, reason: '非工作时段' } });
    return;
  }

  const sentToday = await QueueStore.todaySentCount();
  if (sentToday >= cfg.dailyLimit) {
    await saveRunner({ running: false, idleReason: `已达今日上限 ${cfg.dailyLimit} 条` });
    broadcast({ type: 'xfa-runner-status', runner: { ...runner, reason: '达到每日上限' } });
    return;
  }

  const approveList = await QueueStore.list(x => x.status === 'approved');
  if (!approveList.length) {
    await saveRunner({ running: false, idleReason: '没有已审核通过的帖子' });
    broadcast({ type: 'xfa-runner-status', runner: { ...runner, reason: '队列已空' } });
    return;
  }

  const item = approveList[0];
  await loadRunner();
  if (!runner.running || stopRequested) return;
  await saveRunner({ inFlight: item.id, nextAt: 0 });
  let claimed;
  try { claimed = await QueueStore.claimForSend(item.id, item.draft, item.draftSource); }
  catch (e) {
    await saveRunner({ running: false, inFlight: null, nextAt: 0, lastError: `无法锁定草稿：${e.message}` });
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }
  if (!claimed) {
    await saveRunner({ running: false, inFlight: null, nextAt: 0, lastError: '草稿或审核状态已改变，请重新检查后再启动' });
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }
  broadcast({ type: 'xfa-runner-progress', id: item.id, handle: item.handle });
  let ok = false;
  let error = '';
  try {
    const result = await executeOne(item, cfg);
    ok = true;
    // 原创触发器改为时间间隔，与回复发送解耦，这里不再计数
    await QueueStore.update(item.id, { status: 'sent', sentAt: new Date().toISOString(), error: '', liked: !!result.liked });
    await QueueStore.incrementDaily();
    await QueueStore.addDailyHandle(item.handle);
    await QueueStore.archive(item.id); // 已发送条目移出队列，计数由 daily 独立维护
  } catch (e) {
    error = e.message || '执行失败';
    const gone = !!e.gone;
    const status = gone ? 'skipped' : (e.uncertain ? 'uncertain' : 'failed');
    await QueueStore.update(item.id, { status, error });
    // 原帖已删：标「已跳过」并归档（进历史，之后不会再被采集到），队列不会被死帖堵住
    if (gone) await QueueStore.archive(item.id);

    /* 单条失败不再打断整批。连续失败计数达到上限才停：
     * 偶发的按钮没渲染可以放过，连续失败通常说明账号受限/权限失效/页面改版。 */
    const streak = Number(runner.failStreak || 0) + 1;
    await loadRunner();
    const streakReason = `连续 ${streak} 条失败，已自动暂停`;
    if (!runner.running || stopRequested) {
      await saveRunner({ running: false, inFlight: null, nextAt: 0, failStreak: streak, lastError: error });
      broadcast({ type: 'xfa-runner-status', runner });
      return;
    }
    if (streak >= MAX_FAIL_STREAK) {
      await saveRunner({ running: false, inFlight: null, nextAt: 0, failStreak: streak,
        lastError: `${streakReason}：${error}`, idleReason: streakReason });
      broadcast({ type: 'xfa-runner-status', runner: { ...runner, reason: streakReason } });
      return;
    }
    const delay = randomDelay(cfg);
    await saveRunner({ inFlight: null, nextAt: Date.now() + delay * 1000, failStreak: streak, lastError: error });
    scheduleNext(delay);
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }

  broadcast({ type: 'xfa-runner-done', id: item.id, ok });
  await loadRunner();
  if (!runner.running || stopRequested) {
    await saveRunner({ inFlight: null, nextAt: 0 });
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }
  const delay = randomDelay(cfg);
  // 成功一条就把连续失败计数清零，只有真正连成片才停
  await saveRunner({ inFlight: null, nextAt: Date.now() + delay * 1000, failStreak: 0, lastError: '' });
  if (stopRequested) {
    await saveRunner({ running: false, nextAt: 0, idleReason: '已手动停止' });
    broadcast({ type: 'xfa-runner-status', runner });
    return;
  }
  scheduleNext(delay);
  broadcast({ type: 'xfa-runner-status', runner });
  } finally {
    processing = false;
    // 一批结束（或被停止）才回收工作标签；还有下一条在排队就留着复用
    if (!runner.running || stopRequested) closeWorkerTab();
  }
}

/* ---------- 时间线采集 ---------- */

let timelineBusy = false;

/* 首页时间线只读采集：开一个隐身后台标签滚动 feed，
 * 只按「非广告、非阿拉伯文、回复按钮可见、浏览量≥门槛」过滤后入队——不再限制作者是否在互关名单里，
 * 名单若传入则作为可选范围（默认不传＝全收）。后续草稿/审核/发送与名单采集完全共用。 */
/* 嗅探式采集：让页面主世界的 timeline-sniff.js 读 X 自己的接口响应，
 * 需要更多时用同一套请求模板带 cursor 连翻（间隔取设置里的区间）。
 * 任何一步失败都返回 ok:false，由调用方退回滚动采集。 */
async function sniffTimeline(tabId, opts) {
  try {
    const call = await chrome.scripting.executeScript({
      target: { tabId },
      func: o => new Promise(resolve => {
        const id = 'r' + Math.random().toString(36).slice(2);
        let timer = null;
        const finish = r => {
          if (timer) clearTimeout(timer);
          try { window.removeEventListener('message', on); } catch {}
          resolve(r || { ok: false, error: '空结果' });
        };
        function on(ev) {
          const d = ev.data;
          if (!d || d.__xfa !== 'tl-res' || d.id !== id) return;
          finish(d.result);
        }
        timer = setTimeout(() => finish({ ok: false, error: '嗅探超时' }), o.timeoutMs);
        window.addEventListener('message', on);
        try { window.postMessage({ __xfa: 'tl-req', cmd: 'collect', id, opts: o }, location.origin); }
        catch (e) { finish({ ok: false, error: '无法与页面通信：' + (e.message || e) }); }
      }),
      args: [opts]
    });
    return call?.[0]?.result || null;
  } catch (e) {
    return { ok: false, error: `注入失败：${e.message || e}` };
  }
}

async function collectTimeline(message) {
  if (timelineBusy) throw Error('时间线采集正在进行，请稍候');
  if (processing || runner.running) throw Error('发送流程运行中，请先停止再采集');
  const allowed = new Set((Array.isArray(message.allowedHandles) ? message.allowedHandles : [])
    .map(h => String(h || '').replace(/^@/, '').toLowerCase())
    .filter(h => /^[a-z0-9_]{1,15}$/.test(h)));

  timelineBusy = true;
  let tabId = null;
  const skipped = { ad: 0, arabic: 0, noReply: 0, notInRoster: 0, noViews: 0, lowViews: 0 };
  const minViews = Math.max(0, Number(message.minViews) || 500);
  const target = Math.max(1, Number(message.target) || 20);
  const conf = await AIService.getConfig().catch(() => ({}));
  const gapMin = Math.max(1000, (Number(conf.tlGapMin) || 3) * 1000);
  const gapMax = Math.max(gapMin, (Number(conf.tlGapMax) || 6) * 1000);
  try {
    const tab = await createWorkTab({ url: 'https://x.com/home', active: false });
    tabId = tab.id;
    const ready = await waitForTabReady(tabId, '/home');
    if (!ready.ok) throw Error('首页时间线加载失败或被重定向，请确认登录状态');
    await new Promise(r => setTimeout(r, 1000));

    /* ① 先走接口嗅探（页面自己发的 HomeTimeline 响应 + 主动翻页）。
     * 首屏那份响应通常就有 20 条，等于不用滚就已经拿到一屏；
     * 目标更多时按设置的间隔继续带 cursor 翻页。 */
    let result = null;
    let fallbackNote = '';
    const fastOn = message.fast != null ? !!message.fast : conf.tlFast !== false;
    if (fastOn) {
      /* 一页原始 20 条上下，过筛（去广告/阿语/无浏览/低浏览/不可回复）后大约剩一半，
       * 所以按 target/12 估页数，再留两页余量；上限 16 页，防止目标填太大把请求打爆。 */
      const maxPages = Math.min(16, Math.max(3, Math.ceil(target / 12) + 2));
      const fast = await sniffTimeline(tabId, {
        target,
        minViews,
        gapMin,
        gapMax,
        maxPages,
        templateWaitMs: 6000,
        timeoutMs: 180000
      });
      if (fast && fast.ok && Array.isArray(fast.cards) && fast.cards.length) {
        result = {
          ok: true,
          candidates: fast.cards,
          hits: fast.hits || 0,
          reachedTarget: !!fast.reachedTarget,
          replayFail: fast.replayFail || 0,
          diagnostic: fast.diag || 'mode=sniff'
        };
      } else if (fast && fast.cards && fast.cards.length) {
        // 翻页中途失败但已经拿到部分数据：用这批，别让它白跑
        result = {
          ok: true,
          candidates: fast.cards,
          hits: fast.hits || 0,
          reachedTarget: !!fast.reachedTarget,
          replayFail: fast.replayFail || 0,
          diagnostic: (fast.diag || 'mode=sniff') + ' partial=1'
        };
      } else {
        fallbackNote = String((fast && fast.error) || '接口没返回数据').replace(/\s+/g, '_').slice(0, 80);
      }
    }

    /* ② 嗅探不可用时退回原来的滚动采集，诊断串前面标明原因 */
    const scrollOpts = {
      maxScrolls: Number(message.maxScrolls) || 30,
      maxCandidates: Number(message.maxCandidates) || 60,
      minViews,
      target,
      allowedHandles: [...allowed]
    };
    const runScroll = async () => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['timeline-page.js'] });
      const call = await chrome.scripting.executeScript({
        target: { tabId },
        func: opts => window.__xfaTimeline ? window.__xfaTimeline(opts) : { ok: false, error: '时间线执行器未加载' },
        args: [scrollOpts]
      });
      return call?.[0]?.result;
    };

    if (!result) {
      result = await runScroll();
      if (!result || !result.ok) throw Error(result?.error || '时间线采集无返回结果');
      result.diagnostic = `fallback=${fallbackNote || 'off'} ${result.diagnostic}`;
    } else if (result.replayFail && !result.reachedTarget) {
      /* 重放被拒（多半是 x-client-transaction-id 校验）：隐藏标签里页面自己不加载更多，
       * 光靠「滚一屏读响应」攒不够。补跑一遍 DOM 滚动，两批按 id 合并。 */
      const extra = await runScroll().catch(() => null);
      if (extra && extra.ok && Array.isArray(extra.candidates)) {
        const ids = new Set(result.candidates.map(c => c.id));
        let merged = 0;
        for (const c of extra.candidates) {
          if (c && c.id && !ids.has(c.id)) { ids.add(c.id); result.candidates.push(c); merged++; }
        }
        result.hits = (result.hits || 0) + (extra.hits || 0);
        result.reachedTarget = !!extra.reachedTarget || result.hits >= target;
        result.diagnostic += ` +scroll=${merged}`;
      }
    }

    const picked = [];
    for (const c of result.candidates) {
      if (c.promoted) { skipped.ad++; continue; }
      if (c.arabic) { skipped.arabic++; continue; }   // 阿拉伯文帖：看不懂也接不上话
      if (!c.replyVisible) { skipped.noReply++; continue; }
      // 名单只在显式传入时当作范围限定；默认全收（只排除广告）
      if (allowed.size && !allowed.has(String(c.handle || '').toLowerCase())) { skipped.notInRoster++; continue; }
      // 热帖门槛：读不到浏览数的新帖不碰（无法判断），低于门槛的不互动
      if (c.views == null) { skipped.noViews++; continue; }
      if (c.views < minViews) { skipped.lowViews++; continue; }
      picked.push({
        id: c.id,
        handle: c.handle,
        url: c.url,
        text: c.text || '',
        date: c.date || '',
        type: c.quoted ? '引用' : '原创',
        source: 'timeline'
      });
    }
    const added = await QueueStore.addPosts(picked);
    return {
      ok: true,
      added,
      scanned: result.candidates.length,
      target,
      eligible: result.hits || 0,
      reachedTarget: !!result.reachedTarget,
      skipped,
      diagnostic: result.diagnostic
    };
  } finally {
    timelineBusy = false;
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/* ---------- 消息路由 ---------- */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* X 页面悬浮球：授予 X 页面权限后注册为内容脚本（沿用 0.4 的 id，覆盖旧注册）。
 * 刚授权或刚安装/更新时，顺手注入已经打开的 X 标签，不必刷新页面。 */
const FLOAT_SCRIPT = { id: 'xfa-ball', matches: ['https://x.com/*'], js: ['floating.js'], runAt: 'document_idle', persistAcrossSessions: true };

async function ensureFloatScript(injectOpenTabs) {
  try {
    if (!chrome.scripting?.registerContentScripts) return;
    if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: ['https://x.com/*'] })) return;
    const found = await chrome.scripting.getRegisteredContentScripts({ ids: [FLOAT_SCRIPT.id] });
    if (found.length) await chrome.scripting.updateContentScripts([FLOAT_SCRIPT]);
    else await chrome.scripting.registerContentScripts([FLOAT_SCRIPT]);
    if (!injectOpenTabs) return;
    for (const t of await chrome.tabs.query({ url: 'https://x.com/*' })) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['floating.js'] }).catch(() => {});
    }
  } catch (e) { console.warn('悬浮窗脚本注册失败', e); }
}

ensureFloatScript(false);
chrome.runtime.onInstalled?.addListener(() => ensureFloatScript(true));
chrome.permissions?.onAdded?.addListener(() => ensureFloatScript(true));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // 仅接受扩展自身页面/内容脚本的消息
  if (sender.id !== chrome.runtime.id) return;

  if (message.type === 'xfa-float-init') {
    automationSet().then(set => respond({ ok: true, automation: !!sender.tab && set.has(sender.tab.id) }));
    return true;
  }

  // 工作台页面自己开的采集标签（读主页、读名单）也登记为工作标签；内容脚本不能自我登记
  if (message.type === 'xfa-mark-automation') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    markAutomation(message.tabId).then(() => respond({ ok: true }));
    return true;
  }

  if (message.type === 'xfa-open-panel' && sender.tab && sender.url?.startsWith('https://x.com/')) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(() => respond({ ok: true })).catch(e => respond({ error: e.message }));
    return true;
  }

  if (message.type === 'xfa-generate-drafts') {
    generateDrafts(message.regenerate === true).then(respond).catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-original-retry') {
    (async () => { await originalReady; const ok = await OriginalStore.retry(); if (ok) processOriginal().catch(console.error); respond({ ok }); })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-original-toggle') {
    (async () => {
      await originalReady;
      await OriginalStore.setEnabled(!!message.enabled);
      await syncOriginalAlarm();
      broadcast({ type: 'xfa-original-changed' });
      respond({ ok: true });
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-original-publish') {
    (async () => {
      await originalReady;
      const owner = String(message.owner || '').replace(/^@/, '');
      const text = String(message.text || '').trim();
      if (!/^[A-Za-z0-9_]{1,15}$/.test(owner) || !text || text.length > 280) { respond({ ok: false, message: '账号或草稿无效' }); return; }
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: ['https://x.com/*'] })) { respond({ ok: false, message: '请先授权 X 页面访问' }); return; }
      if (!await OriginalStore.claimPublish(message.id, text)) { respond({ ok: false, message: '草稿已变化、正在发布或需要先核实' }); return; }
      broadcast({ type: 'xfa-original-changed' });
      let tabId = null, attempted = false, outcome;
      try {
        const tab = await createWorkTab({ url: 'https://x.com/compose/post', active: false }); tabId = tab.id;
        await chrome.storage.local.set({ 'xfa-original-tab': tabId }).catch(() => {});
        if (!(await waitForTabReady(tabId, '/compose/')).ok) throw Error('发帖页面加载失败，未发布');
        await chrome.scripting.executeScript({ target: { tabId }, files: ['original-publish-page.js'] });
        attempted = true;
        const result = await chrome.scripting.executeScript({ target: { tabId }, func: opts => window.__xfaPublishOriginal ? window.__xfaPublishOriginal(opts) : { ok: false, error: '发布器未加载' }, args: [{ owner, text }] });
        outcome = result?.[0]?.result || { ok: false, uncertain: true, error: '发布器无返回结果，请先核实' };
      } catch (e) { outcome = { ok: false, uncertain: attempted, error: attempted ? '发布结果未知，请先在 X 核实' : e.message }; }
      const status = outcome.ok ? 'published' : outcome.uncertain ? 'uncertain' : 'failed';
      await OriginalStore.finishPublish(message.id, status, outcome.error || '');
      if (tabId !== null && status !== 'uncertain') {
        chrome.tabs.remove(tabId).catch(() => {});
        await chrome.storage.local.remove('xfa-original-tab').catch(() => {});
      }
      // uncertain 时保留标签与记录，等用户核实；onStartup 兜底清理崩溃遗留
      broadcast({ type: 'xfa-original-changed' });
      respond({ ok: outcome.ok, uncertain: !!outcome.uncertain, message: outcome.ok ? '原创帖子已发布' : outcome.error });
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-original-resolve') {
    (async () => {
      const ok = await OriginalStore.resolvePublish(message.id, message.published === true);
      if (ok) {
        // 用户已核实，保留的 compose 标签可以收掉
        const rec = await chrome.storage.local.get('xfa-original-tab').catch(() => ({}));
        if (rec['xfa-original-tab'] !== undefined) {
          await chrome.tabs.remove(rec['xfa-original-tab']).catch(() => {});
          await chrome.storage.local.remove('xfa-original-tab').catch(() => {});
        }
      }
      broadcast({ type: 'xfa-original-changed' });
      respond({ ok });
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-timeline-collect') {
    (async () => {
      const perm = { permissions: ['scripting'], origins: ['https://x.com/*'] };
      if (!await chrome.permissions.contains(perm)) { respond({ ok: false, message: '请先点顶部的「授权 X」授予只读访问权限' }); return; }
      await loadRunner();
      const r = await collectTimeline(message);
      respond(r);
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-start-runner') {
    (async () => {
      if (processing || starting || clearing) { respond({ ok: false, message: '当前操作尚未结束，请稍候' }); return; }
      starting = true;
      stopRequested = false;
      try {
      await loadRunner();
      if (runner.inFlight) {
        await QueueStore.update(runner.inFlight, { status: 'uncertain', error: '上次执行意外中断，发送结果未知；请先到 X 核实，切勿直接重试' });
        await saveRunner({ running: false, inFlight: null, nextAt: 0, lastError: '上次执行意外中断，请先核实发送结果' });
        respond({ ok: false, message: '上次发送结果未知，请先到 X 核实' });
        return;
      }
      if (runner.running) { respond({ ok: false, message: '发送任务已经启动' }); return; }
      const cfg = await AIService.getConfig();
      if (!isWithinWorkHours(cfg)) { respond({ ok: false, message: '当前不在设定工作时段内' }); return; }
      const ready = await QueueStore.list(x => x.status === 'approved');
      if (!ready.length) { respond({ ok: false, message: '没有已审核通过的帖子' }); return; }
      const sentToday = await QueueStore.todaySentCount();
      if (sentToday >= cfg.dailyLimit) { respond({ ok: false, message: `已达今日上限 ${cfg.dailyLimit} 条` }); return; }
      if (stopRequested) { respond({ ok: false, message: '启动已取消' }); return; }
      const delay = randomDelay(cfg);
      await saveRunner({ running: true, nextAt: Date.now() + delay * 1000, lastError: '', idleReason: '', failStreak: 0 });
      if (stopRequested) {
        await saveRunner({ running: false, nextAt: 0, idleReason: '已手动停止' });
        respond({ ok: false, message: '启动已取消' });
        return;
      }
      scheduleNext(delay);
      respond({ ok: true, nextIn: delay });
      } finally { starting = false; }
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  if (message.type === 'xfa-stop-runner') {
    stopRequested = true;
    (async () => {
      cancelScheduled();
      await saveRunner({ running: false, nextAt: 0, idleReason: processing ? '已停止后续发送；当前帖子仍在处理，请等待结果' : '已手动停止' });
      respond({ ok: true });
    })();
    return true;
  }

  if (message.type === 'xfa-runner-status') {
    (async () => {
      await loadRunner();
      respond({ ok: true, runner });
    })();
    return true;
  }

  if (message.type === 'xfa-clear-data') {
    (async () => {
      if (processing || starting || clearing) { respond({ ok: false, message: '有任务正在处理，请等待结束后再清空' }); return; }
      clearing = true;
      try {
        await loadRunner();
        if (runner.running || runner.inFlight) { respond({ ok: false, message: '发送任务仍在运行或处理中，请停止并等待结束后再清空' }); return; }
        await QueueStore.clearAll();
        respond({ ok: true });
      } catch (e) { respond({ ok: false, message: e.message }); }
      finally { clearing = false; }
    })();
    return true;
  }

  if (message.type === 'xfa-test-ai') {
    (async () => {
      const cfg = await AIService.getConfig();
      const result = await AIService.generateDraft({
        handle: 'demo', type: '原创', text: 'Good morning! Coffee and a slow start today.', quoteText: ''
      });
      respond({ ok: true, result, provider: cfg.provider });
    })().catch(e => respond({ ok: false, message: e.message }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) runOne().catch(console.error);
  if (alarm.name === ORIGINAL_ALARM) processOriginal().catch(console.error);
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后，上一轮崩溃遗留的工作标签可能被会话恢复带回来，顺手清掉
  try {
    const rec = await chrome.storage.local.get('xfa-worker-tab');
    const leftover = rec['xfa-worker-tab'];
    if (leftover !== undefined) {
      await chrome.tabs.remove(leftover).catch(() => {});
      await forgetWorker();
    }
    // 原创 compose 标签的崩溃遗留（uncertain 时本应保留，重启后统一回收）
    const orec = await chrome.storage.local.get('xfa-original-tab');
    if (orec['xfa-original-tab'] !== undefined) {
      await chrome.tabs.remove(orec['xfa-original-tab']).catch(() => {});
      await chrome.storage.local.remove('xfa-original-tab').catch(() => {});
    }
    // 定向交友已停用；旧版留下的 xfa-follow-tab 记录顺手清掉，避免残留标签
    const frec = await chrome.storage.local.get('xfa-follow-tab');
    if (frec['xfa-follow-tab'] !== undefined) {
      await chrome.tabs.remove(frec['xfa-follow-tab']).catch(() => {});
      await chrome.storage.local.remove('xfa-follow-tab').catch(() => {});
    }
  } catch {}
  await loadRunner();
  if (runner.inFlight) {
    await QueueStore.update(runner.inFlight, { status: 'uncertain', error: '上次执行意外中断，发送结果未知；请先到 X 核实，切勿直接重试' });
    await saveRunner({ running: false, inFlight: null, nextAt: 0, lastError: '上次执行意外中断，请先核实发送结果' });
    return;
  }
  if (runner.running) {
    const delay = 30;
    await saveRunner({ nextAt: Date.now() + delay * 1000 });
    scheduleNext(delay);
  }
  // 到点的原创任务立即处理（浏览器关闭期间错过的时间也会在这一步补上），并重新对齐闹钟
  await processOriginal();
  await syncOriginalAlarm();
});
