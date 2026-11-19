const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const makeUser = i => ({ entryId: `user-${i}`, content: { itemContent: { user_results: { result: { __typename: 'User', rest_id: String(i), core: { screen_name: `user${i}` } } } } } });
const page = (start, instructions = []) => ({ data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: Array.from({ length: 50 }, (_, i) => makeUser(start + i)).concat([{ entryId: 'cursor-bottom-1', content: { cursorType: 'Bottom', value: start === 1 ? 'next-page' : '' } }]) }, ...instructions] } } } } } });
async function main() {
  let calls = 0;
  class XHR { open() {} }
  const location = { pathname: '/owner/following', origin: 'https://x.com' };
  const window = { fetch: async input => {
    calls++;
    if (calls === 2) assert.strictEqual(JSON.parse(new URL(input.url).searchParams.get('variables')).cursor, 'next-page');
    const data = calls === 1 ? page(1, [{ type: 'TimelineTerminateTimeline', direction: 'Top' }]) : page(51);
    return { ok: true, status: 200, clone: () => ({ json: async () => data }), json: async () => data };
  }, scrollTo() {}, scrollBy() {} };
  const ctx = vm.createContext({ window, location, XMLHttpRequest: XHR, URL, Request, Date, Map, WeakMap, innerHeight: 800, scrollY: 0, document: { documentElement: { scrollHeight: 1000 } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'graph-reader.js'), 'utf8'), ctx);
  await window.fetch('https://x.com/i/api/graphql/hash/Following?variables=%7B%22userId%22%3A%221%22%7D');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(window.__xfaGraphReader01.snapshot().counts.all, 50);
  assert.strictEqual(window.__xfaGraphReader01.snapshot().bottom, false);
  assert.strictEqual((await window.__xfaGraphReader01.fastNext()).available, true);
  const snapshot = window.__xfaGraphReader01.snapshot();
  assert.strictEqual(snapshot.counts.all, 100);
  assert.strictEqual(snapshot.bottom, true);
  window.__xfaGraphReader01.stop();
  console.log('PASS: top termination ignored, fast pagination reads second page, bottom detected');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
