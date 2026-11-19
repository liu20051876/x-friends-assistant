/* X 页面悬浮球 + 可拖动悬浮窗。悬浮窗内嵌完整工作台（dashboard.html?embed=1），与侧栏共用同一套数据。
 * 扩展自己开的后台工作标签（发送、采集、发帖、读名单）不显示，避免遮挡页面或抢焦点。
 * 只在授予 X 页面权限后由 background 注册注入；本脚本不读取、不点击页面内容。 */
(() => {
  if (window.top !== window || window.__xfaFloat) return;
  window.__xfaFloat = true;
  document.getElementById('xfa-floating-root')?.remove(); // 0.4 旧版悬浮球

  const KEY = 'xfa-float-v1';
  const BALL = 52, GAP = 14, MIN_W = 340, MIN_H = 420;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  let prefs = { autoOpen: true, ball: null, win: null };

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    #ball{position:fixed;width:${BALL}px;height:${BALL}px;border-radius:50%;border:0;padding:0;cursor:grab;color:#fff;
      background:linear-gradient(140deg,#5b92ff,#2251e0);box-shadow:0 8px 22px rgba(34,81,224,.38),0 0 0 3px #fff;
      display:grid;place-items:center;touch-action:none;transition:transform .15s,box-shadow .15s,left .22s ease,top .22s ease}
    #ball:hover{transform:scale(1.07);box-shadow:0 10px 26px rgba(34,81,224,.45),0 0 0 3px #fff}
    #ball:focus-visible{outline:3px solid #93b4ff;outline-offset:3px}
    #ball.dragging{cursor:grabbing;transition:none;transform:scale(1.1)}
    #ball svg{width:25px;height:25px;pointer-events:none}
    #win{position:fixed;display:flex;flex-direction:column;background:#f4f6fb;border-radius:14px;overflow:hidden;
      box-shadow:0 24px 64px rgba(15,27,45,.3),0 0 0 1px rgba(15,27,45,.08);
      font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#0f1b2d;animation:pop .16s ease-out}
    @keyframes pop{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}
    #bar{display:flex;align-items:center;gap:6px;height:42px;flex:none;padding:0 6px 0 10px;cursor:move;user-select:none;touch-action:none;
      background:linear-gradient(135deg,#2f6bff,#1d4fd8);color:#fff}
    .logo{width:24px;height:24px;border-radius:7px;background:rgba(255,255,255,.2);display:grid;place-items:center;flex:none}
    .logo svg{width:15px;height:15px}
    #title{flex:1;min-width:0;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .auto{display:flex;align-items:center;gap:5px;font-size:12px;padding:4px 8px;border-radius:8px;cursor:pointer;white-space:nowrap}
    .auto:hover{background:rgba(255,255,255,.16)}
    .auto input{margin:0;accent-color:#fff;cursor:pointer}
    .ico{width:30px;height:30px;flex:none;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer;display:grid;place-items:center;font:inherit}
    .ico:hover{background:rgba(255,255,255,.18)}
    .ico:focus-visible,.auto:focus-within{outline:2px solid #fff;outline-offset:-2px}
    .ico svg{width:16px;height:16px}
    #body{flex:1;position:relative;min-height:0}
    #body iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#f4f6fb}
    #win.busy #body iframe{pointer-events:none}
    #loading{position:absolute;inset:0;display:grid;place-items:center;color:#667489}
    #grip{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;
      background:linear-gradient(135deg,transparent 50%,#b8c3d4 50%,#b8c3d4 58%,transparent 58%,transparent 70%,#b8c3d4 70%,#b8c3d4 78%,transparent 78%)}
    #tip{position:absolute;left:50%;top:50px;transform:translateX(-50%);background:#0f1b2d;color:#fff;padding:7px 12px;border-radius:8px;font-size:12px;
      box-shadow:0 6px 18px rgba(0,0,0,.25);max-width:90%;z-index:2}
    @media (prefers-reduced-motion:reduce){#ball,#win{transition:none;animation:none}}`;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), Math.max(lo, hi)); }

  async function savePrefs() {
    if (!alive()) return;
    try { await chrome.storage.local.set({ [KEY]: prefs }); } catch {}
  }

  function mount() {
    const host = document.createElement('div');
    host.id = 'xfa-float-root';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <button id="ball" type="button" aria-label="打开好友互动助手" title="好友互动助手 · 点击打开，拖动移动">${ICON}</button>
      <section id="win" role="dialog" aria-label="好友互动助手" hidden>
        <div id="bar" title="拖动移动窗口，双击恢复默认位置">
          <span class="logo">${ICON}</span><span id="title">好友互动助手</span>
          <label class="auto" title="打开 X 页面时自动展开悬浮窗"><input id="auto" type="checkbox">自动展开</label>
          <button class="ico" id="side" type="button" title="改在浏览器侧栏打开" aria-label="在侧栏打开"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
          <button class="ico" id="min" type="button" title="收起为悬浮球" aria-label="收起"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
        </div>
        <div id="body"><div id="loading">正在加载工作台…</div></div>
        <div id="grip" title="拖动调整大小"></div>
        <div id="tip" role="status" hidden></div>
      </section>`;
    const $ = id => root.getElementById(id);
    const ball = $('ball'), win = $('win'), bar = $('bar');

    /* ---------- 位置 ---------- */

    function placeBall() {
      const b = prefs.ball || { side: 'right', top: Math.round(innerHeight * 0.4) };
      ball.style.left = (b.side === 'left' ? GAP : innerWidth - BALL - GAP) + 'px';
      ball.style.top = clamp(b.top, GAP, innerHeight - BALL - GAP) + 'px';
    }

    function winRect() {
      const w = prefs.win || {};
      const width = clamp(w.width || 420, Math.min(MIN_W, innerWidth - 2 * GAP), innerWidth - 2 * GAP);
      const height = clamp(w.height || Math.min(720, innerHeight - 80), Math.min(MIN_H, innerHeight - 2 * GAP), innerHeight - 2 * GAP);
      const left = clamp(w.left ?? innerWidth - width - GAP - 8, 0, innerWidth - width);
      const top = clamp(w.top ?? 64, 0, innerHeight - height);
      return { left, top, width, height };
    }

    function placeWin(r = winRect()) {
      Object.assign(win.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    }

    addEventListener('resize', () => { placeBall(); if (!win.hidden) placeWin(); });

    /* ---------- 打开 / 收起 ---------- */

    function open() {
      if (!alive()) { host.remove(); return; }
      placeWin();
      win.hidden = false;
      ball.hidden = true;
      // 工作台第一次打开时才加载；收起只是隐藏，再次展开保留原来的标签页和滚动位置
      if (!$('body').querySelector('iframe')) {
        const frame = document.createElement('iframe');
        frame.title = '好友互动助手工作台';
        frame.allow = 'clipboard-read; clipboard-write';
        frame.src = chrome.runtime.getURL('dashboard.html?embed=1');
        frame.onload = () => $('loading')?.remove();
        $('body').append(frame);
      }
    }

    function collapse() {
      win.hidden = true;
      ball.hidden = false;
      placeBall();
      ball.focus({ preventScroll: true });
    }

    let tipTimer = 0;
    function tip(text) {
      $('tip').textContent = text;
      $('tip').hidden = false;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => { $('tip').hidden = true; }, 3500);
    }

    /* ---------- 拖动 ---------- */

    // 拖动期间 iframe 不接收指针事件（.busy），否则鼠标一进内容区就会丢失拖动
    function drag(handle, { start, move, end }) {
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || (handle === bar && e.target.closest('button,label,input'))) return;
        e.preventDefault();
        const ctx = start(e);
        handle.setPointerCapture(e.pointerId);
        const onMove = ev => move(ev, ctx);
        const onUp = ev => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          end(ev, ctx);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    }

    drag(ball, {
      start: e => ({ x: e.clientX, y: e.clientY, left: ball.offsetLeft, top: ball.offsetTop, moved: false }),
      move(e, c) {
        const dx = e.clientX - c.x, dy = e.clientY - c.y;
        if (!c.moved && Math.hypot(dx, dy) < 5) return;
        c.moved = true;
        ball.classList.add('dragging');
        ball.style.left = clamp(c.left + dx, 0, innerWidth - BALL) + 'px';
        ball.style.top = clamp(c.top + dy, GAP, innerHeight - BALL - GAP) + 'px';
      },
      end(e, c) {
        ball.classList.remove('dragging');
        if (!c.moved) { if (e.type === 'pointerup') open(); return; }
        // 松手后吸附到最近的左右边缘
        const side = ball.offsetLeft + BALL / 2 < innerWidth / 2 ? 'left' : 'right';
        prefs.ball = { side, top: ball.offsetTop };
        placeBall();
        savePrefs();
      }
    });
    ball.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });

    drag(bar, {
      start: e => { win.classList.add('busy'); return { x: e.clientX, y: e.clientY, r: winRect() }; },
      move(e, c) {
        placeWin({ ...c.r,
          left: clamp(c.r.left + e.clientX - c.x, 0, innerWidth - c.r.width),
          top: clamp(c.r.top + e.clientY - c.y, 0, innerHeight - c.r.height) });
      },
      end() {
        win.classList.remove('busy');
        prefs.win = { ...prefs.win, left: win.offsetLeft, top: win.offsetTop };
        savePrefs();
      }
    });
    bar.addEventListener('dblclick', e => {
      if (e.target.closest('button,label,input')) return;
      prefs.win = null;
      placeWin();
      savePrefs();
    });

    drag($('grip'), {
      start: e => { win.classList.add('busy'); return { x: e.clientX, y: e.clientY, r: winRect() }; },
      move(e, c) {
        placeWin({ ...c.r,
          width: clamp(c.r.width + e.clientX - c.x, MIN_W, innerWidth - c.r.left),
          height: clamp(c.r.height + e.clientY - c.y, MIN_H, innerHeight - c.r.top) });
      },
      end() {
        win.classList.remove('busy');
        prefs.win = { left: win.offsetLeft, top: win.offsetTop, width: win.offsetWidth, height: win.offsetHeight };
        savePrefs();
      }
    });

    /* ---------- 标题栏按钮 ---------- */

    $('min').onclick = collapse;
    $('auto').checked = prefs.autoOpen !== false;
    $('auto').onchange = () => {
      prefs.autoOpen = $('auto').checked;
      savePrefs();
      tip(prefs.autoOpen ? '已开启：打开 X 页面时自动展开' : '已关闭：之后只显示悬浮球，点击再打开');
    };
    $('side').onclick = async () => {
      if (!alive()) { host.remove(); return; }
      const r = await chrome.runtime.sendMessage({ type: 'xfa-open-panel' }).catch(() => null);
      if (r?.ok) collapse();
      else tip('无法自动打开侧栏，请点击浏览器工具栏中的助手图标');
    };

    // 其他标签页改了设置时同步过来；位置在下次打开/调整时生效
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]?.newValue) return;
      prefs = { ...prefs, ...changes[KEY].newValue };
      $('auto').checked = prefs.autoOpen !== false;
    });

    document.documentElement.append(host);
    placeBall();
    if (prefs.autoOpen !== false) open();
  }

  async function start() {
    if (!alive()) return;
    const r = await chrome.runtime.sendMessage({ type: 'xfa-float-init' }).catch(() => null);
    if (!r || r.automation) return;
    try {
      const saved = (await chrome.storage.local.get(KEY))[KEY];
      if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved };
    } catch {}
    mount();
  }

  // 后台打开的标签等用户真正切过来再判断：扩展自己的工作标签届时早已被标记，不会弹出
  if (document.visibilityState === 'visible') start();
  else document.addEventListener('visibilitychange', function once() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', once);
    start();
  });
})();
