/* 外壳：标签切换、顶部状态栏、唯一的 X 授权入口、首次使用引导。
 * 各功能面板只管自己的卡片，跨面板的“现在什么状态、下一步做什么”统一放这里。 */
(function () {
  const el = id => document.getElementById(id);
  const TAB_KEY = 'xfa-tab-v1';
  const ONBOARD_KEY = 'xfa-onboard-hidden';
  const perm = { permissions: ['scripting'], origins: ['https://x.com/*'] };
  let runner = { running: false, nextAt: 0 };

  // 嵌在 X 页面悬浮窗里时（?embed=1），标题栏由悬浮窗提供，这里隐藏页头
  if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embed');

  /* ---------- 标签 ---------- */

  const tabs = [...document.querySelectorAll('.tabs [data-tab]')];
  function showTab(name) {
    if (!el('tab-' + name)) name = 'work';
    for (const b of tabs) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      el('tab-' + b.dataset.tab).hidden = !on;
    }
    try { localStorage.setItem(TAB_KEY, name); } catch {}
    window.scrollTo(0, 0);
  }
  for (const b of tabs) b.onclick = () => showTab(b.dataset.tab);
  document.addEventListener('click', e => {
    const goto = e.target.closest?.('[data-goto]');
    if (goto) showTab(goto.dataset.goto);
  });
  window.addEventListener('xfa-goto-tab', e => showTab(e.detail));

  function gotoQueue(filter) {
    showTab('work');
    window.dispatchEvent(new CustomEvent('xfa-queue-filter', { detail: filter }));
    el('rv-list')?.closest('.panel')?.scrollIntoView({ block: 'start' });
  }
  el('sb-review').onclick = () => gotoQueue('review');
  el('sb-approved').onclick = () => gotoQueue('approved');
  el('sb-problem').onclick = () => gotoQueue('problem');

  /* ---------- 授权 ---------- */

  async function grant() {
    try { await chrome.permissions.request(perm); } catch {}
    refresh();
  }
  el('sb-grant').onclick = grant;
  el('ob-grant').onclick = grant;
  chrome.permissions.onAdded?.addListener(refresh);
  chrome.permissions.onRemoved?.addListener(refresh);

  /* ---------- 状态栏与引导 ---------- */

  const storageGet = (area, key) => new Promise(r => area.get(key, v => r(v?.[key])));

  async function hasAiKey() {
    const conf = await storageGet(chrome.storage.local, 'xfa-config-v1') || {};
    const session = await storageGet(chrome.storage.session, 'xfa-secret-v1') || {};
    if ((conf.provider || 'siliconflow') === 'deepseek') {
      const local = await storageGet(chrome.storage.local, 'xfa-deepseek-secret-v1') || {};
      return { ok: !!(local.deepseekKey || session.deepseekKey), conf };
    }
    const localSf = await storageGet(chrome.storage.local, 'xfa-siliconflow-secret-v1') || {};
    return { ok: !!(localSf.siliconflowKey || session.siliconflowKey), conf };
  }

  function rosterConfirmed() {
    try {
      const r = JSON.parse(localStorage.getItem('x-friends-roster-v1') || '{}');
      return !!r.confirmed && Array.isArray(r.following) && r.following.length > 0;
    } catch { return false; }
  }

  function drawRun() {
    const box = el('sb-run');
    if (!runner.running) {
      box.className = 'sbar-run';
      box.textContent = '未在发送';
      return;
    }
    const left = Math.max(0, Math.ceil((runner.nextAt - Date.now()) / 1000));
    box.className = 'sbar-run on';
    box.textContent = left ? `● 发送中 · 下一条 ${left}s` : '● 发送中 · 处理当前帖子';
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [queue, sent, granted, key] = await Promise.all([
        QueueStore.loadQueue(), QueueStore.todaySentCount(),
        chrome.permissions.contains(perm).catch(() => false), hasAiKey()
      ]);
      const count = list => queue.filter(x => list.includes(x.status)).length;
      const problem = count(['failed', 'uncertain']);
      el('sb-sent').textContent = sent;
      el('sb-limit').textContent = key.conf.dailyLimit ?? 30;
      el('sb-review-n').textContent = count(['pending', 'ready']);
      el('sb-approved-n').textContent = count(['approved', 'sending']);
      el('sb-problem-n').textContent = problem;
      el('sb-problem').hidden = !problem;
      el('tab-work-dot').textContent = problem;
      el('tab-work-dot').hidden = !problem;
      el('sb-grant').hidden = granted;

      let collected = false;
      try { collected = localStorage.getItem('xfa-collected-once') === '1'; } catch {}
      collected = collected || queue.length > 0 || sent > 0;
      const steps = { 'ob-key': key.ok, 'ob-perm': granted, 'ob-roster': rosterConfirmed(), 'ob-collect': collected };
      for (const [id, done] of Object.entries(steps)) el(id).classList.toggle('done', done);
      el('ob-grant').hidden = granted;
      let dismissed = false;
      try { dismissed = localStorage.getItem(ONBOARD_KEY) === '1'; } catch {}
      el('onboard').hidden = dismissed || Object.values(steps).every(Boolean);

      const r = await chrome.runtime.sendMessage({ type: 'xfa-runner-status' }).catch(() => null);
      if (r?.runner) runner = r.runner;
      drawRun();
    } catch {} finally { refreshing = false; }
  }

  async function refreshOriginal() {
    try {
      const s = await OriginalStore.get();
      const n = s.drafts.filter(d => d.publishStatus !== 'published').length + s.uncertain.length;
      el('tab-original-dot').textContent = n;
      el('tab-original-dot').hidden = !n;
    } catch {}
  }

  el('ob-hide').onclick = () => {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch {}
    el('onboard').hidden = true;
  };

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'xfa-runner-status' && msg.runner) { runner = msg.runner; drawRun(); }
    if (['xfa-runner-status', 'xfa-runner-done', 'xfa-runner-progress'].includes(msg.type)) refresh();
    if (msg.type === 'xfa-original-changed') refreshOriginal();
  });
  for (const name of ['xfa-queue-changed', 'xfa-roster-changed', 'xfa-config-changed']) window.addEventListener(name, refresh);
  setInterval(drawRun, 1000);
  setInterval(refresh, 3000);

  let saved = 'work';
  try { saved = localStorage.getItem(TAB_KEY) || 'work'; } catch {}
  showTab(saved);
  refresh();
  refreshOriginal();
})();
