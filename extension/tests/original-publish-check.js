const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
// Node 无浏览器事件构造器，给最小桩（发布器只用到构造与字段读取）
class EventStub { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
class DataTransferStub { constructor() { this._d = {}; } setData(k, v) { this._d[k] = v; } getData(k) { return this._d[k]; } }
class ClipboardEventStub extends EventStub { constructor(type, init) { super(type, init); this.clipboardData = init.clipboardData; } }
class InputEventStub extends EventStub {}
async function simulate({
  actual = 'owner', toastText = 'Your post was sent.', typed = true,
  composerStays = false, injectFails = false
} = {}) {
  let clicked = 0, toast = null;
  const visible = { getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const button = { ...visible, getAttribute: () => null, click() { clicked++; if (toastText) toast = { ...visible, innerText: toastText }; } };
  const scope = { querySelectorAll: () => [button] };
  const box = {
    ...visible, innerText: '', textContent: '',
    getAttribute: () => 'true', closest: () => scope,
    focus() {},
    dispatchEvent() {}
  };
  const document = {
    body: { contains: node => composerStays && (node === scope || node === box) },
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    querySelector(s) { if (s.includes('Profile_Link')) return { href: `https://x.com/${actual}` }; if (s.includes('toast')) return toast; return null; },
    querySelectorAll(s) { return s.includes('tweetTextarea') ? [box] : []; },
    execCommand(name, unused, text) {
      if (name === 'insertText' && typed && !injectFails) box.innerText = text;
    }
  };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  const ctx = vm.createContext({
    window, document,
    location: { hostname: 'x.com', pathname: '/compose/post' },
    URL, DataTransfer: DataTransferStub, ClipboardEvent: ClipboardEventStub,
    InputEvent: InputEventStub, Event: EventStub,
    setTimeout: fn => fn()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'original-publish-page.js'), 'utf8'), ctx);
  const result = await ctx.window.__xfaPublishOriginal({ owner: 'owner', text: 'A fun original post.' });
  return { clicked, result };
}
async function main() {
  const wrong = await simulate({ actual: 'other' });
  assert.strictEqual(wrong.clicked, 0);

  // 成功 toast
  const success = await simulate();
  assert.strictEqual(success.clicked, 1);
  assert.strictEqual(success.result.ok, true);
  assert.strictEqual(success.result.by, 'toast');

  // 无 toast、编辑器消失 → composer-closed
  const closed = await simulate({ toastText: '' });
  assert.strictEqual(closed.clicked, 1);
  assert.strictEqual(closed.result.by, 'composer-closed');

  // 无 toast、编辑器还在 → uncertain
  const uncertain = await simulate({ toastText: '', composerStays: true });
  assert.strictEqual(uncertain.result.uncertain, true);

  // execCommand 失效：dom 注入兜底，仍能发布
  const domFallback = await simulate({ injectFails: true });
  assert.strictEqual(domFallback.clicked, 1);
  assert.strictEqual(domFallback.result.ok, true);

  console.log('PASS: multi injection, account validation, toast/closed success, uncertain and dom fallback');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
