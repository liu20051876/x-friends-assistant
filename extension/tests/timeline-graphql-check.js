/* 时间线接口解析 + 嗅探翻页：用合成的 GraphQL 响应在 Node 里跑完整条链路。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const TL = require(path.join(root, 'timeline-graphql.js'));

function entry(id, opts = {}) {
  const { lang = 'en', views = '1200', canReply = true, promoted = false } = opts;
  return {
    entryId: (promoted ? 'promoted-' : 'tweet-') + id,
    content: {
      entryType: 'TimelineTimelineItem',
      ...(promoted ? { promotedMetadata: { advertiser_results: {} } } : {}),
      itemContent: {
        tweet_results: {
          result: {
            __typename: 'Tweet',
            rest_id: id,
            core: { user_results: { result: { __typename: 'User', core: { screen_name: 'u' + id, name: 'U' + id } } } },
            legacy: {
              full_text: lang === 'ar' ? 'مرحبا بكم في هذا المنشور الجديد عن اللعبة' : 'post ' + id,
              created_at: 'Wed Nov 18 08:00:00 +0000 2026',
              lang,
              can_reply: canReply,
              is_quote_status: false
            },
            ...(views == null ? {} : { views: { count: views } })
          }
        }
      }
    }
  };
}

function page(entries, cursor) {
  const list = [...entries];
  if (cursor) list.push({ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: cursor } });
  return { data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries: list }] } } } };
}

function makeRes(json, status = 200) {
  const text = JSON.stringify(json);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text
  };
  res.clone = () => ({ text: async () => text, json: async () => JSON.parse(text) });
  return res;
}

async function main() {
  /* ---------- 纯解析 ---------- */
  const first = page([
    entry('11'), entry('12'), entry('13'),
    entry('ad1', { promoted: true }),
    entry('ar1', { lang: 'ar' }),
    entry('noviews', { views: null }),
    entry('low', { views: '80' }),
    entry('noreply', { canReply: false })
  ], 'CURSOR-1');
  const parsed = TL.parseInstructions(first);
  assert.strictEqual(parsed.cards.length, 8, '8 条 tweet 全部解析出来');
  assert.strictEqual(parsed.cursor, 'CURSOR-1', '取 Bottom 游标');
  const ad = parsed.cards.find(c => c.id === 'ad1');
  assert.strictEqual(ad.promoted, true, '带 promotedMetadata 的 entry 判为广告');
  assert.strictEqual(parsed.cards.find(c => c.id === 'ar1').arabic, true, 'lang=ar 判为阿语');
  assert.strictEqual(parsed.cards.find(c => c.id === '11').arabic, false);
  assert.strictEqual(parsed.cards.find(c => c.id === '11').views, 1200);
  assert.strictEqual(parsed.cards.find(c => c.id === 'noviews').views, null);
  assert.strictEqual(parsed.cards.find(c => c.id === 'noreply').replyVisible, false);
  assert.strictEqual(parsed.cards.find(c => c.id === '11').handle, 'u11');
  assert.strictEqual(parsed.cards.find(c => c.id === '11').date, '2026-11-18T08:00:00.000Z');

  /* 计数换算 */
  assert.strictEqual(TL.parseCount('1,234'), 1234);
  assert.strictEqual(TL.parseCount('3.6M'), 3600000);
  assert.strictEqual(TL.parseCount('1.2万'), 12000);
  assert.strictEqual(TL.parseCount(null), null);

  /* ---------- 嗅探 + 主动翻页 ---------- */
  const srcGraphql = fs.readFileSync(path.join(root, 'timeline-graphql.js'), 'utf8');
  const srcSniff = fs.readFileSync(path.join(root, 'timeline-sniff.js'), 'utf8');
  const queries = [];
  const mockFetch = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    const cursor = (body.variables && body.variables.cursor) || '';
    queries.push({ cursor, headers: (init && init.headers) || {} });
    if (cursor === '') return makeRes(first);
    if (cursor === 'CURSOR-1') return makeRes(page([entry('21'), entry('22'), entry('23')], 'CURSOR-2'));
    return makeRes(page([entry('31')], ''));
  };
  const win = { fetch: mockFetch, innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  const ctx = vm.createContext({
    window: win,
    document: { cookie: 'ct0=FRESHTOKEN; auth_token=x' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    Headers: undefined,
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctx.window.window = win;
  vm.runInContext(srcGraphql, ctx);
  assert.ok(ctx.XfaTl, '解析模块应挂到全局（浏览器里就是 window.XfaTl）');
  vm.runInContext(srcSniff, ctx);
  assert.strictEqual(typeof ctx.window.__xfaSniff.collect, 'function', '嗅探器应挂到 window.__xfaSniff');

  /* 收藏前先确认：没有捕获时应明确失败，而不是空转 */
  const miss = await ctx.window.__xfaSniff.collect({ target: 5, templateWaitMs: 100 });
  assert.strictEqual(miss.ok, false, '没抓到响应必须返回 ok:false 让上层退回滚动');
  assert.match(miss.error, /没有捕获/);

    // 模拟页面自己发的首屏请求（这会同时被记成模板）
    await ctx.window.fetch('https://x.com/i/api/graphql/abc123/HomeTimeline', {
      method: 'POST',
      headers: { authorization: 'Bearer AAA', 'x-csrf-token': 'STALE', 'content-type': 'application/json', 'content-length': '999' },
      body: JSON.stringify({ variables: { count: 20 }, queryId: 'abc123' })
    });
    // 等 clone().text() 的回调跑完
    await new Promise(r => setTimeout(r, 60));

    const got = await ctx.window.__xfaSniff.collect({ target: 30, minViews: 500, gapMin: 1, gapMax: 1, maxPages: 3, templateWaitMs: 300 });
    assert.strictEqual(got.ok, true, got.error);
    assert.ok(got.cards.length >= 11, '首屏 8 条 + 第二页 3 条，应拿到至少 11 条，实得 ' + got.cards.length);
    assert.strictEqual(got.cards.filter(c => c.id === '11').length, 1, '跨页不重复');
    assert.ok(queries.length >= 2, '应至少主动翻了一页');
    const replay = queries[queries.length - 1];
    assert.strictEqual(replay.headers['x-csrf-token'], 'FRESHTOKEN', 'csrf 每次从 cookie 重取，不用模板里的旧值');
    assert.ok(!('content-length' in replay.headers), 'content-length 必须删掉');
    assert.ok(replay.cursor !== '', '翻页要带 cursor');
    assert.match(got.diag, /mode=sniff/, '诊断串标明走的是接口');
    assert.match(got.diag, /pages=3/, '诊断串记录页数（首屏 + 2 页翻页）');
    // hits 只算过筛的：首屏 11/12/13 + 第二页 21/22/23；广告、阿语、无浏览数、低浏览、不可回复都被排除
    assert.ok(got.hits >= 6, 'hit 计数至少 6，实得 ' + got.hits);

  /* 429 时应停下并带上状态码，不再继续翻页 */
  const ctx2 = vm.createContext({
    window: {
      innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {},
      addEventListener() {}, removeEventListener() {},
      fetch: async (url, init) => {
        const body = JSON.parse((init && init.body) || '{}');
        const cursor = (body.variables && body.variables.cursor) || '';
        if (!cursor) return makeRes(first);
        return makeRes({ errors: [{ message: 'rate limited' }] }, 429);
      }
    },
    document: { cookie: 'ct0=T' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctx2.window.window = ctx2.window;
  vm.runInContext(srcGraphql, ctx2);
  vm.runInContext(srcSniff, ctx2);
  await ctx2.window.fetch('https://x.com/i/api/graphql/abc/HomeTimeline', {
    method: 'POST', headers: { authorization: 'Bearer A' }, body: JSON.stringify({ variables: {} })
  });
  await new Promise(r => setTimeout(r, 60));
  const limited = await ctx2.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 3, templateWaitMs: 200 });
  assert.strictEqual(limited.ok, true, '已被限流也要把首屏这批交出来');
  assert.match(limited.diag, /st=429/, '诊断串带 429');

  /* 页面用 fetch(new Request(...)) 发请求：模板必须从 Request 对象里读出来 */
  const reqQueries = [];
  class FakeRequest {
    constructor(url, opts = {}) {
      this.url = url;
      this.method = opts.method || 'GET';
      this.headers = opts.headers || {};
      this._body = opts.body || '';
      this.clone = () => ({ text: async () => this._body });
    }
  }
  const ctxR = vm.createContext({
    window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    document: { cookie: 'ct0=T2' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctxR.window.window = ctxR.window;
  ctxR.window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const bodyText = init && init.body ? init.body : (input && input._body) || '';
    const body = JSON.parse(bodyText || '{}');
    const cursor = (body.variables && body.variables.cursor) || '';
    reqQueries.push({ cursor, method: init && init.method ? init.method : (input && input.method) });
    if (cursor === '') return makeRes(first);
    if (cursor === 'CURSOR-1') return makeRes(page([entry('41'), entry('42')], ''));
    return makeRes(page([entry('99')], ''));
  };
  ctxR.FakeRequest = FakeRequest;
  vm.runInContext(srcGraphql, ctxR);
  vm.runInContext(srcSniff, ctxR);
  await ctxR.window.fetch(new FakeRequest('https://x.com/i/api/graphql/qq/HomeTimeline', {
    method: 'POST', headers: { authorization: 'Bearer R' }, body: JSON.stringify({ variables: {} })
  }));
  await new Promise(r => setTimeout(r, 80));
  const viaReq = await ctxR.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 3, templateWaitMs: 200 });
  assert.strictEqual(viaReq.ok, true, viaReq.error);
  assert.match(viaReq.diag, /reqobj=1/, '应识别到 Request 对象形式的请求');
  assert.strictEqual(viaReq.diag.includes('err='), false, 'Request 对象也能翻页，不该报没有模板：' + viaReq.diag);
  assert.ok(viaReq.cards.length >= 10, '应翻到第二页，实得 ' + viaReq.cards.length);

  /* 模板完全拿不到（请求没被包到）：不硬发请求，改成让页面自己滚、只吸收新响应 */
  let nudged = 0;
  const ctxN = vm.createContext({
    window: {
      innerHeight: 800, scrollY: 0, scrollTo() {},
      scrollBy() {
        nudged++;
        // 这个请求也故意不带 body、也不是 Request，模板依旧为空
        if (nudged === 1) ctxN.window.fetch('https://x.com/i/api/graphql/zz/HomeTimeline?page=2', { method: 'POST' });
      },
      dispatchEvent() {}, addEventListener() {}, removeEventListener() {}
    },
    document: { cookie: 'ct0=T3' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    URL,
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctxN.window.window = ctxN.window;
  ctxN.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('page=2')) return makeRes(page([entry('51'), entry('52')], 'CURSOR-N'));
    return makeRes(first);
  };
  vm.runInContext(srcGraphql, ctxN);
  vm.runInContext(srcSniff, ctxN);
  await ctxN.window.fetch('https://x.com/i/api/graphql/zz/HomeTimeline', { method: 'POST' });
  await new Promise(r => setTimeout(r, 80));
  const noTpl = await ctxN.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 6, templateWaitMs: 200 });
  assert.strictEqual(noTpl.ok, true, noTpl.error);
  assert.match(noTpl.diag, /tpl=0/, '这次确实没有模板');
  assert.match(noTpl.diag, /get=0/, '也没有 GET 模板');
  assert.match(noTpl.diag, /nudges=/, '应走「让页面自己滚」的路子');
  assert.ok(noTpl.cards.some(c => c.id === '51'), '滚出来的新响应也要吸收，实得 ' + noTpl.cards.length);
  assert.strictEqual(noTpl.cards.filter(c => c.id === '11').length, 1, '不重复');

  /* 首页时间线实际走 GET：游标与 features 都在 query 里，直接改写 URL 就能翻页 */
  const getCalls = [];
  const ctxG = vm.createContext({
    window: {
      innerHeight: 800, scrollY: 0, scrollTo() {},
      scrollBy() { throw Error('有 GET 模板就不该靠滚动'); },
      dispatchEvent() {}, addEventListener() {}, removeEventListener() {}
    },
    document: { cookie: 'ct0=GT' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    URL,
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctxG.window.window = ctxG.window;
  ctxG.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    getCalls.push(url);
    const u = new URL(url);
    const vars = JSON.parse(u.searchParams.get('variables') || '{}');
    if (!vars.cursor) return makeRes(first);
    if (vars.cursor === 'CURSOR-1') return makeRes(page([entry('61'), entry('62')], 'CURSOR-2'));
    return makeRes(page([entry('71')], ''));
  };
  vm.runInContext(srcGraphql, ctxG);
  vm.runInContext(srcSniff, ctxG);
  await ctxG.window.fetch(
    'https://x.com/i/api/graphql/gg/HomeTimeline?variables=' + encodeURIComponent(JSON.stringify({ count: 20, cursor: null }))
    + '&features=' + encodeURIComponent(JSON.stringify({ f: 1 })),
    { method: 'GET', headers: { authorization: 'Bearer G' } }
  );
  await new Promise(r => setTimeout(r, 60));
  const viaGet = await ctxG.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 3, templateWaitMs: 200 });
  assert.strictEqual(viaGet.ok, true, viaGet.error);
  assert.match(viaGet.diag, /get=1/, '诊断串应标明拿到了 GET 模板：' + viaGet.diag);
  assert.match(viaGet.diag, /reqs=2/, 'GET 模板要真的翻两页：' + viaGet.diag);
  assert.ok(viaGet.cards.some(c => c.id === '61'), '第二页的卡要收进来');
  const second = new URL(getCalls[1]);
  const sv = JSON.parse(second.searchParams.get('variables'));
  assert.strictEqual(sv.cursor, 'CURSOR-1', '游标写回 variables');
  assert.strictEqual(sv.count, 20, '其它变量原样保留');
  assert.ok(second.searchParams.get('features'), 'features 也要保留');

  /* 重放被拒（403，缺 client-transaction-id）时不要整批作废：改用「页面自己滚、只读响应」继续攒 */
  const ctxD = vm.createContext({
    window: {
      innerHeight: 800, scrollY: 0, scrollTo() {},
      scrollBy() { ctxD.window.fetch('https://x.com/i/api/graphql/dd/HomeTimeline?page=2', { method: 'POST' }); },
      dispatchEvent() {}, addEventListener() {}, removeEventListener() {}
    },
    document: { cookie: 'ct0=D' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    URL,
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctxD.window.window = ctxD.window;
  ctxD.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('page=2')) return makeRes(page([entry('81'), entry('82')], ''));
    const u = new URL(url);
    const vars = JSON.parse(u.searchParams.get('variables') || '{}');
    if (vars.cursor) return makeRes({ errors: [{ message: 'forbidden' }] }, 403);
    return makeRes(first);
  };
  vm.runInContext(srcGraphql, ctxD);
  vm.runInContext(srcSniff, ctxD);
  await ctxD.window.fetch('https://x.com/i/api/graphql/dd/HomeTimeline?variables=' + encodeURIComponent(JSON.stringify({ count: 20 })), { method: 'GET' });
  await new Promise(r => setTimeout(r, 60));
  const replayFail = await ctxD.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 6, templateWaitMs: 200 });
  assert.strictEqual(replayFail.ok, true, replayFail.error);
  assert.match(replayFail.diag, /st=403/, '诊断串要留下 403：' + replayFail.diag);
  assert.match(replayFail.diag, /replay=1/, '应记录一次重放被拒');
  assert.ok(replayFail.cards.some(c => c.id === '81'), '重放失败后应接着读页面自己的响应，实得 ' + replayFail.cards.length);

  /* Blob body：异步读出文本后也能记成模板并翻页 */
  const blobCalls = [];
  const ctxB = vm.createContext({
    window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    document: { cookie: 'ct0=B' },
    location: { origin: 'https://x.com', pathname: '/home' },
    XMLHttpRequest: function () { this.addEventListener = () => {}; },
    Blob, URL,
    setTimeout, clearTimeout, Math, JSON, Date, Promise
  });
  ctxB.window.window = ctxB.window;
  ctxB.window.fetch = async (url, init) => {
    let bodyText = '';
    if (init && init.body) bodyText = typeof init.body === 'string' ? init.body : await init.body.text();
    blobCalls.push({ body: bodyText });
    const body = JSON.parse(bodyText || '{}');
    if (!body.variables || !body.variables.cursor) return makeRes(first);
    return makeRes(page([entry('91')], ''));
  };
  vm.runInContext(srcGraphql, ctxB);
  vm.runInContext(srcSniff, ctxB);
  await ctxB.window.fetch('https://x.com/i/api/graphql/bb/HomeTimeline', {
    method: 'POST',
    headers: { authorization: 'Bearer B' },
    body: new Blob([JSON.stringify({ variables: { count: 20 } })], { type: 'application/json' })
  });
  await new Promise(r => setTimeout(r, 120));
  const viaBlob = await ctxB.window.__xfaSniff.collect({ target: 30, minViews: 0, gapMin: 1, gapMax: 1, maxPages: 3, templateWaitMs: 200 });
  assert.strictEqual(viaBlob.ok, true, viaBlob.error);
  assert.match(viaBlob.diag, /body=Blob/, '诊断串记录 body 类型：' + viaBlob.diag);
  assert.ok(blobCalls.length >= 2, 'Blob 模板也应真的翻页');
  const replayBody = JSON.parse(blobCalls[1].body);
  assert.strictEqual(replayBody.variables.count, 20, '原 body 变量保留');

  console.log('PASS: timeline GraphQL parse (ads/Arabic/views/cursor) + sniff pagination + 429 stop');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
