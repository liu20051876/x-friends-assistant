/* 使用模拟响应测试，不连接云端或读取真实密钥。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {
  let provider = 'deepseek', response, request;
  const chrome = { runtime: { lastError: null }, storage: {
    local: { get(key, cb) { cb({ [key]: key === 'xfa-config-v1' ? { provider } : { deepseekKey: 'fake' } }); } },
    session: { get(key, cb) { cb({ [key]: { siliconflowKey: 'fake' } }); } }
  } };
  const ctx = vm.createContext({ chrome, console, FilterRules: { templateDraft: () => ({ en: 'template', zh: '模板' }) },
    fetch: async (url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => response }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ai-service.js'), 'utf8'), ctx);
  const post = { handle: 'friend', text: 'hello' };
  response = { choices: [{ finish_reason: 'stop', message: { content: '{"en":"Hello!","kind":"warm"}' } }] };
  let result = await ctx.AIService.generateDraft(post);
  assert.strictEqual(result.en, 'Hello!');
  assert.strictEqual(request.thinking.type, 'disabled');
  assert.strictEqual(request.response_format.type, 'json_object');
  assert.strictEqual(request.max_tokens, 256);
  response = { choices: [{ finish_reason: 'length', message: { content: '{"en":"unfinished' } }] };
  result = await ctx.AIService.generateDraft(post);
  assert.match(result.fallbackReason, /截断/);
  response = { choices: [{ finish_reason: 'stop', message: { content: '   ' } }] };
  result = await ctx.AIService.generateDraft(post);
  assert.match(result.fallbackReason, /空回复/);
  response = { choices: [{ finish_reason: 'stop', message: { content: '{"en": {"bad":true}}' } }] };
  result = await ctx.AIService.generateDraft(post);
  assert.match(result.fallbackReason, /格式/);
  provider = 'siliconflow';
  response = { choices: [{ finish_reason: 'stop', message: { content: '```json\n{"en":"Hi!"}\n```' } }] };
  result = await ctx.AIService.generateDraft(post);
  assert.strictEqual(result.en, 'Hi!');
  assert.strictEqual(request.max_tokens, 120);
  assert.strictEqual(request.thinking, undefined);
  /* 语境保护条款必须真的进了 system prompt，否则「报喜被回成泼冷水」会复发 */
  const sys = request.messages[0].content;
  assert.match(sys, /STEP 0/, 'intent reading step present');
  assert.match(sys, /SAME direction/, 'same-direction rule present');
  assert.match(sys, /No warnings or advice/, 'no-warning rule present');
  assert.match(sys, /balanced-contrast/, 'contrast punchline ban present');
  assert.match(sys, /Never twist the poster/, 'slang non-literalization guard present');
  console.log('PASS: DeepSeek request and JSON, truncation, empty/invalid responses, SiliconFlow compatibility');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
