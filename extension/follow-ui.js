/* 定向交友面板：关键词与上限设置 → 后台采集 → 人工批准 → 批量关注。
 * 已停用（0.6.2）：不随 dashboard 加载，background 也不再调度关注流程。
 * 文件保留在磁盘上以便将来恢复；恢复时需同时改回 dashboard 的 tab/脚本与 background 调度段。 */
(function () {
  const section = document.createElement('section');
  section.className = 'panel';
  section.innerHTML = `<h2>定向交友</h2>
    <p class="muted">按关键词在 X 搜索最新帖，只采集带蓝V、当前未关注的帖子作者。候选经你批准后，点一次开始，按 15–120 秒随机间隔逐个关注，可随时暂停。</p>
    <div class="stats">
      <div><b id="fl-sent">0</b><small>今日已关注</small></div>
      <div><b id="fl-limit">50</b><small>每日上限</small></div>
      <div><b id="fl-new">0</b><small>待批准</small></div>
      <div><b id="fl-approved">0</b><small>待关注</small></div>
    </div>
    <details><summary class="muted">关键词与上限</summary>
      <label>搜索关键词（逗号或换行分隔，最多 30 个）</label>
      <textarea id="fl-keywords" rows="3"></textarea>
      <div class="actions"><label style="margin:0">每日关注上限 <input id="fl-cap" type="number" min="1" max="400"></label>
      <button id="fl-save-config">保存设置</button></div>
      <p class="muted warn">关注操作的风控比回复更敏感，上限偏高时若出现锁定提示，请立即调低。</p>
    </details>
    <p id="fl-status" role="status">正在读取…</p>
    <div class="actions">
      <button id="fl-collect" class="primary">开始采集</button>
      <button id="fl-approve-all">全部批准</button>
      <button id="fl-start">开始关注</button>
      <button id="fl-stop" disabled>停止</button>
      <button id="fl-archive">清理已关注</button>
      <button id="fl-refresh">刷新</button>
    </div>
    <div id="fl-list"></div>`;
  document.querySelector('#tab-follow').insertBefore(section, null);
  const el = id => document.getElementById(id);

  const badgeText = {
    new: '待批准', approved: '待关注', following: '关注中',
    followed: '已关注', failed: '失败', skipped: '已跳过'
  };
  const badgeClass = {
    new: 'pending', approved: 'approved', following: 'sending',
    followed: 'sent', failed: 'failed', skipped: 'skipped'
  };

  /* 已关注的账号同步进名单的 unknown 组（我们关注、回关状态未知），
   * 下次读取名单时再确认是否互关。 */
  function syncRoster(candidates) {
    let roster;
    try { roster = JSON.parse(localStorage.getItem('x-friends-roster-v1') || 'null'); } catch { roster = null; }
    if (!roster?.confirmed) return;
    for (const group of ['mutual', 'notMutual', 'unknown']) {
      if (!Array.isArray(roster[group])) roster[group] = [];
    }
    const known = new Set([...roster.mutual, ...roster.notMutual, ...roster.unknown].map(u => String(u.handle).toLowerCase()));
    let changed = false;
    for (const c of candidates) {
      if (c.status === 'followed' && !known.has(c.handle)) {
        roster.unknown.push({ handle: c.handle, name: c.name || '' });
        known.add(c.handle);
        changed = true;
      }
    }
    if (changed) {
      try {
        localStorage.setItem('x-friends-roster-v1', JSON.stringify(roster));
        window.dispatchEvent(new Event('xfa-roster-changed'));
      } catch {}
    }
  }

  async function refresh() {
    const s = await FollowStore.get();
    syncRoster(s.candidates);
    el('fl-keywords').value = s.keywords.join(', ');
    el('fl-cap').value = s.dailyLimit;
    const count = status => s.candidates.filter(c => c.status === status).length;
    const uncertain = s.candidates.filter(c => c.status === 'following' && c.error).length;
    el('fl-sent').textContent = s.daily.date === new Date().toISOString().slice(0, 10) ? s.daily.count : 0;
    el('fl-limit').textContent = s.dailyLimit;
    el('fl-new').textContent = count('new');
    el('fl-approved').textContent = count('approved') + count('following');
    const list = el('fl-list');
    list.replaceChildren();
    for (const c of s.candidates) {
      const card = document.createElement('div');
      card.className = 'rcard' + (c.status === 'failed' ? ' failed' : '');
      const head = document.createElement('p');
      head.append(`${c.name || c.handle} `);
      const handleLink = document.createElement('a');
      handleLink.href = `https://x.com/${c.handle}`;
      handleLink.target = '_blank';
      handleLink.rel = 'noopener noreferrer';
      handleLink.textContent = `@${c.handle}`;
      head.append(handleLink);
      const tag = document.createElement('span');
      tag.className = `badge ${badgeClass[c.status] || 'pending'}`;
      tag.style.marginLeft = '8px';
      tag.textContent = badgeText[c.status] || c.status;
      head.append(tag);
      const kw = document.createElement('span');
      kw.className = 'tag';
      kw.style.marginLeft = '8px';
      kw.textContent = c.keyword;
      head.append(kw);
      card.append(head);

      if (c.error) {
        const err = document.createElement('p');
        err.className = 'muted';
        err.style.color = '#b42318';
        err.textContent = c.error;
        card.append(err);
      }
      if (c.tweetUrl) {
        const tweet = document.createElement('a');
        tweet.href = c.tweetUrl;
        tweet.target = '_blank';
        tweet.rel = 'noopener noreferrer';
        tweet.textContent = '查看来源帖';
        card.append(tweet);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      if (!['following', 'followed'].includes(c.status)) {
        const approve = document.createElement('button');
        approve.textContent = c.status === 'approved' ? '取消批准' : '批准';
        approve.onclick = async () => {
          await FollowStore.approve(c.handle, c.status !== 'approved');
          await refresh();
        };
        const remove = document.createElement('button');
        remove.className = 'danger-outline';
        remove.textContent = '移除';
        remove.onclick = async () => {
          if (!confirm(`移除候选 @${c.handle}？`)) return;
          await FollowStore.remove(c.handle);
          await refresh();
        };
        actions.append(approve, remove);
      }
      if (c.status === 'following' && c.error) {
        for (const [text, followed] of [['我已核实：已关注', true], ['我已核实：未关注', false]]) {
          const resolve = document.createElement('button');
          resolve.textContent = text;
          resolve.onclick = async () => {
            if (!confirm(followed ? '确认已在 X 关注该账号？' : '确认没有关注？确认后可重新批准。')) return;
            const ok = await FollowStore.resolveFollow(c.handle, followed);
            if (!ok) el('fl-status').textContent = '状态更新失败';
            await refresh();
          };
          actions.append(resolve);
        }
      }
      card.append(actions);
      list.append(card);
    }
  }

  el('fl-save-config').onclick = async () => {
    try {
      const keywords = el('fl-keywords').value.split(/[\n,，]/);
      await FollowStore.setKeywords(keywords);
      await FollowStore.setDailyLimit(el('fl-cap').value);
      el('fl-status').textContent = '设置已保存。';
      await refresh();
    } catch (e) { el('fl-status').textContent = e.message; }
  };
  el('fl-collect').onclick = async () => {
    el('fl-status').textContent = '正在后台采集，请勿关闭浏览器…';
    const r = await chrome.runtime.sendMessage({ type: 'xfa-follow-collect' });
    el('fl-status').textContent = r?.message || '采集结束。';
    await refresh();
  };
  el('fl-approve-all').onclick = async () => {
    const n = await FollowStore.approveAllNew();
    el('fl-status').textContent = `已批准 ${n} 个候选。`;
    await refresh();
  };
  el('fl-start').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'xfa-follow-start' });
    el('fl-status').textContent = r?.message || (r?.ok ? '关注流程已启动。' : '启动失败');
    await refresh();
  };
  el('fl-stop').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'xfa-follow-stop' });
    el('fl-status').textContent = r?.ok ? '已停止。' : '停止失败';
    await refresh();
  };
  el('fl-archive').onclick = async () => {
    const n = await FollowStore.archiveFollowed();
    el('fl-status').textContent = `已清理 ${n} 个已关注记录。`;
    await refresh();
  };
  el('fl-refresh').onclick = () => refresh();
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'xfa-follow-changed') {
      refresh().catch(e => { el('fl-status').textContent = e.message; });
      el('fl-stop').disabled = !msg.running;
      el('fl-collect').disabled = el('fl-start').disabled = !!msg.running;
    }
    if (msg.type === 'xfa-follow-progress') el('fl-status').textContent = msg.message;
  });
  refresh().catch(e => { el('fl-status').textContent = e.message; });
})();
