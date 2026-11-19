/* 假页面验证名单账号大小写；不打开浏览器，不读取真实名单。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function main() {
  const elements = {};
  const el = id => elements[id] ||= { value: '', textContent: '', disabled: false };
  el('col-batch').value = '10'; el('col-days').value = '7';
  const roster = { owner: 'Owner_Name', confirmed: true, following: [{ handle: 'Friend' }], excluded: [] };
  const values = { 'x-friends-roster-v1': JSON.stringify(roster) };
  let pageOwner = 'owner_name', added = 0;
  const ctx = vm.createContext({
    console,
    document: {
      createElement: () => ({}),
      querySelector: () => ({ insertBefore() {} }),
      querySelectorAll: () => [],
      addEventListener() {},
      getElementById: el
    },
    window: { addEventListener() {} },
    localStorage: { getItem: key => values[key], setItem: (key, value) => { values[key] = value; } },
    setTimeout: fn => fn(),
    setInterval: () => 0,
    chrome: {
      permissions: { contains: async () => true },
      tabs: { create: async () => ({ id: 1 }), get: async () => ({ status: 'complete' }), remove: async () => {} },
      scripting: { executeScript: async () => [{ result: { owner: pageOwner, posts: [{ id: '1' }], skipped: [] } }] },
      runtime: { sendMessage: async () => ({ message: 'done', autoApproved: 1, needReview: 0 }), onMessage: { addListener() {} } }
    },
    QueueStore: { loadQueue: async () => [], todaySentCount: async () => 0, addPosts: async () => { added++; return 1; } },
    Roster: { match: list => list }, FilterRules: { filterPosts: list => list, isArabicPost: () => false }, readXPage() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'collect-ui.js'), 'utf8'), ctx);
  await el('col-start').onclick();
  assert.strictEqual(added, 1, 'same handle with different case should be accepted');
  pageOwner = 'different_owner';
  await el('col-start').onclick();
  assert.strictEqual(added, 1, 'different owner must be rejected');
  assert.match(el('col-status').textContent, /不一致/);

  // 本批好友数改成自由填写：非法值拦住，合法值记住，超出名单人数时按名单人数推进
  el('col-batch').value = '0';
  await el('col-start').onclick();
  assert.match(el('col-status').textContent, /本批好友数请填/);
  el('col-batch').value = '45';
  el('col-batch').onchange();
  assert.strictEqual(values['xfa-collect-batch-v1'], '45', '填过的数字应被记住');
  pageOwner = 'owner_name';
  const before = added;
  await el('col-start').onclick();
  assert.strictEqual(added, before + 1, '超出名单人数时按名单人数推进，不重复读取同一个人');
  assert.match(el('col-status').textContent, /采集完成/, '超大本批数不应报错');

  console.log('PASS: case-insensitive owner check, rejection of different accounts, free-form batch size');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
