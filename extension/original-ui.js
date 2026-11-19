(function () {
  const section = document.createElement('section');
  section.className = 'panel';
  section.innerHTML = `<h2>原创帖子草稿</h2>
    <p class="muted">两条原创帖之间的间隔在你设定的分钟数之间随机，到点自动生成一条英文草稿，与回复数量无关。每条都要你审核并确认后才会发布。</p>
    <div class="actions"><label style="margin:0"><input type="checkbox" id="orig-enabled"> 自动生成原创草稿（关闭后暂停，草稿与设置保留）</label></div>
    <p id="orig-status" role="status">正在读取进度…</p>
    <div class="actions"><button id="orig-retry" disabled>重试生成</button><button id="orig-refresh">刷新</button></div>
    <div id="orig-list"></div>
    <details style="margin-top:14px"><summary class="muted">间隔规则</summary>
      <div class="actions"><label style="margin:0">两条原创帖间隔 <input id="orig-min" type="number" min="1" max="10000" value="180"> ~ <input id="orig-max" type="number" min="1" max="10000" value="480"> 分钟随机</label><button id="orig-save-range">保存范围</button></div>
      <p class="muted">调整范围从下一轮生效。发布结果未确认时不自动补发；到期时间跨浏览器关闭保留，重启后补处理。</p>
    </details>`;
  document.querySelector('#tab-original').insertBefore(section, null);
  const el = id => document.getElementById(id);
  let dirty = false;
  const edits = new Map();
  el('orig-min').oninput = el('orig-max').oninput = () => { dirty = true; };
  function fmtDue(ts) {
    const left = Math.max(0, Math.round((ts - Date.now()) / 60000));
    const at = new Date(ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `下一条约 ${at} 生成（${left} 分钟后）`;
  }
  async function refresh() {
    const state = await OriginalStore.get();
    const enabled = state.enabled !== false;
    el('orig-enabled').checked = enabled;
    if (!dirty) { el('orig-min').value = state.min; el('orig-max').value = state.max; }
    el('orig-min').disabled = el('orig-max').disabled = el('orig-save-range').disabled = !enabled;
    const task = state.task;
    const status = { pending: '等待生成', generating: '正在生成', failed: '生成失败', interrupted: '请求中断，需确认后重试' };
    let due;
    if (!enabled) {
      due = '已暂停：不会自动生成草稿，已有草稿仍可手动审核发布';
    } else {
      due = task ? (status[task.status] || task.status) + (task.error ? `：${task.error}` : '') : fmtDue(state.nextDueAt);
    }
    el('orig-status').textContent = `${due}；草稿 ${state.drafts.length} 条；待核实 ${state.uncertain.length} 条。`;
    el('orig-retry').disabled = !enabled || !task || !['failed', 'interrupted'].includes(task.status);
    const list = el('orig-list'); list.replaceChildren();
    // 旧版计数遗留的回复待核实项：已无计数意义，核实后直接移除
    for (const item of state.uncertain) {
      const row = document.createElement('div'); row.className = 'rcard';
      const label = document.createElement('p'); label.textContent = `回复 @${item.handle} 的发送结果待核实（旧计数遗留）。`;
      const link = document.createElement('a'); link.href = `https://x.com/${item.handle}/status/${item.id}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看目标帖子';
      const yes = document.createElement('button'); yes.textContent = '我已核实，移除此条';
      yes.onclick = async () => { if (!confirm('请确认你已在 X 核实这条回复。')) return; await OriginalStore.dismissUncertain(item.id); await refresh(); };
      const actions = document.createElement('div'); actions.className = 'actions'; actions.append(link, yes); row.append(label, actions); list.append(row);
    }
    for (const draft of state.drafts) {
      const card = document.createElement('div'); card.className = 'rcard';
      const labels = { publishing: '正在发布', published: '已发布', uncertain: '发布结果待核实', failed: '未发布，可修改后重试' };
      const label = document.createElement('p'); label.textContent = `原创草稿 · ${new Date(draft.createdAt).toLocaleString()} · ${labels[draft.publishStatus] || '待审核'}${draft.publishError ? `：${draft.publishError}` : ''}`;
      const input = document.createElement('textarea'); input.rows = 3; input.value = edits.has(draft.id) ? edits.get(draft.id) : draft.text;
      input.disabled = ['publishing', 'published', 'uncertain'].includes(draft.publishStatus);
      input.oninput = () => edits.set(draft.id, input.value);
      const buttons = document.createElement('div'); buttons.className = 'actions';
      const save = document.createElement('button'); save.textContent = '保存修改';
      save.disabled = input.disabled;
      save.onclick = async () => { try { await OriginalStore.edit(draft.id, input.value); edits.delete(draft.id); el('orig-status').textContent = '草稿已保存。'; } catch (e) { el('orig-status').textContent = e.message; } };
      const remove = document.createElement('button'); remove.textContent = '删除草稿';
      remove.disabled = draft.publishStatus === 'publishing';
      remove.onclick = async () => { if (!confirm('删除这条原创草稿？')) return; try { await OriginalStore.remove(draft.id); edits.delete(draft.id); await refresh(); } catch (e) { el('orig-status').textContent = e.message; } };
      buttons.append(save);
      if (!['publishing', 'published', 'uncertain'].includes(draft.publishStatus)) {
        const publish = document.createElement('button'); publish.className = 'primary'; publish.textContent = '审核并发布';
        publish.onclick = async () => {
          let roster; try { roster = JSON.parse(localStorage.getItem('x-friends-roster-v1') || '{}'); } catch { roster = {}; }
          const owner = String(roster.owner || '').replace(/^@/, '');
          const text = input.value.trim();
          if (!roster.confirmed || !/^[A-Za-z0-9_]{1,15}$/.test(owner)) { el('orig-status').textContent = '请先确认名单所属的 X 账号。'; return; }
          if (!text || text.length > 280) { el('orig-status').textContent = '草稿不能为空且不能超过 280 个字符。'; return; }
          if (!confirm(`确认以 @${owner} 发布以下原创帖子？\n\n${text}`)) return;
          try {
            await OriginalStore.edit(draft.id, text); edits.delete(draft.id);
            const result = await chrome.runtime.sendMessage({ type: 'xfa-original-publish', id: draft.id, owner, text });
            await refresh(); el('orig-status').textContent = result?.message || '发布结果未返回，请在 X 核实。';
          } catch (e) { el('orig-status').textContent = e.message; }
        };
        buttons.append(publish);
      }
      if (draft.publishStatus === 'uncertain') {
        for (const [label, published] of [['我已核实：已发布', true], ['我已核实：未发布', false]]) {
          const resolve = document.createElement('button'); resolve.textContent = label;
          resolve.onclick = async () => { if (!confirm(published ? '确认帖子已在 X 发布？' : '确认帖子没有发出？确认后才可再次发布。')) return; const r = await chrome.runtime.sendMessage({ type: 'xfa-original-resolve', id: draft.id, published }); if (!r?.ok) el('orig-status').textContent = r?.message || '状态更新失败'; else await refresh(); };
          buttons.append(resolve);
        }
      }
      buttons.append(remove); card.append(label, input, buttons); list.append(card);
    }
  }
  el('orig-save-range').onclick = async () => { try { await OriginalStore.configure(el('orig-min').value, el('orig-max').value); dirty = false; await refresh(); } catch (e) { el('orig-status').textContent = e.message; } };
  el('orig-enabled').onchange = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'xfa-original-toggle', enabled: el('orig-enabled').checked });
    if (!r?.ok) { el('orig-status').textContent = r?.message || '切换失败，请重试'; }
    await refresh();
  };
  el('orig-retry').onclick = async () => { const r = await chrome.runtime.sendMessage({ type: 'xfa-original-retry' }); if (!r?.ok) el('orig-status').textContent = r?.message || '当前没有可重试的任务'; else await refresh(); };
  el('orig-refresh').onclick = () => refresh().catch(e => { el('orig-status').textContent = e.message; });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'xfa-original-changed') refresh().catch(e => { el('orig-status').textContent = e.message; });
    if (msg.type === 'xfa-original-error') el('orig-status').textContent = msg.message;
  });
  refresh().catch(e => { el('orig-status').textContent = e.message; });
})();
