/* 注入 X 关注/粉丝列表页（MAIN world，document_start）。
 * 被动接收 X 自身发出的 graphql 响应，同时支持 Following 与 Followers 两种数据结构。
 * 可根据页面自身请求进行只读分页；lease 到期自动失效，stop() 会还原 fetch/XHR。 */
(() => {
  const KEY = '__xfaGraphReader01';
  if (window[KEY]) return;

  const route = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(following|followers)(\/|$)/i);
  if (!route) return;
  const owner = route[1].toLowerCase();
  const kind = route[2].toLowerCase(); // following | followers
  const tail = kind === 'following' ? 'Following' : 'Followers';

  const users = new Map();
  let bottom = false;
  let pages = 0;
  let error = '';
  let lease = Date.now() + 90000;
  let pageRequest = null, bottomCursor = null, previousCursor = null;

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const reqUrl = new WeakMap();
  const reqMethod = new WeakMap();
  const reqHeaders = new WeakMap();

  function accepts(raw) {
    try {
      const u = new URL(raw, location.origin);
      if (u.origin !== location.origin) return false;
      if (Date.now() > lease) return false;
      if (location.pathname.toLowerCase().replace(/\/$/, '') !== '/' + owner + '/' + kind) return false;
      return new RegExp('/graphql/[^/]+/' + tail + '$', 'i').test(u.pathname);
    } catch { return false; }
  }

  function pickTimeline(data) {
    const r = data?.data?.user?.result;
    return r?.timeline?.timeline || r?.timeline || r?.timeline_v2?.timeline || null;
  }

  function ingest(data) {
    if (Date.now() > lease) return;
    if (data?.errors?.length) {
      error = 'X 返回错误：' + String(data.errors[0]?.message || '').slice(0, 120);
      return;
    }
    const instructions = pickTimeline(data)?.instructions;
    if (!Array.isArray(instructions)) {
      error = '关注/粉丝数据结构无法识别';
      return;
    }

    let found = 0;
    for (const ins of instructions) {
      // 明确的结束信号，比"连续无新增"更可靠
      if (ins.type === 'TimelineTerminateTimeline' && String(ins.direction || '').toLowerCase() === 'bottom') bottom = true;

      for (const entry of [...(ins.entries || []), ...(ins.entry ? [ins.entry] : [])]) {
        const c = entry.content;
        if (!c) continue;
        if (/^cursor-bottom/i.test(entry.entryId || '') || c.cursorType === 'Bottom') {
          if (c.cursorType === 'Bottom' && c.value) bottomCursor = c.value;
          else if (c.cursorType === 'Bottom' && !c.value) { bottomCursor = null; bottom = true; }
          continue;
        }

        const results = [];
        const push = r => { if (r) results.push(r); };
        push(c.itemContent?.user_results?.result);
        push(c.user_results?.result);
        for (const it of c.items || []) {
          push(it?.item?.itemContent?.user_results?.result);
          push(it?.item?.user_results?.result);
        }

        for (let u of results) {
          if (u.__typename === 'UserWithVisibilityResults') u = u.user;
          if (!u || u.__typename !== 'User') continue;
          const handle = u.core?.screen_name || u.legacy?.screen_name;
          if (!u.rest_id || !handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;

          const rp = u.relationship_perspectives || {};
          const followedBy = rp.followed_by ?? u.legacy?.followed_by;
          const following = rp.following ?? u.legacy?.following;

          const prev = users.get(handle.toLowerCase());
          if (users.size >= 50000 && !prev) { error = '超过单次读取上限 50000'; return; }

          users.set(handle.toLowerCase(), {
            handle,
            restId: String(u.rest_id),
            name: String(u.core?.name || u.legacy?.name || handle).slice(0, 200),
            // 对方是否关注我；在 Following 页由该字段直接给出互关状态
            theyFollowMe: typeof followedBy === 'boolean' ? followedBy : (prev?.theyFollowMe ?? null),
            // 我是否关注对方；在 Followers 页由该字段直接给出互关状态
            iFollowThem: typeof following === 'boolean' ? following : (prev?.iFollowThem ?? null),
            protected: !!(u.legacy?.protected ?? u.is_protected),
            restricted: !!(u.legacy?.limited_actions ?? u.restricted)
          });
          found++;
        }
      }
    }
    if (found) pages++;
  }

  function inspect(response, url) {
    if (!accepts(url)) return;
    if (response.status === 429 || response.status === 401 || response.status === 403) {
      error = `X 返回限流或授权限制（${response.status}），已停止识别`;
      return;
    }
    if (!response.ok) { error = `请求失败（${response.status}）`; return; }
    response.clone().json().then(ingest).catch(() => { error = '无法解析返回数据'; });
  }

  function wrappedFetch(...args) {
    const raw = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (accepts(raw)) {
      try { const req = new Request(args[0], args[1]); if (req.method === 'GET') pageRequest = req; } catch {}
    }
    return originalFetch.apply(this, args).then(res => { inspect(res, raw); return res; });
  }

  function wrappedOpen(method, url, ...rest) {
    reqUrl.set(this, url);
    reqMethod.set(this, String(method || 'GET').toUpperCase());
    this.addEventListener('load', () => {
      if (!accepts(reqUrl.get(this))) return;
      if (this.status !== 200) { error = '请求失败或受限'; return; }
      try {
        ingest(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
      } catch { error = '无法解析返回数据'; }
    }, { once: true });
    return originalOpen.call(this, method, url, ...rest);
  }

  function wrappedSetHeader(name, value) {
    if (accepts(reqUrl.get(this))) {
      const map = reqHeaders.get(this) || {};
      map[name] = value;
      reqHeaders.set(this, map);
    }
    return originalSetHeader.call(this, name, value);
  }

  /* X 有时用 XHR 拉时间线。原来只记了 URL，导致 fastNext 拿不到"模板请求"，
   * 于是隐藏标签里既不能翻页也不能滚动。这里把方法、URL、请求头一起存下来。 */
  function wrappedSend(...args) {
    const url = reqUrl.get(this);
    if (url && accepts(url) && reqMethod.get(this) === 'GET') {
      try {
        pageRequest = new Request(new URL(url, location.origin).href, {
          method: 'GET',
          headers: reqHeaders.get(this) || {}
        });
      } catch {}
    }
    return originalSend.apply(this, args);
  }

  window.fetch = wrappedFetch;
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.setRequestHeader = wrappedSetHeader;
  XMLHttpRequest.prototype.send = wrappedSend;

  window[KEY] = {
    snapshot() {
      lease = Date.now() + 90000;
      const list = [...users.values()];
      const mutual = list.filter(u => u.theyFollowMe === true && u.iFollowThem !== false).length;
      const notMutual = list.filter(u => u.theyFollowMe === false).length;
      return {
        owner, kind, users: list, pages, error, bottom,
        counts: {
          all: list.length,
          mutual,
          notMutual,
          unknown: list.length - mutual - notMutual,
          protected: list.filter(u => u.protected).length,
          restricted: list.filter(u => u.restricted).length
        }
      };
    },
    scrollTo(top) { window.scrollTo({ top, behavior: 'instant' }); },
    /* 诊断用：翻不了页时先看清楚缺的是哪一块，别靠猜 */
    debug() {
      return {
        hasRequest: !!pageRequest,
        reqPath: pageRequest ? String(pageRequest.url).replace(location.origin, '').slice(0, 100) : '',
        hasCursor: !!bottomCursor,
        pages,
        users: users.size,
        bottom,
        error
      };
    },
    async fastNext() {
      if (!pageRequest) return { available: false, reason: '未捕获到模板请求（X 可能换了发请求的方式）' };
      if (!bottomCursor) return { available: false, reason: '没有拿到翻页游标' };
      if (bottomCursor === previousCursor) return { available: false, reason: '分页游标未变化' };
      const cursor = bottomCursor;
      const url = new URL(pageRequest.url);
      let vars;
      try { vars = JSON.parse(url.searchParams.get('variables') || '{}'); } catch { return { available: false }; }
      vars.cursor = cursor;
      url.searchParams.set('variables', JSON.stringify(vars));
      previousCursor = cursor;
      bottomCursor = null;
      try {
        const res = await originalFetch.call(window, new Request(url.href, pageRequest));
        if (res.status === 429 || res.status === 401 || res.status === 403) { error = `X 返回限流或授权限制（${res.status}），已停止读取`; return { available: true }; }
        if (!res.ok) { error = `分页请求失败（${res.status}），已停止读取`; return { available: true }; }
        ingest(await res.json());
        return { available: true };
      } catch { error = '分页请求失败，已停止读取'; return { available: true }; }
    },
    scrollNext() { window.scrollBy({ top: Math.max(500, Math.floor(innerHeight * 0.85)), behavior: 'instant' }); },
    atBottom() { return innerHeight + scrollY >= document.documentElement.scrollHeight - 4; },
    stop() {
      users.clear();
      pageRequest = null; bottomCursor = null; previousCursor = null;
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
      if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalSend;
      if (XMLHttpRequest.prototype.setRequestHeader === wrappedSetHeader) XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
      delete window[KEY];
    }
  };
})();
