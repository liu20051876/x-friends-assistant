/* 时间线接口嗅探 + 主动翻页（MAIN world，document_start 注入）。
 *
 * 思路：不靠滚动等渲染，而是包住页面自己的 fetch，把 X 发给
 * /i/api/graphql/<id>/HomeTimeline 的那份响应原样存下来——正文、作者、
 * 浏览数、语言、是否广告、游标都在里面。首屏那份通常就是 20 条，等于
 * 「一次都不滚就已经有 20 条候选」。需要更多时，用同一套请求模板（headers
 * 与 body 都是页面自己发过的）带 cursor 连翻，请求间隔由设置里的区间随机决定。
 *
 * 拿不到模板 / 首次响应 / 模板过期 / 被限流时，collect 返回 ok:false，
 * 由 background 退回原来的滚动采集，绝不空转。 */
(function () {
  if (window.__xfaSniff) return;
  const TL = window.XfaTl || globalThis.XfaTl;
  if (!TL) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const TL_URL_RE = /(HomeTimeline|HomeLatestTimeline|HomeTimelineLatest)/i;

  let template = null;   // POST 模板 { at, url, method, headers, body }
  let getTpl = null;     // GET 模板 { at, url, headers }（首页时间线就是 GET，游标在 query 里）
  let lastJson = null;   // { at, json }
  let captures = 0;
  const stats = { post: 0, reqObject: 0, noBody: 0, get: 0 };
  let lastBodyKind = 'null';
  let selfFetch = false;   // 标记我们自己重放的请求，不计入嗅探统计

  function headersToObject(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
      if (Array.isArray(h)) { for (const pair of h) out[String(pair[0]).toLowerCase()] = pair[1]; return out; }
      if (typeof h === 'object') for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    } catch {}
    return out;
  }

  function bodyKind(b) {
    if (b == null) return 'null';
    if (typeof b === 'string') return 'string';
    try { return (b.constructor && b.constructor.name) || typeof b; } catch { return typeof b; }
  }

  /* 非字符串 body 尽量读出文本：FormData / URLSearchParams 序列化成查询串，
   * Blob 和带 .text() 的对象读文本；读不出来就返回 null，留到诊断串里看类型。 */
  async function extractBody(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') return raw;
    try {
      if (typeof FormData !== 'undefined' && raw instanceof FormData) {
        const p = new URLSearchParams();
        for (const [k, v] of raw.entries()) p.set(k, String(v));
        return p.toString();
      }
      if (typeof URLSearchParams !== 'undefined' && raw instanceof URLSearchParams) return raw.toString();
      if (typeof Blob !== 'undefined' && raw instanceof Blob) return await raw.text();
      if (typeof raw.text === 'function') return await raw.text();
      return String(raw);
    } catch { return null; }
  }

  /* 把一次调用归一成 {url, method, headers, body, rawBody, req}。
   * X 有时用 fetch(new Request(url, {...}))：method/headers/body 都在 Request 里、
   * 第二个参数是 undefined，老写法会把这种情况整个漏掉，模板就抓不到。 */
  function describe(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const headers = headersToObject((init && init.headers) || (input && input.headers));
    const rawBody = init && init.body != null ? init.body : null;
    const body = typeof rawBody === 'string' ? rawBody : null;
    const req = input && typeof input === 'object' && typeof input.clone === 'function' ? input : null;
    return { url, method, headers, body, rawBody, bodyKind: bodyKind(rawBody), req };
  }

  function setTemplate(url, headers, body) {
    if (!body) return;
    template = { at: Date.now(), url, method: 'POST', headers: headers || {}, body };
  }

  async function record(desc, res) {
    try {
      if (!desc || !TL_URL_RE.test(desc.url)) return;
      lastBodyKind = desc.bodyKind;
      if (desc.method === 'GET') {
        // 首页时间线走 GET：游标、features 都在 query 里，URL 本身就是模板
        getTpl = { at: Date.now(), url: desc.url, headers: desc.headers || {} };
      } else if (desc.method === 'POST') {
        if (desc.body) setTemplate(desc.url, desc.headers, desc.body);
        else if (desc.req) {
          // Request 对象里的 body 只能异步读，clone 一份别弄坏原请求
          try {
            desc.req.clone().text().then(txt => {
              if (txt && TL_URL_RE.test(desc.url)) setTemplate(desc.url, desc.headers, txt);
            }).catch(() => {});
          } catch {}
        } else if (desc.rawBody) {
          // Blob / FormData / URLSearchParams / 流：异步读出文本再记模板
          extractBody(desc.rawBody).then(txt => {
            if (txt && TL_URL_RE.test(desc.url)) setTemplate(desc.url, desc.headers, txt);
          }).catch(() => {});
        }
      }
      if (!res || !res.ok) return;
      const clone = res.clone();
      clone.text().then(txt => {
        try { lastJson = { at: Date.now(), json: JSON.parse(txt) }; captures++; } catch {}
      }).catch(() => {});
    } catch {}
  }

  /* 包住 fetch：只观察，不改请求 */
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      const desc = describe(input, init);
      let p;
      try { p = rawFetch.apply(this, arguments); } catch (e) { throw e; }
      if (selfFetch) return p;
      try {
        if (TL_URL_RE.test(desc.url)) {
          if (desc.method === 'POST') {
            stats.post++;
            if (!desc.body) { if (desc.req) stats.reqObject++; else if (!desc.rawBody) stats.noBody++; }
          } else if (desc.method === 'GET') stats.get++;
          record(desc, null);                         // 先记模板
          p.then(res => record(desc, res)).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  /* 少数请求走 XHR，也给个最小钩子 */
  try {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__xfaUrl = String(url || '');
      this.__xfaMethod = method;
      this.__xfaHeaders = {};
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { this.__xfaHeaders = this.__xfaHeaders || {}; this.__xfaHeaders[String(name).toLowerCase()] = String(value); } catch {}
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (TL_URL_RE.test(this.__xfaUrl || '')) {
          const m = String(this.__xfaMethod || '').toUpperCase();
          if (m === 'POST') {
            stats.post++;
            lastBodyKind = bodyKind(body);
            const h = this.__xfaHeaders || {};
            if (typeof body === 'string' && body) setTemplate(this.__xfaUrl, h, body);
            else if (body) extractBody(body).then(txt => { if (txt && TL_URL_RE.test(this.__xfaUrl || '')) setTemplate(this.__xfaUrl, h, txt); }).catch(() => {});
          } else if (m === 'GET') {
            stats.get++;
            getTpl = { at: Date.now(), url: this.__xfaUrl, headers: this.__xfaHeaders || {} };
          }
          this.addEventListener('load', () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              lastJson = { at: Date.now(), json: JSON.parse(this.responseText) };
              captures++;
            } catch {}
          });
        }
      } catch {}
      return send.apply(this, arguments);
    };
  } catch {}

  function ct0FromCookie() {
    try {
      const m = String(document.cookie || '').match(/(?:^|;\s*)ct0=([^;]+)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }

  /* 用页面自己的请求模板请求下一页。
   * 两种形态都要认：
   *  - POST：body 是 JSON，改 variables.cursor 再发（headers 原样复用，content-length 必须删）
   *  - GET：游标和 features 都在 query 里（首页时间线就是这种），直接改 URL 里的 variables
   * csrf 每次从 cookie 重取。 */
  function buildGetUrl(baseUrl, cursor) {
    const u = new URL(baseUrl, location.origin);
    const raw = u.searchParams.get('variables');
    if (raw) {
      try {
        const vars = JSON.parse(raw);
        vars.cursor = cursor;
        u.searchParams.set('variables', JSON.stringify(vars));
        return u.toString();
      } catch {}
    }
    u.searchParams.set('cursor', cursor);
    return u.toString();
  }

  async function fetchPage(cursor) {
    if (template) {
      let payload;
      try { payload = JSON.parse(template.body || '{}'); } catch { return { ok: false, status: 0, error: '模板 body 无法解析' }; }
      payload.variables = Object.assign({}, payload.variables || {}, { cursor });
      const headers = Object.assign({}, template.headers);
      delete headers['content-length'];
      const ct0 = ct0FromCookie();
      if (ct0) headers['x-csrf-token'] = ct0;
      selfFetch = true;
      let res;
      try {
        res = await window.fetch(template.url, {
          method: template.method || 'POST',
          headers,
          body: JSON.stringify(payload),
          credentials: 'include'
        });
      } finally { selfFetch = false; }
      if (!res.ok) return { ok: false, status: res.status };
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { return { ok: false, status: res.status, error: '响应不是 JSON' }; }
      return { ok: true, status: res.status, json };
    }

    if (getTpl) {
      const url = buildGetUrl(getTpl.url, cursor);
      const headers = Object.assign({}, getTpl.headers);
      delete headers['content-length'];
      const ct0 = ct0FromCookie();
      if (ct0) headers['x-csrf-token'] = ct0;
      selfFetch = true;
      let res;
      try { res = await window.fetch(url, { method: 'GET', headers, credentials: 'include' }); }
      finally { selfFetch = false; }
      if (!res.ok) return { ok: false, status: res.status };
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { return { ok: false, status: res.status, error: '响应不是 JSON' }; }
      return { ok: true, status: res.status, json };
    }

    return { ok: false, status: 0, error: '没有请求模板' };
  }

  async function collect(opts) {
    const target = Math.max(1, Number(opts.target) || 20);
    const minViews = Math.max(0, Number(opts.minViews) || 0);
    const gapMin = Math.max(500, Number(opts.gapMin) || 3000);
    const gapMax = Math.max(gapMin, Number(opts.gapMax) || 6000);
    const maxPages = Math.max(1, Number(opts.maxPages) || 8);
    const templateWaitMs = Math.max(300, Number(opts.templateWaitMs) || 6000);

    const seen = new Map();
    const counter = { ad: 0, arabic: 0, noReply: 0, noViews: 0, lowViews: 0 };
    let hits = 0;
    const passes = c => {
      if (c.promoted) { counter.ad++; return false; }
      if (c.arabic) { counter.arabic++; return false; }
      if (!c.replyVisible) { counter.noReply++; return false; }
      if (c.views == null) { counter.noViews++; return false; }
      if (c.views < minViews) { counter.lowViews++; return false; }
      return true;
    };
    const absorb = json => {
      const parsed = TL.parseInstructions(json);
      for (const c of parsed.cards) {
        if (!c.id || seen.has(c.id)) continue;
        seen.set(c.id, c);
        if (passes(c)) hits++;
      }
      return parsed;
    };

    // 等页面自己发出的第一份时间线响应（强制刷新过的话通常在 1–3 秒内）
    const deadline = Date.now() + templateWaitMs;
    while (!lastJson && Date.now() < deadline) await sleep(200);
    if (!lastJson) {
      return {
        ok: false,
        error: '没有捕获到时间线接口响应（页面可能还没加载完，或接口名变了）',
        diag: `mode=sniff tpl=${template ? 1 : 0} get=${getTpl ? 1 : 0} caps=${captures} post=${stats.post} getreq=${stats.get}`
      };
    }
    if (Date.now() - lastJson.at > 10 * 60 * 1000) {
      return { ok: false, error: '捕获到的接口响应已过期', diag: `mode=sniff tpl=${template ? 1 : 0} get=${getTpl ? 1 : 0} age=${Math.round((Date.now() - lastJson.at) / 1000)}s` };
    }

    const pages = { n: 1, reqs: 0, status: 0, lastError: '', nudges: 0, replayFail: 0 };
    let parsed = absorb(lastJson.json);
    let cursor = parsed.cursor || '';
    let lastAt = lastJson.at;
    let stalls = 0;
    // replay：用抓到的模板自己翻；scroll：让页面自己滚，我们只读它发出的响应
    let mode = (template || getTpl) ? 'replay' : 'scroll';

    const waitNewCapture = async (since, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (lastJson && lastJson.at !== since) return true;
        await sleep(200);
      }
      return false;
    };

    while (hits < target && cursor && pages.n < maxPages) {
      if (mode === 'scroll') {
        /* 不自己造请求：滚一屏，等页面自己发出的那份响应。
         * 步长和 DOM 兜底一样 0.7 屏、等待 6 秒，隐藏标签里也能把它逼出来。 */
        try { window.scrollBy(0, Math.round((window.innerHeight || 800) * 0.7)); } catch {}
        try { window.dispatchEvent(new Event('scroll')); } catch {}
        pages.nudges++;
        const gotNew = await waitNewCapture(lastAt, 6000);
        if (!gotNew) {
          stalls++;
          if (stalls >= 5) { pages.lastError = pages.lastError || '滚动也没等到新响应'; break; }
          continue;
        }
        stalls = 0;
        lastAt = lastJson.at;
        parsed = absorb(lastJson.json);
        cursor = parsed.cursor || '';
        pages.n++;
        continue;
      }

      await sleep(gapMin + Math.random() * (gapMax - gapMin));
      const r = await fetchPage(cursor);
      pages.reqs++;
      if (!r.ok) {
        pages.status = r.status || pages.status;
        pages.lastError = r.error || `HTTP ${r.status}`;
        // 429 是真的被打住了：立刻停手，已拿到的照常交出去
        if (r.status === 429) break;
        /* 401/403/400/404/422 基本都是重放被拒（缺少按请求计算的 x-client-transaction-id）。
         * 重放这条路就此作废，改成让页面自己滚、我们只读响应。 */
        pages.replayFail++;
        template = null;
        getTpl = null;
        mode = 'scroll';
        continue;
      }
      pages.status = r.status;
      parsed = absorb(r.json);
      cursor = parsed.cursor || '';
      pages.n++;
    }

    return {
      ok: true,
      cards: [...seen.values()],
      hits,
      reachedTarget: hits >= target,
      counter,
      replayFail: pages.replayFail || 0,
      diag: `mode=sniff tpl=${template ? 1 : 0} get=${getTpl ? 1 : 0} pages=${pages.n} reqs=${pages.reqs} nudges=${pages.nudges} replay=${pages.replayFail || 0} st=${pages.status || '-'} cards=${seen.size} cursor=${cursor ? 1 : 0} post=${stats.post} getreq=${stats.get} reqobj=${stats.reqObject} body=${lastBodyKind}${pages.lastError ? ` err=${String(pages.lastError).replace(/\s+/g, '_')}` : ''}`
    };
  }

  window.addEventListener('message', ev => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__xfa !== 'tl-req' || d.cmd !== 'collect') return;
    const id = d.id;
    const reply = result => { try { window.postMessage({ __xfa: 'tl-res', id, result }, location.origin); } catch {} };
    collect(d.opts || {})
      .then(reply)
      .catch(e => reply({ ok: false, error: String((e && e.message) || e) }));
  });

  window.__xfaSniff = { collect, state: () => ({ tpl: !!template, cap: lastJson ? lastJson.at : 0, captures }) };
})();
