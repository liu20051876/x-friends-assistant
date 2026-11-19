const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function main() {
  const data = {};
  let chain = Promise.resolve();
  const navigator = { locks: { request(name, fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; } } };
  const chrome = { runtime: { lastError: null }, storage: { local: {
    get(key, cb) { setImmediate(() => cb({ [key]: structuredClone(data[key]) })); },
    set(value, cb) { setImmediate(() => { Object.assign(data, structuredClone(value)); cb(); }); }
  } } };
  const make = () => { const c = vm.createContext({ chrome, navigator, console, Date, Math }); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'original-store.js'), 'utf8'), c); return c.OriginalStore; };
  const a = make(), b = make();

  // 1. 新状态：默认启用、180–480 分钟，到期时间落在区间内
  const state = await a.get();
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.min, 180);
  assert.strictEqual(state.max, 480);
  assert.strictEqual(state.task, null);
  const mins = (state.nextDueAt - Date.now()) / 60000;
  assert(mins >= 180 && mins <= 480, `due in ${mins} min`);

  // 2. 未到点不申领；到点后两个上下文并发只有一个能拿到
  assert.strictEqual(await a.claimDue(), null);
  data['xfa-original-drafts-v1'].nextDueAt = Date.now() - 1000;
  const [one, two] = await Promise.all([a.claimDue(), b.claimDue()]);
  assert.strictEqual([one, two].filter(Boolean).length, 1);
  const task = one || two;
  assert.strictEqual(task.status, 'generating');

  // 3. 完成：草稿入库、任务清空、下一轮到期时间重新随机
  assert.strictEqual(await a.complete(task.id, 'A fun original post.'), true);
  let current = await b.get();
  assert.strictEqual(current.drafts.length, 1);
  assert.strictEqual(current.task, null);
  const again = (current.nextDueAt - Date.now()) / 60000;
  assert(again >= 180 && again <= 480);
  // 重复完成被拒
  assert.strictEqual(await a.complete(task.id, 'duplicate'), false);

  // 4. 失败 → 重试 → pending 任务被 claimDue 推进
  data['xfa-original-drafts-v1'].nextDueAt = Date.now() - 1000;
  const t2 = await a.claimDue();
  await a.fail(t2.id, 'temporary failure');
  assert.strictEqual((await b.get()).task.status, 'failed');
  assert.strictEqual(await b.retry(), true);
  const retried = await a.claimDue();
  assert.strictEqual(retried.id, t2.id);
  assert.strictEqual(retried.status, 'generating');

  // 5. recover：生成中断 → interrupted；重试推进后完成，再验证发布中断 → uncertain
  await b.recover();
  assert.strictEqual((await a.get()).task.status, 'interrupted');
  await b.retry();
  const t3 = await a.claimDue();
  assert.strictEqual(t3.id, t2.id);
  assert.strictEqual(t3.status, 'generating');
  await a.complete(t2.id, 'A fun original post.');
  await a.claimPublish(t2.id, 'A fun original post.');
  await b.recover();
  assert.strictEqual((await a.get()).drafts[0].publishStatus, 'uncertain');

  // 6. 编辑、发布申领、发布完成、核实
  await assert.rejects(a.edit(t2.id, 'cannot edit'), /不能编辑/);
  await a.resolvePublish(t2.id, false);
  assert.strictEqual(await a.claimPublish(t2.id, 'A fun original post.'), true);
  const claims = await Promise.all([a.claimPublish(t2.id, 'A fun original post.'), b.claimPublish(t2.id, 'A fun original post.')]);
  // 已处于 publishing 的草稿，并发申领全部被拒
  assert.strictEqual(claims.filter(Boolean).length, 0);
  await a.edit(t2.id, 'Edited original post.').catch(() => {});
  assert.strictEqual(await a.finishPublish(t2.id, 'published'), true);
  assert.strictEqual(await a.claimPublish(t2.id, 'Edited original post.'), false);

  // 7. 旧版（按条计数）状态迁移：草稿与待核实保留，计数废弃，nextDueAt 从现在起算
  data['xfa-original-drafts-v1'] = {
    min: 8, max: 15, count: 4, threshold: 10, seen: ['1', '2'],
    enabled: false,
    task: { id: 'old', status: 'failed' },
    drafts: [{ id: 'kept', text: 'old draft' }],
    uncertain: [{ id: '9', handle: 'friend' }]
  };
  const migrated = await a.get();
  assert.strictEqual(migrated.task, null);
  assert.strictEqual(migrated.enabled, false);
  assert.strictEqual(migrated.min, 180);
  assert.strictEqual(migrated.drafts.length, 1);
  assert.strictEqual(migrated.uncertain.length, 1);
  assert(typeof migrated.nextDueAt === 'number' && migrated.nextDueAt > Date.now());
  assert.strictEqual(migrated.count, undefined);
  assert.strictEqual(migrated.seen, undefined);

  // 8. configure 校验
  await assert.rejects(a.configure(0, 10), /间隔/);
  await assert.rejects(a.configure(500, 100), /间隔/);
  await a.configure(60, 120);
  assert.deepStrictEqual([(await b.get()).min, (await b.get()).max], [60, 120]);

  // 9. 删除（迁移后留下的 'kept' 草稿）
  await b.remove('kept');
  assert.strictEqual((await a.get()).drafts.length, 0);

  // 10. 暂停：setEnabled(false) 后即使到点也不申领；恢复后正常
  await a.setEnabled(false);
  assert.strictEqual((await b.get()).enabled, false);
  data['xfa-original-drafts-v1'].nextDueAt = Date.now() - 1000;
  assert.strictEqual(await a.claimDue(), null);
  await a.setEnabled(true);
  const resumed = await a.claimDue();
  assert.strictEqual(resumed.status, 'generating');

  console.log('PASS: time-based due, concurrent claim, failure, recovery, migration, edit and delete');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
