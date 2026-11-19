/* 云端错误透出：非 2xx 时 fallbackReason 必须带上游真实原因。全部模拟，不联网。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function main() {
  const localData = { 'xfa-config-v1': { provider: 'deepseek' } };
  const sessionData = { 'xfa-secret-v1': { deepseekKey: 'fake-key' } };
  const chrome = { runtime: { lastError: null }, storage: {} };
  function store(data) {
    return {
      get(key, cb) { cb({ [key]: structuredClone(data[key]) }); },
      set(patch, cb) { Object.assign(data, structuredClone(patch)); cb(); }
    };
  }
  chrome.storage.local = store(localData);
  chrome.storage.session = store(sessionData);

  let status = 200;
  let bodyText = '';
  const fetchMock = async () => (status === 200
    ? { ok: true, status, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"en":"ok","kind":"light"}' } }] }) }
    : { ok: false, status, text: async () => bodyText });

  const context = vm.createContext({ chrome, console, fetch: fetchMock });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'filter-rules.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ai-service.js'), 'utf8'), context);
  const AIService = context.AIService;
  const post = { handle: 'friend', type: 'post', text: 'hello' };

  // 1. 正常路径不回归
  let result = await AIService.generateDraft(post);
  assert.strictEqual(result.source, 'ai:deepseek');

  // 2. 400：网关把上游错误序列化成字符串的套娃结构，要剥到最里层
  status = 400;
  bodyText = JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'insufficient balance' } })
    }
  });
  result = await AIService.generateDraft(post);
  assert.strictEqual(result.source, 'template');
  assert.match(result.fallbackReason, /insufficient balance/);
  assert.doesNotMatch(result.fallbackReason, /^云端返回 400$/);

  // 3. 401：响应体不是 JSON 时退回原始文本，不能抛解析错误
  status = 401;
  bodyText = 'plain text denial';
  result = await AIService.generateDraft(post);
  assert.match(result.fallbackReason, /密钥无效|无权限/);
  assert.match(result.fallbackReason, /plain text denial/);

  // 4. 429 单独识别
  status = 429;
  bodyText = JSON.stringify({ error: { message: 'rate limit exceeded' } });
  result = await AIService.generateDraft(post);
  assert.match(result.fallbackReason, /限流/);
  assert.match(result.fallbackReason, /rate limit exceeded/);

  // 5. 空响应体不能崩
  status = 500;
  bodyText = '';
  result = await AIService.generateDraft(post);
  assert.match(result.fallbackReason, /云端返回 500/);

  console.log('PASS: upstream error reason, 401 plain text, 429, empty body');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
