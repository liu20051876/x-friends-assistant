/* 名单工作区（获取 + 确认 + 导出，单一面板）。
 * 两条入口：① 从 X 页面结构化只读分页读取关注/粉丝，按关系字段判定互关；
 *          ② 手动导入两份 CSV（完整关注 + 未回关），按差集算互关。
 * 两条路的产出统一写成同一份名单存储，采集面板只读这一份：
 *   following = 互关候选（仅明确互关，未知不进候选）
 *   excluded  = 确定未回关
 * 这样采集端 Roster.match(following, excluded) 是幂等的，不会把未知状态误当互关。 */
(() => {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>互关名单</h2>
    <p class="muted">读取你的关注列表，判定谁和你互关。全程只读，在后台标签进行，不点赞、不回复。</p>
    <label>名单所属 X 用户名 <input id="rs-owner" type="text" placeholder="@你的用户名" maxlength="16"></label>

    <div class="actions">
      <button id="rs-following" class="primary">读取关注列表</button>
      <button id="rs-followers" title="关注列表里有“状态未知”时用来补齐判定">读取粉丝列表（补齐未知）</button>
      <button id="rs-stop" disabled>停止</button>
    </div>
    <p id="rs-status" aria-live="polite">尚未读取</p>
    <div id="rs-progress-box" hidden>
      <progress id="rs-progress" max="100" value="0" style="width:100%;height:14px"></progress>
      <p id="rs-progress-text" class="muted" style="margin:6px 0 0">未开始</p>
    </div>

    <details id="rs-csv-box">
      <summary>手动导入 CSV（备用路径）</summary>
      <p class="muted">已经拿到两份 CSV 时用这里，不需要授权读取 X 页面。导入后会自动和结构化读取的结果对齐。</p>
      <div class="actions">
        <label class="file">导入完整关注 CSV<input id="rs-file-following" type="file" accept=".csv" hidden></label>
        <label class="file">导入未回关 CSV<input id="rs-file-excluded" type="file" accept=".csv" hidden></label>
      </div>
      <p id="rs-file-state" class="muted"></p>
      <p id="rs-csv-error" role="alert" style="color:#b42318"></p>
    </details>

    <div class="stats">
      <div><b id="rs-total">0</b><small>关注总数</small></div>
      <div><b id="rs-mutual">0</b><small>明确互关</small></div>
      <div><b id="rs-notmutual">0</b><small>未回关</small></div>
      <div><b id="rs-unknown">0</b><small>状态未知</small></div>
    </div>
    <p id="rs-complete" class="muted"></p>
    <p id="rs-diff" class="muted"></p>
    <p id="rs-unknown-hint" class="muted" hidden>有账号状态未知（X 没返回关系字段），点「读取粉丝列表」可补齐。未知账号不会进入互关候选。</p>

    <label><input id="rs-confirm" type="checkbox"> 我确认名单所属账号及来源，已核对采集总数和完整性</label>
    <p id="rs-confirm-hint" class="muted"></p>

    <div class="actions">
      <button id="rs-export-mutual">导出互关 CSV</button>
      <button id="rs-export-not">导出未回关 CSV</button>
      <button id="rs-apply" title="不访问 X，用上次读取到的数据重新计算互关">用上次读取结果重新判定</button>
    </div>

    <details>
      <summary>查看名单与搜索</summary>
      <div class="actions">
        <button id="rs-view-mutual">互关</button>
        <button id="rs-view-notmutual">未回关</button>
        <button id="rs-view-unknown">状态未知</button>
      </div>
      <label>搜索名称或用户名 <input id="rs-search" type="text" placeholder="搜索名称 / 用户名"></label>
      <p id="rs-list-count" class="muted"></p>
      <div id="rs-list" style="max-height:320px;overflow:auto"></div>
      <button id="rs-more" hidden>显示更多</button>
    </details>

    <div class="danger-zone">
      <button id="rs-clear" class="danger-outline">清除名单</button>
      <small class="muted">清除名单、读取缓存和互关判定；队列不受影响。</small>
    </div>`;
  document.querySelector('#tab-roster').insertBefore(panel, null);

  const el = id => document.getElementById(id);
  const CACHE_KEY = 'xfa-graph-cache-v1';
  const ROSTER_KEY = 'x-friends-roster-v1';
  const STOP_KEY = 'xfa-list-stop';
  let busy = false;
  let viewGroup = 'mutual';
  let viewLimit = 100;
  // 完整性警告（如“只读到 N / M”）单独保存，draw() 重绘时不能把它冲掉
  let warning = '';

  const say = t => el('rs-status').textContent = t;
  const notifyRoster = () => window.dispatchEvent(new CustomEvent('xfa-roster-changed'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const norm = u => { try { return new URL(u).pathname.toLowerCase().replace(/\/$/, ''); } catch { return ''; } };
  const setStop = v => { try { localStorage.setItem(STOP_KEY, v ? '1' : '0'); } catch {} };
  const shouldStop = () => { try { return localStorage.getItem(STOP_KEY) === '1'; } catch { return false; } };
  const cleanHandle = v => String(v || '').trim().replace(/^@/, '');
  const validOwner = v => /^[A-Za-z0-9_]{1,15}$/.test(cleanHandle(v));
  const toRows = list => list.map(u => ({ handle: u.handle, name: u.name || '' }));

  const perm = { permissions: ['scripting'], origins: ['https://x.com/*'] };

  /* ---------- 进度条 ----------
   * 分母来自页面顶部的“关注 1,234”。拿不到分母时退化为不确定态，
   * 不再假装有百分比。 */
  function setProgress(fetched, total) {
    const bar = el('rs-progress');
    const text = el('rs-progress-text');
    el('rs-progress-box').hidden = false;
    if (!total || total <= 0) {
      bar.removeAttribute('value');
      text.textContent = `已读取 ${fetched} 人（总数未知）`;
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((fetched / total) * 100)));
    bar.value = pct;
    text.textContent = `已读取 ${fetched} / ${total} 人（${pct}%）`;
  }

  function resetProgress() {
    const bar = el('rs-progress');
    bar.value = 0;
    el('rs-progress-box').hidden = false;
    el('rs-progress-text').textContent = '正在准备…';
  }

  /* ---------- 名单状态 ---------- */

  let state = {
    owner: '', source: '', confirmed: false,
    mutual: [], notMutual: [], unknown: [],
    rawFollowing: [], excluded: [],
    followingTotal: 0, followingFile: '', excludedFile: ''
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(ROSTER_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      // 兼容旧结构：老版本只存 following/excluded，没有分组的互关列表
      const mutual = Array.isArray(saved.mutual) ? saved.mutual : (Array.isArray(saved.following) ? saved.following : []);
      state = {
        owner: cleanHandle(saved.owner),
        source: saved.source || (saved.relationshipInfo ? 'structured' : ''),
        confirmed: !!saved.confirmed,
        mutual,
        notMutual: Array.isArray(saved.notMutual) ? saved.notMutual : (Array.isArray(saved.excluded) ? saved.excluded : []),
        unknown: Array.isArray(saved.unknown) ? saved.unknown : [],
        rawFollowing: Array.isArray(saved.rawFollowing) ? saved.rawFollowing : [],
        excluded: Array.isArray(saved.excluded) ? saved.excluded : [],
        followingTotal: Number(saved.followingTotal) || mutual.length,
        followingFile: saved.followingFile || '',
        excludedFile: saved.excludedFile || ''
      };
    } catch {}
  }

  /* 采集面板读的是 following/excluded/confirmed，这里统一按“互关候选 / 确定未回关”写出去。 */
  function saveState() {
    const payload = {
      owner: state.owner,
      source: state.source,
      confirmed: state.confirmed,
      mutual: state.mutual,
      notMutual: state.notMutual,
      unknown: state.unknown,
      rawFollowing: state.rawFollowing,
      following: state.mutual,
      excluded: state.notMutual,
      followingTotal: state.followingTotal,
      followingFile: state.followingFile,
      excludedFile: state.excludedFile,
      savedAt: new Date().toISOString()
    };
    try { localStorage.setItem(ROSTER_KEY, JSON.stringify(payload)); }
    catch { el('rs-csv-error').textContent = '无法保存名单，请检查浏览器存储空间。'; }
    notifyRoster();
  }

  function countAll() {
    if (state.followingTotal) return state.followingTotal;
    return state.mutual.length + state.notMutual.length + state.unknown.length;
  }

  function draw() {
    el('rs-owner').value = state.owner;
    el('rs-total').textContent = countAll();
    el('rs-mutual').textContent = state.mutual.length;
    el('rs-notmutual').textContent = state.notMutual.length;
    el('rs-unknown').textContent = state.unknown.length;
    el('rs-confirm').checked = state.confirmed;

    const files = [state.followingFile ? `关注：${state.followingFile}` : '', state.excludedFile ? `未回关：${state.excludedFile}` : ''].filter(Boolean);
    el('rs-file-state').textContent = files.length ? files.join('；') : '尚未导入文件';

    let summary = '';
    if (!state.owner) summary = '先填写用户名，再读取或导入名单。';
    else if (state.source === 'csv') summary = `由 CSV 差集得出：完整关注 ${state.rawFollowing.length} 人，未回关 ${state.excluded.length} 人，互关 ${state.mutual.length} 人。`;
    else if (state.source === 'scan') summary = `由页面扫描得出 ${state.rawFollowing.length} 人，未回关 ${state.excluded.length} 人。扫描可能不完整，请核对总数。`;
    else if (state.source === 'structured') summary = `结构化读取 ${countAll()} 人。仅明确互关进入候选，请核对是否读全。`;
    el('rs-complete').textContent = warning || summary;
    el('rs-complete').className = warning ? 'warn' : 'muted';
    el('rs-unknown-hint').hidden = !state.unknown.length;

    const hasList = state.mutual.length > 0;
    el('rs-confirm').disabled = !hasList || !validOwner(state.owner);
    el('rs-export-mutual').disabled = !state.confirmed || !validOwner(state.owner) || !state.mutual.length;
    el('rs-export-not').disabled = !state.confirmed || !validOwner(state.owner) || !state.notMutual.length;
    el('rs-confirm-hint').textContent = state.confirmed
      ? '✓ 名单已确认，可以到「工作台」开始采集。'
      : hasList ? '勾选确认后，工作台才会使用这份名单。' : '还没有互关名单，先读取关注列表或导入 CSV。';
    el('rs-confirm-hint').className = state.confirmed ? '' : 'muted';

    drawList();
    drawViewButtons();
  }

  function groups() {
    return { mutual: state.mutual, notMutual: state.notMutual, unknown: state.unknown };
  }

  function drawViewButtons() {
    const labels = { mutual: '互关', notMutual: '未回关', unknown: '状态未知' };
    for (const [id, group] of [['rs-view-mutual', 'mutual'], ['rs-view-notmutual', 'notMutual'], ['rs-view-unknown', 'unknown']]) {
      const active = viewGroup === group;
      el(id).style.fontWeight = active ? '700' : '';
      el(id).setAttribute('aria-pressed', active ? 'true' : 'false');
      el(id).textContent = `${labels[group]} ${groups()[group].length}`;
    }
  }

  function drawList() {
    const labels = { mutual: '互关', notMutual: '未回关', unknown: '状态未知' };
    const query = el('rs-search').value.trim().replace(/^@/, '').toLowerCase();
    const all = groups()[viewGroup] || [];
    const list = all.filter(u => !query || `${u.handle} ${u.name || ''}`.toLowerCase().includes(query));
    el('rs-list-count').textContent = `${labels[viewGroup]}：${list.length} 人${list.length > viewLimit ? `，显示前 ${viewLimit} 人` : ''}`;
    const container = el('rs-list');
    container.replaceChildren();
    for (const u of list.slice(0, viewLimit)) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 4px;border-bottom:1px solid #eef1f5';
      const name = document.createElement('strong');
      name.textContent = u.name || u.handle;
      const handle = document.createElement('span');
      handle.className = 'muted';
      handle.textContent = ` @${u.handle}`;
      row.append(name, handle);
      container.append(row);
    }
    el('rs-more').hidden = list.length <= viewLimit;
  }

  for (const [id, group] of [['rs-view-mutual', 'mutual'], ['rs-view-notmutual', 'notMutual'], ['rs-view-unknown', 'unknown']]) {
    el(id).onclick = () => { viewGroup = group; viewLimit = 100; drawList(); drawViewButtons(); };
  }
  el('rs-search').oninput = () => { viewLimit = 100; drawList(); };
  el('rs-more').onclick = () => { viewLimit += 100; drawList(); };

  // 输入完（失焦/回车）且用户名确实变了才作废确认，避免每敲一个字就把勾选清掉
  el('rs-owner').onchange = e => {
    const next = cleanHandle(e.target.value);
    if (next.toLowerCase() === state.owner.toLowerCase()) { state.owner = next; e.target.value = next; saveState(); return; }
    state.owner = next;
    state.confirmed = false;
    warning = '';
    saveState();
    draw();
  };

  el('rs-confirm').onchange = e => {
    state.confirmed = e.target.checked;
    saveState();
    draw();
  };

  /* ---------- 结构化读取 ---------- */

  function ownerHandle() {
    const v = cleanHandle(el('rs-owner').value);
    if (!validOwner(v)) throw Error('请填写有效的 X 用户名（字母、数字、下划线）');
    return v;
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
  }
  function saveCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { say('本地存储空间不足，缓存未保存。'); }
  }

  async function waitComplete(tabId, timeout = 25000) {
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

  /* 页面顶部统计里取"本次要读的那一侧"的人数。
   * 后台标签刚创建时 innerText 可能拿不到内容（依赖渲染），
   * 所以用 textContent，并由调用方轮询重试。 */
  function headerCount(kind) {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return null;
    const txt = (col.textContent || '').replace(/\s+/g, ' ');
    const re = /([\d.,]+)\s*([KkMm万亿千])?\s*(Following|Followers|正在关注|关注者|粉丝)/g;
    const want = kind === 'followers' ? ['Followers', '关注者', '粉丝'] : ['Following', '正在关注'];
    let m, first = null;
    while ((m = re.exec(txt))) {
      let n = parseFloat(m[1].replace(/[,]/g, ''));
      if (!Number.isFinite(n)) continue;
      const unit = (m[2] || '').toUpperCase();
      if (unit === 'K') n *= 1e3;
      else if (unit === 'M') n *= 1e6;
      else if (m[2] === '万') n *= 1e4;
      else if (m[2] === '千') n *= 1e3;
      const value = Math.round(n);
      if (want.includes(m[3])) return value;
      if (first === null) first = value;
    }
    return first;
  }

  /* 打开目标列表页并滚动读取，直到出现结束信号或连续无新增。
   * 标签以 active:false 创建：不抢焦点、不切走你正在看的页面，读完自动关闭。 */
  async function readList(kind, owner) {
    const id = `xfa-graph-${kind}`;
    const patterns = [`https://x.com/${owner}/${kind}*`, `https://x.com/${owner.toLowerCase()}/${kind}*`]
      .filter((v, i, a) => a.indexOf(v) === i);

    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id, matches: patterns, js: ['graph-reader.js'],
      runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false
    }]);

    const url = `https://x.com/${owner}/${kind}`;
    let tabId = null;
    let created = false;

    // 已有同一列表页且已经装过读取器时直接复用；否则新开一个后台标签，
    // 不去刷新你正在看的那个标签。
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    const existing = tabs.find(t => norm(t.url) === norm(url));
    if (existing) {
      const alive = await chrome.scripting.executeScript({
        target: { tabId: existing.id }, world: 'MAIN',
        func: () => !!window.__xfaGraphReader01
      }).catch(() => null);
      if (alive?.[0]?.result) tabId = existing.id;
    }
    if (!tabId) {
      const createdTab = await chrome.tabs.create({ url, active: false });
      tabId = createdTab.id;
      await chrome.runtime.sendMessage({ type: 'xfa-mark-automation', tabId }).catch(() => {});
      created = true;
    }

    try {
      say(`正在后台加载 ${kind === 'following' ? '关注' : '粉丝'} 列表（不会切到前台）…`);
      el('rs-progress-text').textContent = '正在加载页面…';
      await wait(700);
      if (!await waitComplete(tabId)) throw Error('页面加载超时，请检查 X 是否正常打开');
      await wait(1200);

      // 后台标签加载偏慢，X 可能过几秒才发出列表请求：先等第一页数据到位
      let first = null;
      for (let i = 0; i < 10; i++) {
        const r = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.snapshot() || null
        });
        first = r?.[0]?.result;
        if (first && first.counts && first.counts.all) break;
        await wait(800);
      }

      // 顶部统计可能要晚几百毫秒才渲染出来，轮询几次再放弃
      let expect = null;
      for (let i = 0; i < 6 && !expect; i++) {
        expect = (await chrome.scripting.executeScript({ target: { tabId }, func: headerCount, args: [kind] }))[0]?.result;
        if (!expect) await wait(800);
      }
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.scrollTo(0) }).catch(() => {});

      let last = 0, stale = 0, snap = first, errorStreak = 0, stopReason = '', fastReason = '';
      for (let n = 0; n < 400; n++) {
        if (shouldStop()) { stopReason = '你手动停止'; break; }
        const res = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => window.__xfaGraphReader01?.snapshot() || null
        });
        snap = res?.[0]?.result;
        if (!snap) throw Error('未能启动结构化读取，请确认权限已授予并刷新页面');
        if (snap.error) {
          // 单页失败多半是临时限流，退避重试；连续 3 次才判死
          errorStreak++;
          if (errorStreak >= 3) { stopReason = snap.error; break; }
          say(`读取中遇到错误（${errorStreak}/3，${snap.error}），稍后重试…`);
          await wait(2000 * errorStreak);
          continue;
        }
        errorStreak = 0;

        const size = snap.counts.all;
        stale = size === last ? stale + 1 : 0;
        last = size;
        setProgress(size, expect);
        say(`读取中：已获得 ${size} 人${expect ? ` / 页面显示 ${expect}` : ''}`);

        if (snap.bottom) { stopReason = '到底'; break; }
        if (stale >= 12) { stopReason = `连续无新增（${stale} 次）`; break; }

        const fast = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.fastNext() }).catch(() => null);
        const fastResult = fast?.[0]?.result;
        if (!fastResult?.available) {
          if (fastResult?.reason) fastReason = fastResult.reason;
          await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.scrollNext() }).catch(() => {});
          await wait(stale > 6 ? 1200 : 900);
        } else {
          // 主动翻页也要放慢，连发最容易吃 429
          await wait(900);
        }
      }
      if (stopReason) say(`停止原因：${stopReason}`);

      const dbg = (await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.debug() || null
      }).catch(() => null))?.[0]?.result;

      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__xfaGraphReader01?.stop() }).catch(() => {});
      return { snap, expect, tabId, created, debug: dbg, fastReason, stopReason, complete: !!snap?.bottom && !shouldStop() };
    } catch (e) {
      if (created) await chrome.tabs.remove(tabId).catch(() => {});
      throw e;
    } finally {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    }
  }

  /* 用缓存重算互关分组，并写进名单状态。
   * preview=true 时只回填展示数据：不改确认状态、不落盘，用于打开面板时展示上次结果。 */
  function applyCache(cache, opts = {}) {
    const owner = cleanHandle(cache.owner);
    const following = Array.isArray(cache.following) ? cache.following : [];
    const followers = Array.isArray(cache.followers) ? cache.followers : null;
    const { mutual, notMutual, unknown, counts } = GraphLogic.compute(following, followers, { followersComplete: cache.followersComplete === true });

    state.owner = state.owner || owner;
    state.source = state.source || 'structured';
    state.mutual = toRows(mutual);
    state.notMutual = toRows(notMutual);
    state.unknown = toRows(unknown);
    state.rawFollowing = toRows(following);
    state.followingTotal = counts.all;
    state.followingFile = `X 结构化读取 ${new Date().toLocaleString()}`;
    state.excludedFile = '按关系字段判定';
    if (opts.preview !== true) {
      state.owner = owner;
      state.source = 'structured';
      state.confirmed = false;
      saveState();
    }

    // 完整性提示
    const expF = cache.expect?.following;
    warning = expF && counts.all && counts.all < expF
      ? `⚠ 只读到 ${counts.all} / 页面显示 ${expF}，可能未读全，建议重新读取。`
      : (cache.followers && cache.followersComplete !== true && counts.unknown)
        ? '⚠ 粉丝列表未确认读完；没找到的账号仍保留“状态未知”。'
        : '';

    if (cache.prevFollowing) {
      const prevSet = new Set(cache.prevFollowing.map(h => h.toLowerCase()));
      const curSet = new Set(following.map(u => u.handle.toLowerCase()));
      const added = [...curSet].filter(h => !prevSet.has(h)).length;
      const gone = [...prevSet].filter(h => !curSet.has(h)).length;
      el('rs-diff').textContent = cache.prevAt
        ? `与上次读取（${new Date(cache.prevAt).toLocaleString()}）对比：新增关注 ${added}，不再在列表 ${gone}。`
        : '';
    }

    if (opts.silent !== true) say(`已更新名单：互关 ${counts.mutual}，未回关 ${counts.notMutual}，未知 ${counts.unknown}。请核对后勾选确认。`);
    draw();
  }

  async function run(kind) {
    if (busy) return;
    busy = true;
    setStop(false);
    el('rs-stop').disabled = false;
    el('rs-following').disabled = true;
    el('rs-followers').disabled = true;
    let openedTabId = null;
    try {
      if (!await chrome.permissions.contains(perm)) throw Error('请先点顶部的「授权 X」');
      const owner = ownerHandle();
      el('rs-owner').value = owner;
      resetProgress();
      const { snap, expect, complete, tabId, created, debug, fastReason, stopReason } = await readList(kind, owner);
      if (created) openedTabId = tabId;
      if (!snap) throw Error('尚未读到名单数据，请重新读取');

      let cache = loadCache();
      const sameOwner = cache && cache.owner && cache.owner.toLowerCase() === owner.toLowerCase();
      if (!sameOwner) cache = { owner, following: [], followers: null, expect: {} };
      else if (!cache.expect) cache.expect = {};

      if (kind === 'following') {
        if (Array.isArray(cache.following) && cache.following.length) {
          cache.prevFollowing = cache.following.map(u => u.handle);
          cache.prevAt = cache.at || null;
        }
        cache.following = snap.users;
        cache.expect.following = expect || null;
      } else {
        cache.followers = snap.users;
        cache.followersComplete = complete;
        cache.expect.followers = expect || null;
      }
      cache.at = new Date().toISOString();
      saveCache(cache);
      applyCache(cache);

      const fetched = snap.counts.all;
      setProgress(fetched, expect);
      let detail = '';
      if (!complete) {
        const dbg = debug || {};
        detail = `（${stopReason || '未到底'}；模板请求=${dbg.hasRequest ? '有' : '无'}，翻页游标=${dbg.hasCursor ? '有' : '无'}，页数=${dbg.pages || 0}${fastReason ? `，${fastReason}` : ''}）`;
      }
      const head = complete ? '读取完成' : '读取结束（未确认到底）';
      el('rs-progress-text').textContent = `${head}：${fetched} 人${expect ? ` / 页面显示 ${expect}` : ''}${detail}`;
      if (!complete) {
        warning = `⚠ 只读到 ${fetched} 人${expect ? ` / ${expect}` : ''}，可能未读全。${detail}`;
        draw();
      }
    } catch (e) {
      say(e.message);
      el('rs-progress-text').textContent = `读取中断：${e.message}`;
    } finally {
      busy = false;
      el('rs-stop').disabled = true;
      el('rs-following').disabled = false;
      el('rs-followers').disabled = false;
      if (openedTabId) await chrome.tabs.remove(openedTabId).catch(() => {});
    }
  }

  el('rs-following').onclick = () => run('following');
  el('rs-followers').onclick = () => run('followers');
  el('rs-stop').onclick = () => { setStop(true); say('正在停止，已读取的数据会保留。'); };

  el('rs-apply').onclick = () => {
    const cache = loadCache();
    if (!cache || !Array.isArray(cache.following)) { say('没有可用缓存，请先读取关注列表'); return; }
    if (state.owner && cache.owner && cleanHandle(cache.owner).toLowerCase() !== cleanHandle(state.owner).toLowerCase()) {
      say(`缓存属于 @${cleanHandle(cache.owner)}，与当前用户名不一致，未覆盖。`);
      return;
    }
    applyCache(cache);
  };

  /* ---------- 手动导入 CSV ---------- */

  for (const kind of ['following', 'excluded']) {
    el('rs-file-' + kind).onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (file.size > 5e6) throw Error('文件不能超过 5 MB');
        const rows = Roster.read(await file.text(), kind);
        if (kind === 'following') {
          state.rawFollowing = rows;
          state.followingFile = file.name;
          state.unknown = [];   // 新的完整关注名单是新的基线，旧的状态未知不再适用
          // 之前用结构化读取判定过的未回关，继续当作排除集，避免整份名单被当成互关
          if (!state.excluded.length && state.notMutual.length) {
            state.excluded = state.notMutual;
            state.excludedFile = state.excludedFile || '结构化读取判定';
          }
        } else {
          state.excluded = rows;
          state.excludedFile = file.name;
        }
        state.source = 'csv';
        state.confirmed = false;
        warning = '';
        recomputeCsv();
        el('rs-csv-error').textContent = '';
        saveState();
        draw();
        say(`已导入${kind === 'following' ? '完整关注' : '未回关'} ${rows.length} 人。`);
      } catch (err) {
        el('rs-csv-error').textContent = err.message;
      }
      e.target.value = '';
    };
  }

  /* CSV 路径：互关 = 完整关注 − 未回关 − 状态未知。
   * 未知一律不进候选，避免把没判定的账号当互关去拜访。 */
  function recomputeCsv() {
    const deny = state.excluded.concat(state.unknown);
    const mutual = state.rawFollowing.length ? Roster.match(state.rawFollowing, deny) : [];
    state.mutual = toRows(mutual);
    state.notMutual = toRows(state.excluded);
    state.followingTotal = state.rawFollowing.length || state.mutual.length + state.excluded.length + state.unknown.length;
  }

  /* ---------- 导出与清除 ---------- */

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  el('rs-export-mutual').onclick = () => {
    if (el('rs-export-mutual').disabled) return;
    if (!state.mutual.length) return say('当前没有可导出的互关条目');
    download(`${cleanHandle(state.owner)}-互关.csv`, Roster.csv(state.mutual));
  };

  el('rs-export-not').onclick = () => {
    if (el('rs-export-not').disabled) return;
    if (!state.notMutual.length) return say('当前没有可导出的未回关条目');
    download(`${cleanHandle(state.owner)}-未回关.csv`, Roster.csv(state.notMutual, 'excluded'));
  };

  el('rs-clear').onclick = () => {
    if (!confirm('清除名单、读取缓存和互关判定结果？队列里的帖子不受影响。')) return;
    state = { owner: '', source: '', confirmed: false, mutual: [], notMutual: [], unknown: [], rawFollowing: [], excluded: [], followingTotal: 0, followingFile: '', excludedFile: '' };
    try { localStorage.removeItem(ROSTER_KEY); localStorage.removeItem(CACHE_KEY); } catch {}
    warning = '';
    el('rs-progress-box').hidden = true;
    el('rs-owner').value = '';
    el('rs-csv-error').textContent = '';
    el('rs-diff').textContent = '';
    saveState();
    draw();
    say('名单已清除。');
  };

  /* ---------- 其它面板推送的名单 ---------- */

  window.addEventListener('x-following-snapshot', e => {
    const d = e.detail;
    if (!d || !Array.isArray(d.users)) return;
    const previous = cleanHandle(state.owner).toLowerCase();
    if (previous && previous !== cleanHandle(d.owner).toLowerCase()) state.excluded = [];
    state.owner = cleanHandle(d.owner);
    state.source = 'scan';
    state.rawFollowing = toRows(d.users);
    state.unknown = [];
    state.followingFile = d.label || 'X 页面扫描';
    state.excludedFile = state.excludedFile || '';
    recomputeCsv();
    state.confirmed = false;
    saveState();
    draw();
  });

  window.addEventListener('xfa-mutual-snapshot', e => {
    const d = e.detail;
    if (!d || !Array.isArray(d.users)) return;
    state.owner = cleanHandle(d.owner);
    state.source = 'structured';
    state.mutual = toRows(d.users);
    state.confirmed = false;
    saveState();
    draw();
  });

  /* ---------- 初始化 ---------- */

  loadState();
  // 有结构化缓存但内存里还没有名单时，回填展示数据（不落盘、不改确认状态）
  const saved = loadCache();
  const emptyLists = !state.mutual.length && !state.notMutual.length && !state.unknown.length && !state.rawFollowing.length;
  if (saved?.owner && Array.isArray(saved.following) && saved.following.length && emptyLists) {
    const sameOwner = !state.owner || cleanHandle(saved.owner).toLowerCase() === state.owner.toLowerCase();
    if (sameOwner) applyCache(saved, { silent: true, preview: true });
  }
  draw();
})();
