const assert = require('assert');
const { Store } = require('../follow-store.js');

async function main() {
  // 1. 默认值
  const fresh = await Store.get();
  assert.deepStrictEqual(fresh.keywords, ['新人蓝V', '交友', '浇友']);
  assert.strictEqual(fresh.dailyLimit, 50);

  // 2. 关键词：去重、去空、拒绝全空
  const kw = await Store.setKeywords(['交友', '交友', ' 浇友 ', '', '新人蓝V']);
  assert.strictEqual(kw.keywords.length, 3);
  await assert.rejects(Store.setKeywords(['  ']), /至少保留一个/);

  // 3. 上限校验
  await assert.rejects(Store.setDailyLimit(0), /上限/);
  await assert.rejects(Store.setDailyLimit(500), /上限/);
  await Store.setDailyLimit(20);
  assert.strictEqual((await Store.get()).dailyLimit, 20);

  // 4. 候选入库：去重、非法 handle 过滤
  const added = await Store.addCandidates([
    { handle: '@Alice', name: 'Alice', tweetUrl: 'u1', keyword: '交友', badge: 'blue' },
    { handle: 'bob', name: 'Bob', tweetUrl: 'u2', keyword: '交友', badge: 'blue' },
    { handle: 'bad handle', badge: 'blue' },
    { handle: 'alice', name: 'dup', badge: 'blue' }
  ]);
  assert.strictEqual(added, 2);

  // 5. 批准 → 申领 → 完成，当日计数递增
  assert.strictEqual(await Store.todayFollowCount(), 0);
  await Store.approve('alice', true);
  assert.strictEqual((await Store.get()).candidates.find(c => c.handle === 'alice').status, 'approved');
  const claimed = await Store.claimForFollow('alice');
  assert.strictEqual(claimed.status, 'following');
  assert.strictEqual(await Store.claimForFollow('alice'), null);
  await Store.finishFollow('alice', 'followed');
  assert.strictEqual(await Store.todayFollowCount(), 1);

  // 6. 失败与 uncertain 核实
  await Store.approve('bob', true);
  await Store.claimForFollow('bob');
  await Store.finishFollow('bob', 'failed', 'click failed');
  assert.strictEqual((await Store.get()).candidates.find(c => c.handle === 'bob').status, 'failed');
  // 重新批准走一遍，模拟 uncertain → 人工核实未关注
  await Store.approve('bob', true);
  await Store.claimForFollow('bob');
  await Store.finishFollow('bob', 'uncertain', 'state unknown');
  assert.strictEqual(await Store.resolveFollow('bob', false), true);
  assert.strictEqual((await Store.get()).candidates.find(c => c.handle === 'bob').status, 'failed');

  // 7. 崩溃恢复：following 且无错误 → 待核实
  await Store.approve('bob', true);
  await Store.claimForFollow('bob');
  const n = await Store.recover();
  assert.strictEqual(n, 1);
  assert.ok((await Store.get()).candidates.find(c => c.handle === 'bob').error);

  // 8. 一键批准与清理
  await Store.approveAllNew();
  const archived = await Store.archiveFollowed();
  assert.strictEqual(archived, 1); // alice 已关注被清理
  const remaining = (await Store.get()).candidates;
  assert.ok(!remaining.some(c => c.handle === 'alice'));

  // 9. 移除
  await Store.remove('bob');
  assert.strictEqual((await Store.get()).candidates.length, 0);

  console.log('PASS: keywords, limit, candidates, approval, follow lifecycle, recovery and archive');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
