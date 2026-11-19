/* 工作台 · 采集与发送（采集 + 审核 + 发送合一）
 *
 * 流程：读名单内好友主页 → 筛出目标帖入队 → 立刻送云端生成草稿 →
 *      通过多道校验的自动过审，不合格的留在这里等人看一眼 →
 *      点一次「开始发送」由后台按随机间隔整批推进。
 * 全程不调用 X 官方 API；采集只读，写操作只有你点过发送之后的回复与点赞。
 */
(function () {
  // 外层只是容器：采集一张卡片、队列一张卡片
  const panel = document.createElement('div');
  panel.innerHTML = `
  <section class="panel">
    <h2>采集目标帖</h2>
    <p class="muted">轮流读取互关好友主页，筛出原创帖与引用转发；采到即生成回复草稿，合格的自动过审。采集只读，不点赞、不回复。</p>
    <div class="actions">
      <label style="margin:0">本批好友数 <input id="col-batch" type="number" min="1" step="1" value="20" style="width:88px"> 人</label>
      <label style="margin:0">时间窗口 <select id="col-days"><option value="3">3 天内</option><option value="7" selected>7 天内</option><option value="30">30 天内</option></select></label>
    </div>
    <div class="actions">
      <button id="col-start" class="primary">开始采集</button>
      <button id="col-stop" disabled>停止</button>
      <button id="col-reset" title="下次采集从名单第一位好友开始">从第一位好友重新开始</button>
    </div>
    <p id="col-gate" class="gate" hidden></p>
    <p id="col-status" aria-live="polite">等待开始</p>
  </section>
  <section class="panel">
    <h2>采集时间线</h2>
    <p class="muted">优先读 X 自己发出的时间线接口响应（首屏不用滚就有约 20 条），不够再按设置里的间隔主动翻页；拿不到接口数据才退回滚动。只要不是广告、不是阿拉伯语帖、且有浏览量的热帖都会采（不限制作者是否在互关名单里），入队后与目标帖共用同一套草稿、审核和发送流程。</p>
    <div class="actions">
      <label style="margin:0">目标条数 <input id="tl-target" type="number" min="1" step="1" value="20" style="width:80px"> 条</label>
      <label style="margin:0">浏览量 ≥ <input id="tl-minviews" type="number" min="0" step="10" value="500" style="width:96px"></label>
      <label style="margin:0">最多滚动 <input id="tl-maxscrolls" type="number" min="1" step="1" value="30" style="width:70px"> 屏 <small class="muted">仅滚动兜底时生效</small></label>
    </div>
    <div class="actions">
      <button id="tl-start">采集时间线</button>
      <label style="margin:0"><input id="tl-autosend" type="checkbox" checked> 采完整批后自动发送已过审的</label>
    </div>
    <p id="tl-status" class="muted" aria-live="polite"></p>
  </section>
  <section class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h2 style="margin:0">回复队列</h2>
      <small class="muted"><span class="kbd">Enter</span> 通过　<span class="kbd">S</span> 跳过　<span class="kbd">E</span> 编辑　<span class="kbd">↑↓</span> 切换</small>
    </div>
    <div class="seg" role="group" aria-label="筛选队列">
      <button id="rv-f-review" aria-pressed="true">待你确认</button>
      <button id="rv-f-approved" aria-pressed="false">待发</button>
      <button id="rv-f-problem" aria-pressed="false">需核实</button>
    </div>
    <div class="actions">
      <button id="rv-start" class="primary">开始发送</button>
      <button id="rv-stop" class="danger" disabled>停止发送</button>
      <button id="rv-drafts" title="只处理“待你确认”的条目，保留你手动改过的草稿">重新生成未过审草稿</button>
      <button id="rv-refresh">刷新</button>
    </div>
    <p id="rv-runner" class="status" aria-live="polite"></p>
    <div id="rv-list"></div>
  </section>`;
  const host = document.querySelector('#tab-work');
  host.insertBefore(panel, null);

  const el = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CURSOR_KEY = 'xfa-collect-cursor-v1';
  const BATCH_KEY = 'xfa-collect-batch-v1';

  /* 本批好友数：自由填写，记住上次的值，省得每次重填 */
  try {
    const savedBatch = Number(localStorage.getItem(BATCH_KEY));
    if (Number.isFinite(savedBatch) && savedBatch >= 1) el('col-batch').value = String(Math.floor(savedBatch));
  } catch {}
  el('col-batch').onchange = () => {
    const v = Math.floor(Number(el('col-batch').value));
    if (!Number.isFinite(v) || v < 1) return;
    try { localStorage.setItem(BATCH_KEY, String(v)); } catch {}
  };
  const DRAFT_MIN = 12, DRAFT_MAX = 240; // 与 auto-review.js 的长度要求一致
  const FILTERS = {
    review: ['pending', 'ready'],
    approved: ['approved', 'sending'],
    problem: ['failed', 'uncertain']
  };
  let busy = false;
  let cancelled = false;
  let all = [];
  let items = [];
  let filter = 'review';
  let activeId = null;
  let renderDeferred = false;
  let runnerState = { running: false, nextAt: 0 };
  const pendingSkips = new Map(); // id → 撤销计时器

  const say = t => el('col-status').textContent = t;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const stopCheck = () => { if (cancelled) throw Error('已手动停止采集'); };
  const emit = name => { try { window.dispatchEvent(new CustomEvent(name)); } catch {} };

  /* ---------- 名单与游标 ---------- */

  function loadRoster() {
    try {
      const raw = JSON.parse(localStorage.getItem('x-friends-roster-v1') || '{}');
      return {
        owner: String(raw.owner || '').replace(/^@/, ''),
        following: Array.isArray(raw.following) ? raw.following : [],
        excluded: Array.isArray(raw.excluded) ? raw.excluded : [],
        confirmed: !!raw.confirmed
      };
    } catch { return { owner: '', following: [], confirmed: false }; }
  }

  function loadCursor() {
    try {
      const v = JSON.parse(localStorage.getItem(CURSOR_KEY) || '{}');
      return { owner: String(v.owner || ''), cursor: Number(v.cursor) || 0 };
    } catch { return { owner: '', cursor: 0 }; }
  }

  function saveCursor(owner, cursor) {
    try { localStorage.setItem(CURSOR_KEY, JSON.stringify({ owner, cursor })); } catch {}
  }

  /* 条件不满足时直接禁用按钮并写明原因，而不是点了才报错 */
  function updateGate() {
    if (busy) return;
    const roster = loadRoster();
    const reason = !roster.following.length ? '还没有互关名单：先到「名单」页读取关注列表。'
      : !roster.confirmed ? '名单尚未确认：到「名单」页核对后勾选确认。'
      : '';
    el('col-start').disabled = !!reason;
    el('tl-start').disabled = !!reason;
    el('col-gate').textContent = reason;
    el('col-gate').hidden = !reason;
  }

  /* ---------- 队列列表 ---------- */

  function badge(it) {
    if (it.status === 'approved' && it.autoApproved) return '<span class="badge approved">自动过审 · 待发</span>';
    const map = { pending: '生成草稿中', ready: '待你确认', approved: '已通过 · 待发', sending: '正在发送', sent: '已发送', failed: '发送失败', uncertain: '结果待核实', skipped: '已跳过' };
    return `<span class="badge ${it.status}">${map[it.status] || it.status}</span>`;
  }

  function counterHtml(id, text) {
    const n = String(text || '').trim().length;
    const bad = n > DRAFT_MAX || (n > 0 && n < DRAFT_MIN);
    return `<small class="cnt${bad ? ' over' : ''}" data-cnt="${esc(id)}">${n} / ${DRAFT_MAX}</small>`;
  }

  function editingInList() {
    const a = document.activeElement;
    return !!(a && a.tagName === 'TEXTAREA' && a.dataset?.id && el('rv-list').contains?.(a));
  }

  async function refresh() {
    all = await QueueStore.loadQueue();
    const allowed = FILTERS[filter];
    const order = { ready: 0, pending: 1, uncertain: 0, failed: 1, approved: 0, sending: -1 };
    items = all
      .filter(x => allowed.includes(x.status) && !pendingSkips.has(x.id))
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    if (!items.some(x => x.id === activeId)) activeId = items[0]?.id ?? null;
    drawFilters();
    drawSendButton();
    updateGate();
    // 正在编辑草稿时不整体重绘，否则光标和输入会被冲掉；离开输入框后再补画
    if (editingInList()) { renderDeferred = true; return; }
    render();
  }

  function countOf(name) {
    return all.filter(x => FILTERS[name].includes(x.status) && !pendingSkips.has(x.id)).length;
  }

  function drawFilters() {
    const labels = { review: '待你确认', approved: '待发', problem: '需核实' };
    for (const name of Object.keys(FILTERS)) {
      const b = el('rv-f-' + name);
      b.textContent = `${labels[name]} ${countOf(name)}`;
      b.setAttribute?.('aria-pressed', String(filter === name));
    }
  }

  function drawSendButton() {
    const n = all.filter(x => x.status === 'approved').length;
    if (runnerState.running) return;
    el('rv-start').textContent = n ? `开始发送 ${n} 条` : '开始发送';
    el('rv-start').disabled = !n;
    el('rv-start').title = n ? '按设置的随机间隔逐条发送，可随时停止' : '没有已通过的帖子';
  }

  function cardActions(it) {
    const id = esc(it.id);
    const view = `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">查看原帖</a>`;
    if (it.status === 'sending') return `${view}<span class="muted">正在发送，请稍候…</span>`;
    if (it.status === 'uncertain') return `${view}
      <button data-act="mark-sent" data-id="${id}">已在 X 看到回复</button>
      <button data-act="requeue" data-id="${id}">确认没发出，重新加入待发</button>
      <button data-act="skip" data-id="${id}">跳过</button>`;
    if (it.status === 'failed') return `${view}
      <button data-act="requeue" data-id="${id}">重新加入待发</button>
      <button data-act="skip" data-id="${id}">跳过</button>`;
    if (it.status === 'approved') return `${view}
      <button data-act="unapprove" data-id="${id}">撤回到待确认</button>
      <button data-act="skip" data-id="${id}">跳过</button>`;
    return `${view}
      <button class="primary" data-act="approve" data-id="${id}">通过</button>
      <button data-act="skip" data-id="${id}">跳过</button>`;
  }

  function render() {
    renderDeferred = false;
    if (!items.length) {
      const hints = Object.keys(FILTERS).filter(f => f !== filter && countOf(f))
        .map(f => `${{ review: '待你确认', approved: '待发', problem: '需核实' }[f]} ${countOf(f)} 条`);
      const empty = { review: '没有需要你确认的帖子。', approved: '没有待发的帖子。', problem: '没有失败或待核实的帖子。' }[filter];
      el('rv-list').innerHTML = `<p class="muted">${empty}${hints.length ? `其他分类：${hints.join('，')}。` : all.length ? '' : '先在上方采集目标帖。'}</p>`;
      return;
    }
    el('rv-list').innerHTML = items.map(it => {
      const active = it.id === activeId;
      const note = it.autoApproved
        ? `<p style="color:#067647;font-size:13px;margin:6px 0">✓ ${esc(it.autoReason || '自动过审')}</p>`
        : (it.status === 'ready' && it.autoReason)
          ? `<p class="muted" style="font-size:13px;margin:6px 0">未自动过审：${esc(it.autoReason)}</p>`
          : '';
      const problem = it.status === 'failed' || it.status === 'uncertain';
      const verify = it.status === 'uncertain'
        ? '<p class="warn" style="font-size:13px;margin:6px 0">回复可能已经发出。请先点「查看原帖」到 X 核实，再选择下面的操作。</p>' : '';
      return `<div class="rcard${problem ? ' failed' : ''}${active ? ' active' : ''}" data-id="${esc(it.id)}"${active ? ' aria-current="true"' : ''}>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <strong>@${esc(it.handle)}</strong>
          <span>${badge(it)} <small class="muted">${it.source === 'timeline' ? '时间线' : '名单'} · ${esc(it.date || '')}</small></span>
        </div>
        <div class="post" style="margin:10px 0">${esc(it.text || '（仅媒体帖子）')}${it.quoteText ? `\n引用内容：${esc(it.quoteText)}` : ''}</div>
        ${it.error ? `<p style="color:#b42318;font-size:13px">${esc(it.error)}</p>` : ''}
        ${verify}${note}
        <div style="display:flex;justify-content:space-between;align-items:baseline"><label style="margin:8px 0 6px">回复草稿${it.draftSource ? ` <small class="muted">（${esc(it.draftSource)}）</small>` : ''}</label>${counterHtml(it.id, it.draft)}</div>
        <textarea rows="2" data-id="${esc(it.id)}" ${['sending', 'uncertain'].includes(it.status) ? 'disabled' : ''} placeholder="${it.status === 'pending' ? '草稿生成中，也可以直接手写' : ''}">${esc(it.draft)}</textarea>
        <div class="actions">${cardActions(it)}</div>
      </div>`;
    }).join('');

    el('rv-list').querySelectorAll('textarea').forEach(ta => {
      ta.oninput = async e => {
        const id = ta.dataset.id;
        const text = e.target.value;
        const it = items.find(x => x.id === id);
        const cnt = el('rv-list').querySelector(`[data-cnt="${CSS.escape(id)}"]`);
        if (cnt) cnt.outerHTML = counterHtml(id, text);
        if (it) {
          if (it.status === 'approved' && it.draft !== text) {
            it.status = 'ready';
            it.autoApproved = false;
            const label = ta.closest('.rcard')?.querySelector('.badge');
            if (label) { label.className = 'badge ready'; label.textContent = '已修改 · 需重新通过'; }
          }
          it.draft = text; it.draftSource = 'manual';
        }
        try { await QueueStore.editDraft(id, text); }
        catch (error) { el('rv-runner').textContent = error.message; await refresh(); }
      };
      ta.onfocus = () => setActive(ta.dataset.id, false);
      ta.onblur = () => { if (renderDeferred) setTimeout(() => { if (!editingInList()) refresh(); }, 0); };
    });

    el('rv-list').querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => act(btn.dataset.act, btn.dataset.id);
    });

    el('rv-list').querySelectorAll('.rcard').forEach(card => {
      card.onclick = e => {
        if (['TEXTAREA', 'BUTTON', 'A'].includes(e.target.tagName)) return;
        setActive(card.dataset.id, false);
      };
    });
  }

  /* 只切换高亮，不重绘列表 */
  function setActive(id, scroll = true) {
    activeId = id;
    el('rv-list').querySelectorAll('.rcard').forEach(card => {
      const on = card.dataset.id === id;
      card.classList.toggle('active', on);
      if (on) card.setAttribute('aria-current', 'true'); else card.removeAttribute('aria-current');
      if (on && scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function toast(text, undo) {
    document.querySelector('.toast')?.remove();
    const box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = text;
    box.append(span);
    if (undo) {
      const b = document.createElement('button');
      b.textContent = '撤销';
      b.onclick = () => { undo(); box.remove(); };
      box.append(b);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 5000);
  }

  /* 跳过先只在界面上隐藏，5 秒内可撤销，到时才真正归档 */
  function skipLater(item) {
    const idx = items.findIndex(x => x.id === item.id);
    const timer = setTimeout(async () => {
      pendingSkips.delete(item.id);
      try {
        await QueueStore.update(item.id, { status: 'skipped' });
        await QueueStore.archive(item.id);
      } catch (error) { el('rv-runner').textContent = error.message; }
      await refresh();
      emit('xfa-queue-changed');
    }, 5000);
    pendingSkips.set(item.id, timer);
    activeId = items[idx + 1]?.id ?? items[idx - 1]?.id ?? null;
    refresh();
    toast(`已跳过 @${item.handle}`, () => {
      clearTimeout(pendingSkips.get(item.id));
      pendingSkips.delete(item.id);
      activeId = item.id;
      refresh();
    });
  }

  async function act(kind, id) {
    const item = items.find(x => x.id === id);
    if (!item) return;
    if (item.status === 'sending') { el('rv-runner').textContent = '该帖子正在发送，请等待处理完成'; return; }
    const idx = items.indexOf(item);
    const next = items[idx + 1]?.id ?? items[idx - 1]?.id ?? null;
    try {
      if (kind === 'approve') {
        if (!item.draft.trim()) { el('rv-runner').textContent = '草稿为空，无法通过。请先填写回复内容。'; return; }
        await QueueStore.update(id, { status: 'approved', draft: item.draft, draftSource: item.draftSource, error: '' });
        activeId = next;
        toast(`已通过 @${item.handle}，进入待发`);
      } else if (kind === 'skip') {
        skipLater(item);
        return;
      } else if (kind === 'unapprove') {
        await QueueStore.update(id, { status: 'ready', autoApproved: false });
        activeId = next;
        toast(`@${item.handle} 已撤回到「待你确认」`);
      } else if (kind === 'requeue') {
        const msg = item.status === 'uncertain'
          ? `你已经在 X 上确认给 @${item.handle} 的回复没有发出？\n确认后会重新加入待发，可能被再次发送。`
          : `把给 @${item.handle} 的回复重新加入待发？`;
        if (!confirm(msg)) return;
        await QueueStore.update(id, { status: 'approved', error: '' });
        activeId = next;
      } else if (kind === 'mark-sent') {
        if (!confirm(`确认你已在 X 上看到给 @${item.handle} 的回复？\n会计入今日已发，并移出队列。`)) return;
        await QueueStore.update(id, { status: 'sent', sentAt: new Date().toISOString(), error: '' });
        await QueueStore.incrementDaily();
        await QueueStore.addDailyHandle(item.handle);
        await QueueStore.archive(id);
        activeId = next;
      }
    } catch (error) { el('rv-runner').textContent = error.message; await refresh(); return; }
    await refresh();
    emit('xfa-queue-changed');
  }

  function setFilter(name) {
    filter = name;
    activeId = null;
    refresh();
  }
  for (const name of Object.keys(FILTERS)) el('rv-f-' + name).onclick = () => setFilter(name);
  window.addEventListener('xfa-queue-filter', e => { if (FILTERS[e.detail]) setFilter(e.detail); });

  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' && e.key === 'Enter' && e.ctrlKey) {
      const id = e.target.dataset.id;
      if (id) { e.preventDefault(); act('approve', id); }
      return;
    }
    if (e.key === 'Escape' && tag === 'TEXTAREA') { e.target.blur(); return; }
    // 焦点在任何可交互控件上时都不抢键，Enter 留给按钮和链接本身
    if (['TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(tag)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (el('tab-work')?.hidden) return;
    if (!items.length) return;
    const pos = Math.max(0, items.findIndex(x => x.id === activeId));
    const cur = items[pos];
    if (!cur) return;
    const visible = !!el('rv-list').querySelector('.rcard.active');
    if (e.key === 'Enter' && ['pending', 'ready'].includes(cur.status)) {
      if (!visible) return;
      e.preventDefault(); act('approve', cur.id);
    } else if (e.key === 's' || e.key === 'S') { e.preventDefault(); act('skip', cur.id); }
    else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      const ta = el('rv-list').querySelector(`textarea[data-id="${CSS.escape(cur.id)}"]`);
      if (ta && !ta.disabled) { ta.focus(); ta.scrollIntoView({ block: 'center' }); }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(items[Math.min(items.length - 1, Math.max(0, pos + step))].id);
    }
  });

  /* ---------- 采集 ---------- */

  async function waitComplete(tabId, timeout = 20000) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return true;
      } catch { return false; }
      await wait(400);
    }
    return false;
  }

  async function ensurePermission() {
    const perm = { permissions: ['scripting'], origins: ['https://x.com/*'] };
    if (!await chrome.permissions.contains(perm)) throw Error('请先点顶部的「授权 X」授予只读访问权限');
  }

  async function readProfile(tabId, handle) {
    for (let i = 0; i < 12; i++) {
      stopCheck();
      await wait(1500);
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId }, func: readXPage, args: ['posts', handle, '']
        });
        const page = res?.[0]?.result;
        if (page && (page.posts.length || page.skipped.length)) return page;
      } catch (e) {
        if (/验证|限制|出错|受保护|页面已改变|不是 x\.com|未能确认登录/.test(e.message)) throw e;
      }
    }
    return null;
  }

  /* 采完一个人就立刻生成草稿并过审，不必等整批结束 */
  async function draftNow() {
    const gen = await chrome.runtime.sendMessage({ type: 'xfa-generate-drafts' });
    return { auto: Number(gen?.autoApproved) || 0, review: Number(gen?.needReview) || 0, message: gen?.message || '' };
  }

  el('col-start').onclick = async () => {
    if (busy) return;
    busy = true; cancelled = false;
    el('col-start').disabled = true; el('col-stop').disabled = false;
    el('col-gate').hidden = true;
    let tabId = null;
    let added = 0, autoTotal = 0, reviewTotal = 0, arabicDropped = 0;
    try {
      await ensurePermission();
      const roster = loadRoster();
      if (!roster.confirmed) throw Error('请先到「名单」页核对并勾选确认');
      roster.following = Roster.match(roster.following, roster.excluded);
      if (!roster.following.length) throw Error('请先到「名单」页读取或导入互关名单，并勾选确认');
      if (!roster.owner) throw Error('请先在「名单」页填写名单所属 X 用户名');

      const rawBatch = Number(el('col-batch').value);
      if (!Number.isFinite(rawBatch) || rawBatch < 1) throw Error('本批好友数请填 ≥1 的整数');
      const batch = Math.floor(rawBatch);
      const days = Number(el('col-days').value) || 7;
      let cur = loadCursor();
      if (cur.owner !== roster.owner) { cur = { owner: roster.owner, cursor: 0 }; }
      const total = roster.following.length;
      const startIdx = cur.cursor % total;
      const selected = [];
      for (let i = 0; i < Math.min(batch, total); i++) {
        selected.push(roster.following[(startIdx + i) % total]);
      }
      if (batch > total) say(`本批填写 ${batch} 人，名单共 ${total} 人，按 ${selected.length} 人推进`);

      const tab = await chrome.tabs.create({ url: 'https://x.com/' + selected[0].handle, active: false });
      tabId = tab.id;
      await chrome.runtime.sendMessage({ type: 'xfa-mark-automation', tabId }).catch(() => {});

      for (let i = 0; i < selected.length; i++) {
        stopCheck();
        const person = selected[i];
        say(`读取 ${i + 1}/${selected.length}：@${person.handle}　·　已入队 ${added} 条`);
        if (i) await chrome.tabs.update(tabId, { url: 'https://x.com/' + person.handle });
        if (!await waitComplete(tabId)) { say(`@${person.handle} 加载超时，跳过`); continue; }
        const page = await readProfile(tabId, person.handle);
        if (!page) { say(`@${person.handle} 未读到帖子，跳过`); continue; }
        if (page.owner.toLowerCase() !== roster.owner.toLowerCase()) throw Error('登录账号与名单所属账号不一致，已中止');

        const targets = FilterRules.filterPosts(page.posts, { days, maxPerUser: 1, includeQuotes: true });
        arabicDropped += page.posts.filter(p => FilterRules.isArabicPost(p)).length;
        if (targets.length) {
          const n = await QueueStore.addPosts(targets.map(t => ({ ...t, handle: person.handle })));
          added += n;
          if (n) {
            say(`@${person.handle} 采到 ${n} 条，正在生成草稿…　·　已入队 ${added} 条`);
            const g = await draftNow();
            autoTotal += g.auto; reviewTotal += g.review;
            await refresh();
            await wait(300);
          }
        }
        saveCursor(roster.owner, startIdx + i + 1);
      }

      // 兜底：还有 pending（中途生成失败或未触发的）再补一次
      const finalGen = await chrome.runtime.sendMessage({ type: 'xfa-generate-drafts' });
      autoTotal += Number(finalGen?.autoApproved) || 0;
      reviewTotal += Number(finalGen?.needReview) || 0;
      say(`采集完成：本轮入队 ${added} 条；自动过审 ${autoTotal} 条，待你确认 ${reviewTotal} 条。${arabicDropped ? `已跳过阿拉伯语帖 ${arabicDropped} 条。` : ''}${finalGen?.hasKey === false ? '（未配置 AI 密钥，草稿均为模板，请到「设置」填写）' : ''}`);
      try { localStorage.setItem('xfa-collected-once', '1'); } catch {}
      await refresh();
      emit('xfa-queue-changed');
    } catch (e) {
      say(e.message);
    } finally {
      if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
      busy = false; el('col-stop').disabled = true;
      el('col-start').disabled = false;
      updateGate();
    }
  };

  el('col-stop').onclick = () => { cancelled = true; say('正在停止，已入队的帖子保留。'); };
  el('col-reset').onclick = () => { saveCursor(loadRoster().owner, 0); say('下次采集将从名单第一位好友开始。'); };

  /* ---------- 时间线采集 ---------- */

  let tlBusyUi = false;
  const TL_OPTS_KEY = 'xfa-tl-opts-v1';
  const tlOpts = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(TL_OPTS_KEY) || '{}') || {}; } catch {}
    return {
      target: Math.max(1, Number(saved.target) || 20),
      minViews: Math.max(0, Number.isFinite(Number(saved.minViews)) ? Number(saved.minViews) : 500),
      maxScrolls: Math.max(1, Number(saved.maxScrolls) || 30),
      autoSend: saved.autoSend !== false
    };
  })();
  const tlInput = (id, key) => {
    const input = el(id);
    if (!input) return;
    input.value = String(tlOpts[key]);
    input.onchange = () => {
      const n = Number(input.value);
      if (!Number.isFinite(n)) { input.value = String(tlOpts[key]); return; }
      tlOpts[key] = Math.max(key === 'minViews' ? 0 : 1, Math.round(n));
      input.value = String(tlOpts[key]);
      try { localStorage.setItem(TL_OPTS_KEY, JSON.stringify(tlOpts)); } catch {}
    };
  };
  tlInput('tl-target', 'target');
  tlInput('tl-minviews', 'minViews');
  tlInput('tl-maxscrolls', 'maxScrolls');

  const autoSendBox = el('tl-autosend');
  if (autoSendBox) {
    autoSendBox.checked = tlOpts.autoSend;
    autoSendBox.onchange = () => {
      tlOpts.autoSend = !!autoSendBox.checked;
      try { localStorage.setItem(TL_OPTS_KEY, JSON.stringify(tlOpts)); } catch {}
    };
  }

  el('tl-start').onclick = async () => {
    if (tlBusyUi) return;
    if (busy) { el('tl-status').textContent = '名单采集进行中，请等它结束'; return; }

    tlBusyUi = true;
    el('tl-start').disabled = true;
    el('tl-status').textContent = `正在采集时间线：优先读 X 的接口响应（拿不到再退回滚动），攒够 ${tlOpts.target} 条即停…`;
    try {
      await ensurePermission();
      const r = await chrome.runtime.sendMessage({
        type: 'xfa-timeline-collect',
        target: tlOpts.target,
        minViews: tlOpts.minViews,
        maxScrolls: tlOpts.maxScrolls
      });
      if (!r?.ok) { el('tl-status').textContent = r?.message || '采集失败'; return; }
      const isSniff = String(r.diagnostic || '').startsWith('mode=sniff');
      const why = r.reachedTarget ? '已攒够目标条数' : (isSniff ? '接口没有更多分页了，提前结束' : '滚动到底或多次无新内容，提前结束');
      const via = isSniff ? '接口嗅探' : '滚动兜底';
      el('tl-status').textContent =
        `合格候选 ${r.eligible}/${r.target} 条（${why}，${via}），新入队 ${r.added} 条；跳过：广告 ${r.skipped.ad}、阿拉伯语帖 ${r.skipped.arabic || 0}、无回复按钮 ${r.skipped.noReply}、浏览量不足 ${r.skipped.lowViews}、读不到浏览数 ${r.skipped.noViews}。诊断：${r.diagnostic}`;
      if (r.added) {
        const gen = await chrome.runtime.sendMessage({ type: 'xfa-generate-drafts' });
        await refresh();
        emit('xfa-queue-changed');
        // 自动发送：已过审的（含时间线与名单来源）直接开跑，间隔/日上限/工作时段照旧由后台把关
        if (tlOpts.autoSend) {
          const dbg = gen && gen.autoApproved ? `自动过审 ${gen.autoApproved} 条，` : '没有自动过审的条目，';
          const start = await chrome.runtime.sendMessage({ type: 'xfa-start-runner' });
          const tail = start?.ok
            ? `已开跑，首条约 ${Math.round((start.nextIn || 0) / 60)} 分钟后发出`
            : `未开跑：${start?.message || '未知原因'}`;
          el('tl-status').textContent = `${el('tl-status').textContent}｜${dbg}${tail}`;
          if (start?.ok) drawRunner({ running: true, nextAt: Date.now() + (start.nextIn || 0) * 1000 });
        }
      }
    } catch (e) {
      el('tl-status').textContent = e.message;
    } finally {
      tlBusyUi = false;
      updateGate();
    }
  };

  /* ---------- 发送 ---------- */

  function drawRunner(r) {
    runnerState = r || runnerState;
    if (!runnerState.running) {
      el('rv-stop').disabled = true;
      drawSendButton();
      el('rv-runner').textContent = runnerState.idleReason || runnerState.lastError
        ? `已停止：${runnerState.idleReason || runnerState.lastError}`
        : '';
      return;
    }
    el('rv-start').disabled = true;
    el('rv-start').textContent = '发送中…';
    el('rv-stop').disabled = false;
    const left = Math.max(0, Math.ceil((runnerState.nextAt - Date.now()) / 1000));
    // 整批继续跑时，把上一条没发出去的原因带在状态行里，避免"少了一条却毫无提示"
    const note = runnerState.lastError ? `；上一条未发出：${String(runnerState.lastError).slice(0, 60)}` : '';
    el('rv-runner').textContent = (left
      ? `运行中：${left} 秒后发送下一条`
      : '运行中：正在处理当前帖子…') + note;
  }

  el('rv-start').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'xfa-start-runner' });
    if (!r?.ok) { el('rv-runner').textContent = r?.message || '启动失败'; return; }
    drawRunner({ running: true, nextAt: Date.now() + r.nextIn * 1000 });
  };

  el('rv-stop').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'xfa-stop-runner' });
    const status = await chrome.runtime.sendMessage({ type: 'xfa-runner-status' });
    drawRunner(status?.runner || { running: false, idleReason: '已手动停止' });
  };

  el('rv-drafts').onclick = async () => {
    el('rv-runner').textContent = '正在重新生成未过审草稿…';
    const r = await chrome.runtime.sendMessage({ type: 'xfa-generate-drafts', regenerate: true });
    el('rv-runner').textContent = r?.message || '生成失败';
    await refresh();
  };

  el('rv-refresh').onclick = refresh;

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'xfa-runner-status') { drawRunner(msg.runner); refresh(); }
    if (msg.type === 'xfa-runner-done') refresh();
    if (msg.type === 'xfa-runner-progress') { el('rv-runner').textContent = `正在发送给 @${msg.handle}…`; refresh(); }
  });

  setInterval(async () => {
    if (!runnerState.running) return;
    const r = await chrome.runtime.sendMessage({ type: 'xfa-runner-status' });
    if (r?.runner) drawRunner(r.runner);
  }, 2000);

  window.addEventListener('xfa-queue-changed', refresh);
  window.addEventListener('xfa-roster-changed', updateGate);
  refresh();
  chrome.runtime.sendMessage({ type: 'xfa-runner-status' }).then(r => r?.runner && drawRunner(r.runner)).catch(() => {});
})();
