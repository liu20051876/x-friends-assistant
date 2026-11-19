/* 单条失败不中断整批：原帖已删判「已跳过」并归档，其他失败留在队列继续跑，
 * 连续 5 条失败才自动暂停。全部在 mock 环境里跑，不碰真实浏览器。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function simulate(outcome, initialRunner = { running: true, nextAt: 0 }, tabUrl = null) {
  const memory = { 'xfa-runner-v1': { ...initialRunner } };
  const updates = [];
  const archives = [];
  const alarms = [];
  const item = { id: '123', handle: 'friend', url: 'https://x.com/friend/status/123', draft: 'hello', draftSource: 'manual', status: 'approved' };

  const chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      sendMessage: async () => {},
      onMessage: { addListener() {} },
      onStartup: { addListener() {} }
    },
    storage: {
      local: {
        get(key, cb) {
          const v = typeof key === 'string' ? { [key]: memory[key] } : { ...key };
          if (cb) { cb(v); return; }
          return Promise.resolve(v);
        },
        set(obj, cb) {
          Object.assign(memory, obj);
          if (cb) { cb(); return; }
          return Promise.resolve();
        },
        remove(key, cb) {
          delete memory[key];
          if (cb) { cb(); return; }
          return Promise.resolve();
        }
      }
    },
    alarms: {
      create(name) { alarms.push(name); },
      clear() {},
      onAlarm: { addListener() {} }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    permissions: { contains: async () => true },
    tabs: {
      create: async () => ({ id: 5 }),
      get: async () => ({ status: 'complete', url: tabUrl || item.url }),
      update: async () => {},
      remove: async () => {}
    },
    scripting: {
      executeScript: async details => details.files ? [] : [{ result: outcome }]
    }
  };

  const QueueStore = {
    todaySentCount: async () => 0,
    list: async () => [item],
    claimForSend: async () => item,
    update: async (id, patch) => { updates.push({ id, ...patch }); },
    incrementDaily: async () => {},
    addDailyHandle: async () => {},
    archive: async id => { archives.push(id); }
  };
  const SilentStore = {
    recover: async () => {},
    claimDue: async () => null,
    get: async () => ({ task: null, nextDueAt: 0 }),
    setEnabled: async () => {},
    retry: async () => false,
    publish: async () => ({})
  };
  class Clock extends Date { getHours() { return 12; } }

  const ctx = vm.createContext({
    chrome, QueueStore, OriginalStore: SilentStore, console,
    AIService: { getConfig: async () => ({ workStart: 0, workEnd: 24, dailyLimit: 30, minDelay: 15, maxDelay: 15 }) },
    Date: Clock,
    importScripts() {},
    setTimeout(fn, ms) { if (ms < 5000) setImmediate(fn); return 1; },
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), ctx);
  await vm.runInContext('runOne()', ctx);
  return { updates, archives, alarms: alarms.filter(n => n === 'xfa-send'), runner: memory['xfa-runner-v1'] };
}

async function main() {
  // 原帖已删：跳过这一条、归档、整批继续
  const gone = await simulate({ ok: false, gone: true, error: '原帖已删除或不可用（/friend/status/123）' });
  assert.strictEqual(gone.updates.length, 1);
  assert.strictEqual(gone.updates[0].status, 'skipped', '删帖必须记为已跳过');
  assert.match(gone.updates[0].error, /已删除/);
  assert.deepStrictEqual(gone.archives, ['123'], '已跳过的帖子要归档，避免重复采集');
  assert.strictEqual(gone.runner.running, true, '删帖不能打断整批');
  assert.strictEqual(gone.alarms.length, 1, '失败后要继续排下一条');
  assert.strictEqual(gone.runner.failStreak, 1);

  // 其他失败：留在队列标失败，仍然继续下一条
  const failed = await simulate({ ok: false, error: '回复提交按钮不可用或未找到，未发出' });
  assert.strictEqual(failed.updates[0].status, 'failed');
  assert.deepStrictEqual(failed.archives, [], '普通失败不归档，留给用户重试');
  assert.strictEqual(failed.runner.running, true);
  assert.strictEqual(failed.alarms.length, 1);

  // 结果待核实：保持 uncertain（留队列待人工核实），也不能打断整批
  const unsure = await simulate({ ok: false, uncertain: true, error: '发送结果未确认' });
  assert.strictEqual(unsure.updates[0].status, 'uncertain');
  assert.deepStrictEqual(unsure.archives, []);
  assert.strictEqual(unsure.runner.running, true);
  assert.strictEqual(unsure.alarms.length, 1);

  // 连续失败到第 5 条：暂停并给出原因
  const streak = await simulate({ ok: false, gone: true, error: '原帖已删除或不可用' }, { running: true, nextAt: 0, failStreak: 4 });
  assert.strictEqual(streak.updates[0].status, 'skipped');
  assert.strictEqual(streak.runner.running, false, '连续 5 条失败必须暂停');
  assert.match(streak.runner.lastError, /连续 5 条失败/);
  assert.strictEqual(streak.alarms.length, 0, '暂停后不能再排下一条');

  // 成功一条即清零连续失败计数
  const ok = await simulate({ ok: true, liked: true }, { running: true, nextAt: 0, failStreak: 3 });
  assert.strictEqual(ok.updates[0].status, 'sent');
  assert.strictEqual(ok.runner.failStreak, 0, '成功后连续失败计数要归零');
  assert.strictEqual(ok.runner.running, true);
  assert.strictEqual(ok.alarms.length, 1);

  // 地址被重定向到个人主页（连 status id 都没有了）：判删帖，跳过并归档，不能空等超时
  const redirected = await simulate({}, { running: true, nextAt: 0 }, 'https://x.com/friend');
  assert.strictEqual(redirected.updates[0].status, 'skipped', '重定向到非帖子页应判删帖');
  assert.deepStrictEqual(redirected.archives, ['123']);
  assert.strictEqual(redirected.runner.running, true);

  // 地址换到了同一 status id 的另一条路径（如作者改名）：不算删帖，按普通失败继续
  const sameId = await simulate({}, { running: true, nextAt: 0 }, 'https://x.com/other/status/123');
  assert.strictEqual(sameId.updates[0].status, 'failed', 'status id 仍在就不能当删帖');
  assert.deepStrictEqual(sameId.archives, []);
  assert.strictEqual(sameId.runner.running, true);

  console.log('PASS: gone post skipped and archived, other failures continue, 5-failure streak pauses');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
