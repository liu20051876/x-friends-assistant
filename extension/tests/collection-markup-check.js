/* Validate that collection controls are outside the select elements. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'collect-ui.js'), 'utf8');
const markup = source.match(/panel\.innerHTML = `([\s\S]*?)`;/)[1];
let select = null;
const buttons = new Set();
for (const match of markup.matchAll(/<\/?(?:select|button)\b[^>]*>/gi)) {
  const tag = match[0];
  if (/^<select\b/i.test(tag)) { assert.strictEqual(select, null, 'nested select'); select = tag; }
  else if (/^<\/select/i.test(tag)) { assert.notStrictEqual(select, null, 'unexpected select close'); select = null; }
  else if (/^<button\b/i.test(tag)) {
    assert.strictEqual(select, null, 'button must not be inside a select');
    const id = tag.match(/id="([^"]+)"/);
    if (id) buttons.add(id[1]);
  }
}
assert.strictEqual(select, null, 'unclosed select');
for (const id of ['col-start', 'col-stop', 'col-reset']) assert(buttons.has(id), `missing ${id}`);
console.log('PASS: collection selects are closed and all controls are outside them');
