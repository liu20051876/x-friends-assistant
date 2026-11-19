const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeEl(spec = {}) {
  return {
    children: [],
    getBoundingClientRect: () => ({ width: spec.w ?? 10, height: spec.h ?? 10, top: 0, bottom: 10 }),
    getClientRects: () => ({ length: spec.visible === false ? 0 : 1 }),
    getAttribute: name => spec.attrs?.[name] ?? null,
    href: spec.href || '',
    textContent: spec.text || '',
    click() { spec.onClick?.(); },
    focus() {},
    dispatchEvent() {},
    querySelector: sel => (spec.qs || {})[sel] || null,
    querySelectorAll: sel => (spec.qsa || {})[sel] || [],
    closest: sel => (spec.closest || {})[sel] || null
  };
}

async function runFollowPage({ location, mock }) {
  const ctx = vm.createContext({
    window: { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {} },
    document: mock.document,
    location,
    URL,
    setTimeout: fn => fn()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'follow-page.js'), 'utf8'), ctx);
  return ctx.window.__xfaFollow(mock.args);
}

async function main() {
  /* ---------- 采集模式 ---------- */
  const verified = makeEl({ attrs: { 'aria-label': 'Verified account' } });
  const orgBadge = makeEl({ attrs: { 'aria-label': 'Verified organization' } });
  const followBtn = makeEl({});
  const aliceLink = makeEl({ href: 'https://x.com/alice' });
  const nameSpan = makeEl({ text: 'Alice' });
  const statusA = makeEl({ href: 'https://x.com/alice/status/123' });

  const article = kind => {
    const qsa = {
      'a[href^="/"]': kind === 'alice' ? [aliceLink] : kind === 'dup' ? [aliceLink] : [],
      'svg[data-testid="icon-verified"], [data-testid="icon-verified"]':
        kind === 'nobadge' ? [] : kind === 'org' ? [orgBadge] : [verified],
      '[data-testid="followButton"]': kind === 'nobtn' || kind === 'org' ? [] : [followBtn],
      'a[href*="/status/"]': kind === 'alice' || kind === 'dup' ? [statusA] : []
    };
    const qs = { '[data-testid="User-Name"]': makeEl({ qsa: { 'a[href^="/"]': qsa['a[href^="/"]'], 'span': [nameSpan] } }) };
    return makeEl({ qsa, qs });
  };
  const articles = [article('alice'), article('nobadge'), article('nobtn'), article('org'), article('dup')];
  const document = {
    documentElement: { scrollHeight: 1000 },
    querySelectorAll: sel => sel === 'article[data-testid="tweet"]' ? articles : []
  };
  const collected = await runFollowPage({
    location: { pathname: '/search', hostname: 'x.com' },
    mock: { document, args: { mode: 'collect', keyword: '交友' } }
  });
  assert.strictEqual(collected.ok, true);
  assert.strictEqual(collected.candidates.length, 1, 'only blue + followable + unique');
  assert.strictEqual(collected.candidates[0].handle, 'alice');
  assert.strictEqual(collected.candidates[0].badge, 'blue');

  /* ---------- 关注模式：路由门 ---------- */
  const wrong = await runFollowPage({
    location: { pathname: '/other', hostname: 'x.com' },
    mock: { document: { documentElement: {}, querySelectorAll: () => [] }, args: { mode: 'follow', handle: 'alice' } }
  });
  assert.strictEqual(wrong.ok, false);

  /* ---------- 已关注：跳过 ---------- */
  const docFollowing = {
    documentElement: {},
    querySelectorAll: sel => sel === '[data-testid="-unfollow"], [data-testid="placementTracking"]' ? [makeEl({})] : []
  };
  const skipped = await runFollowPage({
    location: { pathname: '/alice' },
    mock: { document: docFollowing, args: { mode: 'follow', handle: 'alice' } }
  });
  assert.strictEqual(skipped.ok, true);
  assert.strictEqual(skipped.skipped, true);

  /* ---------- 点击后状态翻转：关注成功 ---------- */
  let followed = false;
  const btn = makeEl({ onClick: () => { followed = true; } });
  const docClick = {
    documentElement: {},
    querySelectorAll: sel => {
      if (sel === '[data-testid="followButton"]') return followed ? [] : [btn];
      if (sel === '[data-testid="-unfollow"], [data-testid="placementTracking"]') return followed ? [makeEl({})] : [];
      if (sel === '[data-testid="confirmationSheetConfirm"]') return [];
      return [];
    }
  };
  const success = await runFollowPage({
    location: { pathname: '/alice' },
    mock: { document: docClick, args: { mode: 'follow', handle: 'alice' } }
  });
  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.by, 'following-state');

  /* ---------- 状态不翻转：uncertain ---------- */
  const docStuck = {
    documentElement: {},
    querySelectorAll: sel => sel === '[data-testid="followButton"]' ? [makeEl({})] : []
  };
  const uncertain = await runFollowPage({
    location: { pathname: '/alice' },
    mock: { document: docStuck, args: { mode: 'follow', handle: 'alice' } }
  });
  assert.strictEqual(uncertain.ok, false);
  assert.strictEqual(uncertain.uncertain, true);

  console.log('PASS: collect filtering and dedupe, route gate, skip, follow success and uncertain');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
