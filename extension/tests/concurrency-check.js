/* 模拟多个扩展上下文和异步存储，不使用账号、网络或真实密钥。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const data = {};
let lockTail = Promise.resolve();
const navigator = { locks: { request(name, fn) {
  assert.strictEqual(name, 'xfa-queue-write-v1');
  const result = lockTail.then(fn);
  lockTail = result.catch(() => {});
  return result;
} } };
const chrome = {
  runtime: { id: 'test', lastError: null, sendMessage: async () => {}, onMessage: { addListener(fn) { this.fn = fn; } }, onStartup: { addListener() {} } },
  storage: { local: {
    get(key, cb) { const value = structuredClone(data[key]); setImmediate(() => cb({ [key]: value })); },
    set(patch, cb) { setImmediate(() => { Object.assign(data, structuredClone(patch)); cb?.(); }); }
  } },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {} }
};
function context() {
  const c = vm.createContext({ chrome, navigator, console, setTimeout, clearTimeout, importScripts() {} });
  vm.runInContext(source('queue-store.js'), c);
  return c;
}

async function main() {
  const roster = require('../roster.js');
  const csv = roster.csv([{ handle: 'Example' }], 'excluded');
  assert.strictEqual(roster.read(csv, 'excluded')[0].handle, 'Example');
  assert.throws(() => roster.read(csv, 'following'), /未回关名单/);
  const a = context(), b = context();
  await a.QueueStore.clearAll();
  await a.QueueStore.addPosts([{ id: '1', url: 'u', handle: 'a' }]);
  await Promise.all([
    a.QueueStore.update('1', { draft: 'edited', draftSource: 'manual' }),
    b.QueueStore.update('1', { status: 'approved' })
  ]);
  let item = (await a.QueueStore.loadQueue())[0];
  assert.strictEqual(item.draft, 'edited');
  assert.strictEqual(item.status, 'approved');
  await b.QueueStore.editDraft('1', 'changed after approval');
  item = (await a.QueueStore.loadQueue())[0];
  assert.strictEqual(item.status, 'ready');
  assert.strictEqual(item.draft, 'changed after approval');
  await a.QueueStore.update('1', { status: 'approved', draft: 'edited' });
  const claimed = await a.QueueStore.claimForSend('1', 'edited', 'manual');
  assert.strictEqual(claimed.status, 'sending');
  await assert.rejects(b.QueueStore.editDraft('1', 'late change'), /正在发送/);
  // 非终态不许从 sending 退回；skipped 是终态（删帖跳过要用），见 run-tests 的队列用例
  await assert.rejects(b.QueueStore.update('1', { status: 'ready' }), /正在发送/);
  await a.QueueStore.update('1', { status: 'failed' });
  await b.QueueStore.editDraft('1', 'editable again');
  await a.QueueStore.update('1', { status: 'approved', draft: 'edited' });
  assert.strictEqual(await a.QueueStore.claimForSend('1', 'outdated', 'manual'), null);

  await a.QueueStore.addPosts([{ id: '2', url: 'u2', handle: 'b' }, { id: '3', url: 'u3', handle: 'c' }]);
  await a.QueueStore.update('2', { status: 'ready', draft: 'previous', draftSource: 'manual' });
  let calls = 0, release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  a.AIService = {
    getConfig: async () => ({ provider: 'deepseek' }),
    getSecrets: async () => ({ deepseekKey: 'fake' }),
    generateDraft: async post => {
      calls++;
      if (post.id === '2') { entered(); await new Promise(resolve => { release = resolve; }); }
      return { en: 'new-' + post.id, kind: 'test', source: 'ai:deepseek' };
    }
  };
  vm.runInContext(source('auto-review.js'), a);
  a.OriginalStore = { recover: async () => {}, claimDue: async () => null, get: async () => ({ task: null, nextDueAt: 0 }) };
  vm.runInContext(source('background.js'), a);
  const send = (regenerate) => new Promise(resolve => chrome.runtime.onMessage.fn({ type: 'xfa-generate-drafts', regenerate }, { id: 'test' }, resolve));
  const pending = send(true);
  await enteredPromise;
  await b.QueueStore.update('2', { status: 'approved', draft: 'user-approved' });
  release();
  const result = await pending;
  const q = await a.QueueStore.loadQueue();
  assert.strictEqual(q.find(x => x.id === '1').draft, 'edited');
  assert.strictEqual(q.find(x => x.id === '2').draft, 'user-approved');
  assert.strictEqual(q.find(x => x.id === '2').status, 'approved');
  assert.strictEqual(q.find(x => x.id === '3').draft, 'new-3');
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.generated, 1);

  const noLocks = vm.createContext({ chrome, console });
  vm.runInContext(source('queue-store.js'), noLocks);
  await assert.rejects(noLocks.QueueStore.update('1', { draft: 'unsafe' }), /队列锁/);
  console.log('PASS: cross-context updates, edit after approval, regeneration races, approved draft protection, unavailable-lock failure');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
