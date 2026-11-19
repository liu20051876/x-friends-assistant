/* 独立原创帖发布器，仅在用户逐条确认后由后台调用。 */
(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const textOf = el => (el?.innerText || el?.textContent || '').trim();

  function placeCaretAtEnd(el) {
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  /* 四重注入，与回复执行器同一套：execCommand 在后台标签可能静默失败，
   * 依次尝试 paste / beforeinput / 直接写 DOM。返回框内文字是否逐字一致。 */
  function writeOnce(box, text, method) {
    placeCaretAtEnd(box);
    try {
      if (method === 'exec') {
        document.execCommand('insertText', false, text);
      } else if (method === 'paste') {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } else if (method === 'beforeinput') {
        box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        document.execCommand('insertText', false, text);
      } else {
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } catch {}
    return textOf(box) === text;
  }

  /* 文字在 DOM 里但按钮没解禁：补事件，再用空格+删除制造一次真实变更。 */
  async function wakeButton(box, scope, text) {
    try {
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
    await sleep(300);
    if (findButton(scope)) return;
    try {
      placeCaretAtEnd(box);
      document.execCommand('insertText', false, ' ');
      document.execCommand('delete', false, null);
    } catch {}
    await sleep(400);
  }

  function findButton(scope) {
    const buttons = [...scope.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
      .filter(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    return buttons.length === 1 ? buttons[0] : null;
  }

  async function run(opts) {
    const text = String(opts.text || '').trim();
    const owner = String(opts.owner || '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(owner) || !text || text.length > 280) return { ok: false, error: '账号或草稿无效，未发布' };
    if (location.hostname !== 'x.com' || !/^\/compose\/(post|tweet)\/?$/.test(location.pathname)) return { ok: false, error: '页面不是 X 原创发帖页，未发布' };
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    let actual = '';
    try { actual = new URL(profile.href).pathname.split('/')[1].toLowerCase(); } catch {}
    if (actual !== owner) return { ok: false, error: '无法确认登录账号与名单账号一致，未发布' };

    let box;
    for (let i = 0; i < 40 && !box; i++) {
      box = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find(x => visible(x) && x.getAttribute('contenteditable') === 'true');
      if (!box) await sleep(250);
    }
    if (!box) return { ok: false, error: '原创发帖输入框未出现，未发布' };
    const scope = box.closest('[role="dialog"]') || box.closest('form');
    if (!scope || textOf(box)) return { ok: false, error: '无法确认空白原创编辑器，未发布' };

    // 四种注入逐种尝试，每种写完等一小会儿再比对
    let written = false;
    for (const method of ['exec', 'paste', 'beforeinput', 'dom']) {
      written = writeOnce(box, text, method);
      await sleep(350);
      if (written) break;
    }
    if (!written) {
      return { ok: false, error: `输入内容与确认的草稿不一致，未发布（框内实际为：${textOf(box).slice(0, 80) || '空'}）` };
    }

    // 按钮解禁确认；没解禁就补事件唤醒，仍不唯一则放弃
    let button = findButton(scope);
    if (!button) {
      await wakeButton(box, scope, text);
      button = findButton(scope);
    }
    if (!button) return { ok: false, error: '无法唯一确认可用的原创发布按钮，未发布' };

    const prior = document.querySelector('[data-testid="toast"]');
    const priorText = visible(prior) ? textOf(prior) : '';
    button.click();
    // 成功信号：toast、导航离开 compose、编辑器/表单消失（后两者连续两次确认）
    let goneHits = 0;
    for (let i = 0; i < 48; i++) {
      await sleep(250);
      const toast = document.querySelector('[data-testid="toast"]');
      const message = visible(toast) ? textOf(toast) : '';
      if (message && (toast !== prior || message !== priorText) && /^(your post (was|has been) sent|post sent|你的帖子已发送|您的帖子已发送|帖子已发送)[.!。！]?$/i.test(message)) return { ok: true, by: 'toast' };
      const navigated = !/^\/compose\/(post|tweet)\/?$/.test(location.pathname);
      const composerGone = !document.body.contains(scope) || !document.body.contains(box);
      if (navigated || composerGone) {
        if (++goneHits >= 2) return { ok: true, by: navigated ? 'navigation' : 'composer-closed' };
      } else {
        goneHits = 0;
      }
    }
    return { ok: false, uncertain: true, error: '发布结果未确认，可能已经发出。请先到 X 核实，切勿直接重试。' };
  }
  window.__xfaPublishOriginal = opts => run(opts).catch(() => ({ ok: false, uncertain: true, error: '发布过程意外中断，请先到 X 核实。' }));
})();
