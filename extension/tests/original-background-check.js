const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function simulate(verifiedBy) {
  let sent = 0;
  const memory = { 'xfa-runner-v1': { running: true, nextAt: 0 } };
  const item = { id: '123', handle: 'friend', url: 'https://x.com/friend/status/123', draft: 'hello', draftSource: 'manual', status: 'approved' };
  const chrome = {
    runtime: { id: 'test', sendMessage: async () => {}, onMessage: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: { get(key, cb) { const v = { [key]: memory[key] }; if (cb) cb(v); else return Promise.resolve(v); }, set(v, cb) { Object.assign(memory, v); if (cb) cb(); else return Promise.resolve(); }, remove: async () => {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } }, sidePanel: { setPanelBehavior: async () => {} },
    permissions: { contains: async () => true },
    tabs: { create: async () => ({ id: 5 }), get: async () => ({ status: 'complete', url: item.url }), remove: async () => {} },
    scripting: { executeScript: async details => details.files ? [] : [{ result: { ok: true, liked: false, verifiedBy } }] }
  };
  // 时间间隔版：runOne 不允许再调用任何计数 API
  const forbidden = name => () => { throw Error(`OriginalStore.${name} must not be called in time-based mode`); };
  const OriginalStore = {
    recover: async () => {},
    claimDue: async () => null,
    get: async () => ({ task: null, nextDueAt: 0 }),
    record: forbidden('record'),
    noteUncertain: forbidden('noteUncertain')
  };
  const QueueStore = { todaySentCount: async () => 0, list: async () => [item], claimForSend: async () => item,
    update: async (_, patch) => { if (patch.status === 'sent') sent++; }, incrementDaily: async () => {}, addDailyHandle: async () => {}, archive: async () => {} };
  class Clock extends Date { getHours() { return 12; } }
  const ctx = vm.createContext({ chrome, OriginalStore, QueueStore, AIService: { getConfig: async () => ({ workStart: 0, workEnd: 24, dailyLimit: 30, minDelay: 15, maxDelay: 15 }) }, Date: Clock, console,
    importScripts() {}, setTimeout(fn, ms) { if (ms < 5000) setImmediate(fn); return 1; }, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), ctx);
  await vm.runInContext('runOne()', ctx);
  return { sent };
}
async function main() {
  // 无论成功提示来自 toast 还是 composer-closed，都只标记发送，不再触发计数
  assert.strictEqual((await simulate('toast')).sent, 1);
  assert.strictEqual((await simulate('composer-closed')).sent, 1);
  console.log('PASS: reply flow decoupled from original trigger, no count APIs called');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
