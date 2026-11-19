/* 配置面板：服务商、密钥、间隔、每日上限和工作时段。 */
(function () {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>AI 草稿服务</h2>
    <label>服务商 <select id="cf-provider">
      <option value="siliconflow">硅基流动（有免费额度）</option>
      <option value="deepseek">DeepSeek（约 1 元/月）</option>
    </select></label>
    <div id="cf-sf-row">
      <label>硅基流动密钥 <input id="cf-sf-key" type="password" style="width:100%" placeholder="sk-...（默认只保存在当前会话，关闭浏览器即失效）"></label>
      <label><input id="cf-remember-sf" type="checkbox"> 记住密钥（写入扩展本地存储，重启后仍可用；本地存储不是加密保险箱）</label>
    </div>
    <div id="cf-ds-row">
      <label>DeepSeek 密钥 <input id="cf-ds-key" type="password" style="width:100%" placeholder="sk-..."></label>
      <label><input id="cf-remember-ds" type="checkbox"> 记住密钥（写入扩展本地存储，重启后仍可用；本地存储不是加密保险箱）</label>
    </div>
    <p id="cf-key-state" class="muted" aria-live="polite">正在检查密钥保存状态…</p>
    <details>
      <summary class="muted">高级：API 地址与模型（两家各自保存，切换不会互相覆盖）</summary>
      <label>API 地址 <input id="cf-base" type="text" style="width:100%" placeholder="留空使用默认"></label>
      <label>模型名称 <input id="cf-model" type="text" style="width:100%" placeholder="留空使用默认"></label>
    </details>

    <h2 style="margin-top:22px">发送节奏</h2>
    <label>发送间隔 <input id="cf-min" type="number" min="15" max="600" value="15"> ~ <input id="cf-max" type="number" min="15" max="600" value="120"> 秒 <small class="muted">每条随机取值</small></label>
    <label>每日上限 <input id="cf-limit" type="number" min="1" max="2000" value="30"> 条 <small class="muted">可设置 1–2000</small></label>
    <label>工作时段 <input id="cf-start" type="number" min="0" max="23" value="9"> 点 至 <input id="cf-end" type="number" min="1" max="24" value="23"> 点</label>
    <label><input id="cf-focus" type="checkbox"> 发送时把工作标签切到前台（成功率更高，但会抢焦点）</label>
    <h2 style="margin-top:22px">时间线采集</h2>
    <label><input id="cf-tlfast" type="checkbox" checked> 优先用接口嗅探采集（读 X 自己发的 HomeTimeline 响应，更快；失败自动退回滚动）</label>
    <label>翻页请求间隔 <input id="cf-tlgap-min" type="number" min="1" max="60" value="3"> ~ <input id="cf-tlgap-max" type="number" min="1" max="60" value="6"> 秒 <small class="muted">每次主动翻页的随机间隔，越慢越不容易被限流</small></label>
    <div class="actions">
      <button id="cf-save" class="primary">保存配置</button>
      <button id="cf-test">测试云端连通</button>
    </div>
    <p id="cf-status" class="muted" aria-live="polite"></p>
    <div class="notice" style="margin-top:14px">风险提示：DOM 模拟点击仍属 X ToS 的灰色地带，本工具靠“人审 + 小规模 + 随机间隔”降低实际风险，但不构成合规保证。建议每日不超过 30 条，间隔保持 15–120 秒随机，工作时段放在白天。</div>
    <div class="danger-zone">
      <p class="muted" style="margin:6px 0">危险操作</p>
      <div class="actions" style="margin-top:0">
        <button id="cf-clear-sf" class="danger-outline">清除硅基流动密钥</button>
        <button id="cf-clear-ds" class="danger-outline">清除 DeepSeek 密钥</button>
        <button id="cf-clear" class="danger-outline">清空队列与记录</button>
      </div>
    </div>`;
  document.querySelector('#tab-settings').insertBefore(panel, document.querySelector('#demo-box'));

  const el = id => document.getElementById(id);
  const defaults = {
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B' },
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }
  };
  /* 每个服务商各存一套地址与模型，切换服务商时互不覆盖 */
  const epDraft = {
    siliconflow: { baseUrl: '', model: '' },
    deepseek: { baseUrl: '', model: '' }
  };
  const currentProvider = () => (defaults[el('cf-provider').value] ? el('cf-provider').value : 'siliconflow');
  const labels = { siliconflow: '硅基流动', deepseek: 'DeepSeek' };

  function readStorage(store, key) {
    return new Promise((resolve, reject) => store.get(key, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result[key]);
    }));
  }

  function writeStorage(store, value) {
    return new Promise((resolve, reject) => store.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }));
  }

  async function showKeyState() {
    const saved = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
    const persistent = await readStorage(chrome.storage.local, 'xfa-deepseek-secret-v1') || {};
    const persistentSf = await readStorage(chrome.storage.local, 'xfa-siliconflow-secret-v1') || {};
    el('cf-remember-ds').checked = !!persistent.deepseekKey;
    el('cf-remember-sf').checked = !!persistentSf.siliconflowKey;
    // 只露尾号：既能核对“用的是不是刚填的那把”，又不会把密钥显示出来
    const tailOf = k => (k ? `（…${String(k).slice(-4)}）` : '');
    const dsState = persistent.deepseekKey ? `已保存到本地${tailOf(persistent.deepseekKey)}` : saved.deepseekKey ? `仅当前会话已保存${tailOf(saved.deepseekKey)}` : '未保存';
    const sfState = persistentSf.siliconflowKey ? `已保存到本地${tailOf(persistentSf.siliconflowKey)}` : saved.siliconflowKey ? `仅当前会话已保存${tailOf(saved.siliconflowKey)}` : '未保存';
    el('cf-key-state').textContent = `硅基流动${sfState}；DeepSeek${dsState}。本地记住的密钥优先于会话，若报“密钥无效”先核对这里的尾号是不是你刚填的那把。`;
  }

  /* 把输入框当前内容暂存到“当前显示的那个服务商”，再按新服务商回填。
   * 注意 onchange 触发时下拉框的值已经变了，所以暂存必须认 shownProvider，不能认 currentProvider。 */
  let shownProvider = null;
  function stashEndpoint() {
    const p = shownProvider || currentProvider();
    epDraft[p] = { baseUrl: el('cf-base').value.trim(), model: el('cf-model').value.trim() };
  }
  function showEndpoint() {
    const p = currentProvider();
    shownProvider = p;
    el('cf-base').value = epDraft[p].baseUrl || '';
    el('cf-model').value = epDraft[p].model || '';
    el('cf-base').placeholder = `留空使用默认：${defaults[p].baseUrl}`;
    el('cf-model').placeholder = `留空使用默认：${defaults[p].model}`;
  }

  async function load() {
    // 配置从扩展存储中读取，输入框不回显已保存的密钥。
    const conf = await readStorage(chrome.storage.local, 'xfa-config-v1') || {};
    const provider = defaults[conf.provider] ? conf.provider : 'siliconflow';
    el('cf-provider').value = provider;
    for (const name of Object.keys(defaults)) epDraft[name] = { baseUrl: '', model: '' };
    if (conf.endpoints) {
      for (const name of Object.keys(defaults)) {
        const ep = conf.endpoints[name] || {};
        epDraft[name] = { baseUrl: String(ep.baseUrl || '').trim(), model: String(ep.model || '').trim() };
      }
    } else if (conf.baseUrl || conf.model) {
      // 旧版只有一组地址：按“这个地址是哪个服务商的默认值”归位，
      // 避免把另一家的默认地址当成自定义地址留下来
      const legacyBase = String(conf.baseUrl || '').trim().replace(/\/$/, '');
      const owner = Object.keys(defaults).find(n => defaults[n].baseUrl === legacyBase) || provider;
      epDraft[owner] = {
        baseUrl: legacyBase === defaults[owner].baseUrl ? '' : legacyBase,
        model: owner === provider ? String(conf.model || '').trim() : ''
      };
    }
    showEndpoint();
    el('cf-min').value = conf.minDelay ?? 15;
    el('cf-max').value = conf.maxDelay ?? 120;
    el('cf-limit').value = conf.dailyLimit ?? 30;
    el('cf-start').value = conf.workStart ?? 9;
    el('cf-end').value = conf.workEnd ?? 23;
    el('cf-focus').checked = !!conf.focusTab;
    el('cf-tlfast').checked = conf.tlFast !== false;
    el('cf-tlgap-min').value = conf.tlGapMin ?? 3;
    el('cf-tlgap-max').value = conf.tlGapMax ?? 6;
    showProviderRows();
    await showKeyState();
  }

  const notifyConfig = () => { try { window.dispatchEvent(new CustomEvent('xfa-config-changed')); } catch {} };

  /* 只显示当前服务商的密钥输入框 */
  function showProviderRows() {
    const ds = el('cf-provider').value === 'deepseek';
    el('cf-ds-row').hidden = !ds;
    el('cf-sf-row').hidden = ds;
  }

  /* 有未保存的修改时提示，避免改完直接关掉 */
  function setDirty(on) {
    el('cf-save').textContent = on ? '保存配置（有未保存修改）' : '保存配置';
    if (el('cf-save').classList) el('cf-save').classList.toggle('dirty', on);
  }
  for (const id of ['cf-base', 'cf-model', 'cf-sf-key', 'cf-ds-key', 'cf-remember-sf', 'cf-remember-ds', 'cf-min', 'cf-max', 'cf-limit', 'cf-start', 'cf-end', 'cf-focus', 'cf-tlfast', 'cf-tlgap-min', 'cf-tlgap-max']) {
    el(id).oninput = () => setDirty(true);
    el(id).onchange = () => setDirty(true);
  }

  el('cf-provider').onchange = () => {
    stashEndpoint();       // 先把上一家的地址/模型存回它自己的槽位
    showEndpoint();        // 再回填当前服务商的那一套
    showProviderRows();
    setDirty(true);
  };

  el('cf-save').onclick = async () => {
    try {
    const min = Number(el('cf-min').value), max = Number(el('cf-max').value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 15 || max > 600 || max < min) {
      el('cf-status').textContent = '间隔需满足 15 ≤ 最短 ≤ 最长 ≤ 600 秒。';
      return;
    }
    const limit = Number(el('cf-limit').value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
      el('cf-status').textContent = '每日上限需为 1–2000 之间的整数。';
      return;
    }
    const gapMin = Number(el('cf-tlgap-min').value), gapMax = Number(el('cf-tlgap-max').value);
    if (!Number.isFinite(gapMin) || !Number.isFinite(gapMax) || gapMin < 1 || gapMax > 60 || gapMax < gapMin) {
      el('cf-status').textContent = '翻页间隔需满足 1 ≤ 最短 ≤ 最长 ≤ 60 秒。';
      return;
    }
    const cur = await readStorage(chrome.storage.local, 'xfa-config-v1') || {};
    const provider = currentProvider();
    stashEndpoint();   // 认的是“刚才显示的那一家”，与下拉框选择无关
    // 空字符串表示“用默认值”，两家的地址与模型各存各的，互不覆盖
    const endpoints = {
      siliconflow: { baseUrl: epDraft.siliconflow.baseUrl, model: epDraft.siliconflow.model },
      deepseek: { baseUrl: epDraft.deepseek.baseUrl, model: epDraft.deepseek.model }
    };
    const sanitize = base => base.trim().replace(/\/$/, '');
    for (const name of Object.keys(defaults)) {
      endpoints[name].baseUrl = sanitize(endpoints[name].baseUrl);
      endpoints[name].model = endpoints[name].model.trim();
    }
    const next = {
      ...cur,
      provider,
      endpoints,
      baseUrl: endpoints[provider].baseUrl || defaults[provider].baseUrl,
      model: endpoints[provider].model || defaults[provider].model,
      minDelay: min, maxDelay: max, dailyLimit: limit,
      workStart: Number(el('cf-start').value), workEnd: Number(el('cf-end').value),
      focusTab: el('cf-focus').checked,
      tlFast: el('cf-tlfast').checked, tlGapMin: gapMin, tlGapMax: gapMax
    };
    await writeStorage(chrome.storage.local, { 'xfa-config-v1': next });

    // 密钥落点由“记住”开关决定：勾选写本地，否则只写会话。
    const sfKey = el('cf-sf-key').value.trim();
    const dsKey = el('cf-ds-key').value.trim();
    const rememberSf = el('cf-remember-sf').checked;
    const remember = el('cf-remember-ds').checked;
    const sessionPatch = {};
    if (sfKey && !rememberSf) sessionPatch.siliconflowKey = sfKey;
    if (dsKey && !remember) sessionPatch.deepseekKey = dsKey;
    if (Object.keys(sessionPatch).length) {
      const curSecret = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      await writeStorage(chrome.storage.session, { 'xfa-secret-v1': { ...curSecret, ...sessionPatch } });
      const verified = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      if (Object.keys(sessionPatch).some(key => verified[key] !== sessionPatch[key])) throw Error('密钥保存后未能验证，请重试');
    }
    if (rememberSf) {
      // 勾选“记住”但没重新输入时，优先沿用本地已存的密钥，其次才用会话里的，
      // 避免用旧的会话密钥覆盖掉已经记住的密钥。
      const savedLocal = await readStorage(chrome.storage.local, 'xfa-siliconflow-secret-v1') || {};
      const curSession = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      const keep = sfKey || savedLocal.siliconflowKey || curSession.siliconflowKey;
      if (keep) {
        await writeStorage(chrome.storage.local, { 'xfa-siliconflow-secret-v1': { siliconflowKey: keep } });
        const verified = await readStorage(chrome.storage.local, 'xfa-siliconflow-secret-v1') || {};
        if (verified.siliconflowKey !== keep) throw Error('硅基流动密钥保存后未能验证，请重试');
      }
    } else {
      // 取消勾选即清除本地落盘，避免残留
      await writeStorage(chrome.storage.local, { 'xfa-siliconflow-secret-v1': {} });
    }
    if (remember) {
      // 勾选“记住”但没重新输入时，优先沿用本地已存的密钥，其次才用会话里的，
      // 避免用旧的会话密钥覆盖掉已经记住的密钥。
      const savedLocal = await readStorage(chrome.storage.local, 'xfa-deepseek-secret-v1') || {};
      const curSession = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      const keep = dsKey || savedLocal.deepseekKey || curSession.deepseekKey;
      if (keep) {
        await writeStorage(chrome.storage.local, { 'xfa-deepseek-secret-v1': { deepseekKey: keep } });
        const verified = await readStorage(chrome.storage.local, 'xfa-deepseek-secret-v1') || {};
        if (verified.deepseekKey !== keep) throw Error('DeepSeek 密钥保存后未能验证，请重试');
      }
    } else {
      // 取消勾选即清除本地落盘，避免残留
      await writeStorage(chrome.storage.local, { 'xfa-deepseek-secret-v1': {} });
    }
    el('cf-sf-key').value = '';
    el('cf-ds-key').value = '';
    await showKeyState();
    showEndpoint();
    setDirty(false);
    notifyConfig();
    el('cf-status').textContent = `配置已保存（${labels[provider]} 用 ${next.baseUrl} / ${next.model}）。硅基流动密钥保存在${rememberSf ? '本地存储' : '当前会话'}；DeepSeek 密钥保存在${remember ? '本地存储' : '当前会话'}。`;
    } catch (error) {
      el('cf-status').textContent = `保存失败：${error.message || '请重试'}`;
    }
  };

  el('cf-clear-sf').onclick = async () => {
    if (!confirm('清除已保存的硅基流动密钥（含本地记住的）？')) return;
    try {
      const current = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      delete current.siliconflowKey;
      await writeStorage(chrome.storage.session, { 'xfa-secret-v1': current });
      await writeStorage(chrome.storage.local, { 'xfa-siliconflow-secret-v1': {} });
      el('cf-sf-key').value = '';
      await showKeyState();
      notifyConfig();
      el('cf-status').textContent = '硅基流动密钥已清除。';
    } catch (error) { el('cf-status').textContent = `清除失败：${error.message || '请重试'}`; }
  };

  el('cf-clear-ds').onclick = async () => {
    if (!confirm('清除已保存的 DeepSeek 密钥？')) return;
    try {
      const current = await readStorage(chrome.storage.session, 'xfa-secret-v1') || {};
      delete current.deepseekKey;
      await writeStorage(chrome.storage.session, { 'xfa-secret-v1': current });
      await writeStorage(chrome.storage.local, { 'xfa-deepseek-secret-v1': {} });
      el('cf-ds-key').value = '';
      await showKeyState();
      notifyConfig();
      el('cf-status').textContent = 'DeepSeek 密钥已清除。';
    } catch (error) { el('cf-status').textContent = `清除失败：${error.message || '请重试'}`; }
  };

  el('cf-test').onclick = async () => {
    el('cf-status').textContent = '正在测试…';
    const r = await chrome.runtime.sendMessage({ type: 'xfa-test-ai' });
    if (!r?.ok) { el('cf-status').textContent = r?.message || '测试失败'; return; }
    const res = r.result;
    el('cf-status').textContent = `来源 ${res.source} · ${res.kind}：${res.en}${res.fallbackReason ? `（回退原因：${res.fallbackReason}）` : ''}`;
  };

  el('cf-clear').onclick = async () => {
    if (!confirm('清空队列、已处理记录和采集游标？配置会保留。')) return;
    const result = await chrome.runtime.sendMessage({ type: 'xfa-clear-data' });
    if (!result?.ok) { el('cf-status').textContent = result?.message || '清空失败，请重试。'; return; }
    try { localStorage.removeItem('xfa-collect-cursor-v1'); } catch {}
    el('cf-status').textContent = '队列与记录已清空。';
    window.dispatchEvent(new CustomEvent('xfa-queue-changed'));
  };

  load().catch(error => { el('cf-key-state').textContent = `无法读取保存状态：${error.message || '请重试'}`; });
})();
