/* 本地单元测试：node tests/run-tests.js */
const assert = require('assert');
const { Store } = require('../queue-store.js');
const { filterPosts, templateDraft } = require('../filter-rules.js');
const { compute } = require('../graph-logic.js');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const now = Date.now();
const iso = daysAgo => new Date(now - daysAgo * 86400000).toISOString();

console.log('filterPosts');

test('排除时间窗口外的帖子', () => {
  const posts = [
    { id: '1', url: 'u1', handle: 'a', type: '原创', date: iso(1), text: 'hi' },
    { id: '2', url: 'u2', handle: 'a', type: '原创', date: iso(30), text: 'old' }
  ];
  assert.strictEqual(filterPosts(posts, { days: 7 }).length, 1);
});

test('排除回复帖与非原创类型', () => {
  const posts = [
    { id: '1', url: 'u1', handle: 'a', type: '回复', date: iso(1), text: 'r' },
    { id: '2', url: 'u2', handle: 'a', type: '原创', date: iso(1), text: 'o' }
  ];
  assert.strictEqual(filterPosts(posts, { days: 7 })[0].id, '2');
});

test('按 includeQuotes 决定是否保留引用转发', () => {
  const posts = [{ id: '1', url: 'u', handle: 'a', type: '引用转发', date: iso(1), text: 'q' }];
  assert.strictEqual(filterPosts(posts, { days: 7, includeQuotes: true }).length, 1);
  assert.strictEqual(filterPosts(posts, { days: 7, includeQuotes: false }).length, 0);
});

test('每个好友只保留最新 maxPerUser 条', () => {
  const posts = [
    { id: '1', url: 'u1', handle: 'a', type: '原创', date: iso(1), text: 'new' },
    { id: '2', url: 'u2', handle: 'a', type: '原创', date: iso(3), text: 'old' },
    { id: '3', url: 'u3', handle: 'b', type: '原创', date: iso(2), text: 'b' }
  ];
  const r = filterPosts(posts, { days: 7, maxPerUser: 1 });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.find(x => x.handle === 'a').id, '1');
});

test('关键词白名单与黑名单生效', () => {
  const posts = [
    { id: '1', url: 'u1', handle: 'a', type: '原创', date: iso(1), text: 'game level boss' },
    { id: '2', url: 'u2', handle: 'b', type: '原创', date: iso(1), text: 'random thought' },
    { id: '3', url: 'u3', handle: 'c', type: '原创', date: iso(1), text: 'game but crypto scam' }
  ];
  const r = filterPosts(posts, { days: 7, keywords: ['game'], excludeKeywords: ['scam'] });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, '1');
});

test('缺失 id/url 的帖子被丢弃', () => {
  const posts = [{ id: '', url: 'u', handle: 'a', type: '原创', date: iso(1), text: 'x' }];
  assert.strictEqual(filterPosts(posts, { days: 7 }).length, 0);
});

console.log('templateDraft');

test('悲伤内容走温和语气', () => {
  const d = templateDraft({ text: 'Our dog passed away yesterday, hard day.' });
  assert.strictEqual(d.kind, '温和');
  assert.ok(d.en.includes('sorry'));
});

test('游戏内容走轻松语气', () => {
  const d = templateDraft({ text: 'Spent hours on this boss quest' });
  assert.strictEqual(d.kind, '游戏轻松');
});

test('无关内容走默认问候', () => {
  const d = templateDraft({ text: 'The weather is nice' });
  assert.strictEqual(d.kind, '轻松问候');
});

(async () => {
  console.log('GraphLogic.compute');

test('关系字段明确时直接采用，不依赖粉丝列表', () => {
  const r = compute([
    { handle: 'a', theyFollowMe: true },
    { handle: 'b', theyFollowMe: false }
  ], null);
  assert.strictEqual(r.counts.mutual, 1);
  assert.strictEqual(r.counts.notMutual, 1);
  assert.strictEqual(r.counts.unknown, 0);
  assert.strictEqual(r.mutual[0].handle, 'a');
});

test('关系字段缺失时用粉丝列表差集补齐', () => {
  const r = compute([
    { handle: 'a', theyFollowMe: null },
    { handle: 'b', theyFollowMe: null },
    { handle: 'C', theyFollowMe: null }
  ], [{ handle: 'a' }, { handle: 'c' }]);
  assert.strictEqual(r.counts.mutual, 2);
  assert.strictEqual(r.counts.notMutual, 1);
  assert.strictEqual(r.counts.unknown, 0);
  // 大小写不敏感
  assert.ok(r.mutual.some(x => x.handle === 'C'));
});

test('没有粉丝列表时未知项保持未知', () => {
  const r = compute([{ handle: 'a', theyFollowMe: null }], null);
  assert.strictEqual(r.counts.unknown, 1);
  assert.strictEqual(r.counts.mutual, 0);
});

test('明确未回关不会被粉丝列表翻转', () => {
  const r = compute([{ handle: 'a', theyFollowMe: false }], [{ handle: 'a' }]);
  assert.strictEqual(r.counts.notMutual, 1);
  assert.strictEqual(r.counts.mutual, 0);
});

test('空输入与脏数据不抛错', () => {
  assert.strictEqual(compute([], null).counts.all, 0);
  assert.strictEqual(compute(null, null).counts.all, 0);
  const r = compute([{ handle: '' }, null, { handle: 'ok', theyFollowMe: true }], null);
  assert.strictEqual(r.counts.all, 3);
  assert.strictEqual(r.counts.mutual, 1);
});

console.log('QueueStore');
  await Store.clearAll();

  await new Promise(r => {
    test('addPosts 入队并返回新增数量', () => {
      Store.addPosts([
        { id: 'p1', url: 'u1', handle: 'a', text: 't', date: iso(1), type: '原创' },
        { id: 'p2', url: 'u2', handle: 'b', text: 't', date: iso(1), type: '原创' }
      ]).then(n => { assert.strictEqual(n, 2); r(); });
    });
  });

  await new Promise(r => {
    test('重复 id 不重复入队', () => {
      Store.addPosts([
        { id: 'p1', url: 'u1', handle: 'a', text: 't', date: iso(1), type: '原创' },
        { id: 'p3', url: 'u3', handle: 'c', text: 't', date: iso(1), type: '原创' }
      ]).then(n => { assert.strictEqual(n, 1); r(); });
    });
  });

  await new Promise(r => {
    test('update 修改状态', () => {
      Store.update('p1', { status: 'approved', draft: 'hello' }).then(item => {
        assert.strictEqual(item.status, 'approved');
        r();
      });
    });
  });

  await new Promise(r => {
    test('archive 移出队列并记入历史', () => {
      Store.update('p2', { status: 'sent', sentAt: new Date().toISOString() })
        .then(() => Store.archive('p2'))
        .then(async () => {
          const q = await Store.loadQueue();
          const h = await Store.loadHistory();
          assert.ok(!q.some(x => x.id === 'p2'));
          assert.ok(h.includes('p2'));
          r();
        });
    });
  });

  await new Promise(r => {
    test('incrementDaily 与 todaySentCount 同步', () => {
      Store.incrementDaily()
        .then(n => { assert.strictEqual(n, 1); return Store.todaySentCount(); })
        .then(c => { assert.strictEqual(c, 1); r(); });
    });
  });

  await new Promise(r => {
    test('归档不影响当日计数', () => {
      Store.update('p3', { status: 'sent', sentAt: new Date().toISOString() })
        .then(() => Store.archive('p3'))
        .then(() => Store.todaySentCount())
        .then(c => { assert.strictEqual(c, 1); r(); });
    });
  });

  await new Promise(r => {
    test('已归档 id 不会再次入队', () => {
      Store.addPosts([{ id: 'p2', url: 'u2', handle: 'b', text: 't', date: iso(1), type: '原创' }])
        .then(n => { assert.strictEqual(n, 0); r(); });
    });
  });

  const atest = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  };

  await atest('claimForSend 仅在状态与草稿都一致时锁定', async () => {
    const claimed = await Store.claimForSend('p1', 'hello', '');
    assert.ok(claimed, '首次应锁定成功');
    assert.strictEqual(claimed.status, 'sending');
    const again = await Store.claimForSend('p1', 'hello', '');
    assert.strictEqual(again, null, '重复申领应失败');
  });

  await atest('sending 状态禁止非终态修改，允许落到终态', async () => {
    await assert.rejects(Store.update('p1', { status: 'ready' }), /正在发送/);
    const settled = await Store.update('p1', { status: 'failed', error: '测试' });
    assert.strictEqual(settled.status, 'failed');
  });

  await atest('editDraft 将已通过条目退回待审', async () => {
    await Store.addPosts([{ id: 'p9', url: 'u9', handle: 'd', text: 't', date: iso(1), type: '原创' }]);
    await Store.update('p9', { status: 'approved', draft: 'old' });
    const edited = await Store.editDraft('p9', 'new');
    assert.strictEqual(edited.draft, 'new');
    assert.strictEqual(edited.status, 'ready');
    assert.strictEqual(edited.draftSource, 'manual');
  });

  await atest('草稿在审核后被改动时拒绝发送', async () => {
    await Store.update('p9', { status: 'approved' });
    const claimed = await Store.claimForSend('p9', 'old-draft', 'manual');
    assert.strictEqual(claimed, null);
  });

  await atest('未审核通过的条目不能被申领发送', async () => {
    await Store.addPosts([{ id: 'p10', url: 'u10', handle: 'e', text: 't', date: iso(1), type: '原创' }]);
    const claimed = await Store.claimForSend('p10', '', '');
    assert.strictEqual(claimed, null);
  });

  await atest('当日好友账本记录已发好友且去重', async () => {
    await Store.addDailyHandle('Alice');
    await Store.addDailyHandle('alice');
    await Store.addDailyHandle('bob');
    const list = await Store.todayHandles();
    assert.deepStrictEqual(list.sort(), ['alice', 'bob']);
  });

  await atest('发送中的条目可以落到「已跳过」，并随归档进历史', async () => {
    await Store.addPosts([{ id: 'p11', url: 'u11', handle: 'f', text: 't', date: iso(1), type: '原创' }]);
    await Store.update('p11', { status: 'approved', draft: 'd' });
    await Store.claimForSend('p11', 'd', '');
    const done = await Store.update('p11', { status: 'skipped', error: '原帖已删除或不可用' });
    assert.strictEqual(done.status, 'skipped', '删帖要能从 sending 落到 skipped');
    await Store.archive('p11');
    const q = await Store.loadQueue();
    assert.ok(!q.some(x => x.id === 'p11'), '已跳过条目应移出队列');
    assert.ok((await Store.loadHistory()).includes('p11'), '已跳过条目应进历史，避免再次采集');
  });

  await atest('source 字段：时间线条目带 timeline，缺省回落 roster', async () => {
    await Store.addPosts([
      { id: 'p12', url: 'u12', handle: 'g', text: 't', date: iso(1), type: '原创', source: 'timeline' },
      { id: 'p13', url: 'u13', handle: 'h', text: 't', date: iso(1), type: '原创' }
    ]);
    const q = await Store.loadQueue();
    assert.strictEqual(q.find(x => x.id === 'p12').source, 'timeline');
    assert.strictEqual(q.find(x => x.id === 'p13').source, 'roster');
  });

  await new Promise(r => {
    test('clearAll 重置当日计数', () => {
      Store.clearAll()
        .then(() => Store.todaySentCount())
        .then(c => { assert.strictEqual(c, 0); r(); });
    });
  });

  await new Promise(r => {
    test('clearAll 重置当日好友账本', () => {
      Store.todayHandles()
        .then(list => { assert.deepStrictEqual(list, []); r(); });
    });
  });

  await Store.clearAll();
  console.log(`\n通过 ${pass} 项${process.exitCode ? '，存在失败' : ''}`);
})();
