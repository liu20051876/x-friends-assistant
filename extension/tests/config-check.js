/* Tests use a fake key and in-memory storage; no network or user data.
 * 覆盖 A 方案：默认只写会话，勾选“记住”后才落盘，取消勾选即清除本地。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

async function main() {
  const elements = {};
  const get = id => elements[id] ||= { value: '', textContent: '', checked: false };
  const values = { 'cf-provider': 'deepseek', 'cf-min': '15', 'cf-max': '120', 'cf-limit': '30', 'cf-start': '9', 'cf-end': '23' };
  const localData = { 'xfa-config-v1': { provider: 'deepseek', baseUrl: 'https://api.siliconflow.cn/v1' } };
  const sessionData = {};
  let failSecretWrite = false;
  const chrome = { runtime: { lastError: null, sendMessage: async () => ({}) }, storage: {} };
  function store(data) {
    return {
      get(key, cb) { cb({ [key]: structuredClone(data[key]) }); },
      set(patch, cb) {
        if (Object.hasOwn(patch, 'xfa-deepseek-secret-v1') && failSecretWrite) chrome.runtime.lastError = { message: 'simulated storage error' };
        else Object.assign(data, structuredClone(patch));
        cb();
        chrome.runtime.lastError = null;
      }
    };
  }
  chrome.storage.local = store(localData);
  chrome.storage.session = store(sessionData);
  const document = {
    createElement() { return { className: '', innerHTML: '' }; },
    querySelector() { return { insertBefore() {} }; },
    getElementById: get
  };
  for (const [key, value] of Object.entries(values)) get(key).value = value;
  const context = vm.createContext({ document, chrome, console, localStorage: {}, window: {}, confirm: () => true, CustomEvent: function() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'config-ui.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));

  // 1. 默认不勾选：密钥只进会话，不落盘
  assert.strictEqual(get('cf-remember-ds').checked, false);
  get('cf-ds-key').value = 'session-key';
  await get('cf-save').onclick();
  assert.strictEqual(sessionData['xfa-secret-v1'].deepseekKey, 'session-key');
  assert.strictEqual(localData['xfa-deepseek-secret-v1'].deepseekKey, undefined);
  assert.strictEqual(get('cf-ds-key').value, '');
  assert.match(get('cf-key-state').textContent, /DeepSeek仅当前会话已保存/);

  // 2. 勾选“记住”并保存：写入本地
  get('cf-remember-ds').checked = true;
  get('cf-ds-key').value = 'fake-key';
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-deepseek-secret-v1'].deepseekKey, 'fake-key');
  assert.strictEqual(localData['xfa-config-v1'].baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(get('cf-ds-key').value, '');
  assert.match(get('cf-key-state').textContent, /DeepSeek已保存到本地/);

  // 3. 再次保存且不重输：保留已记住的本地密钥，不被旧会话密钥覆盖
  sessionData['xfa-secret-v1'] = { deepseekKey: 'stale-session-key' };
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-deepseek-secret-v1'].deepseekKey, 'fake-key');

  // 4. 写盘失败时不静默成功
  failSecretWrite = true;
  get('cf-ds-key').value = 'new-fake-key';
  await get('cf-save').onclick();
  assert.strictEqual(get('cf-ds-key').value, 'new-fake-key');
  assert.match(get('cf-status').textContent, /保存失败/);
  failSecretWrite = false;

  // 5. 取消勾选并保存：清除本地落盘
  get('cf-remember-ds').checked = false;
  get('cf-ds-key').value = '';
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-deepseek-secret-v1'].deepseekKey, undefined);
  assert.match(get('cf-key-state').textContent, /DeepSeek仅当前会话已保存/);

  // 6. 读取优先级：本地存在时优先本地
  const service = vm.createContext({ chrome, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ai-service.js'), 'utf8'), service);
  localData['xfa-deepseek-secret-v1'] = { deepseekKey: 'fake-key' };
  sessionData['xfa-secret-v1'] = { deepseekKey: 'old-session-key' };
  assert.strictEqual((await service.AIService.getSecrets()).deepseekKey, 'fake-key');
  // 7. 清除按钮把两处都清掉
  await get('cf-clear-ds').onclick();
  assert.strictEqual((await service.AIService.getSecrets()).deepseekKey, undefined);
  assert.match(get('cf-key-state').textContent, /DeepSeek未保存/);

  // 8. 没有本地密钥时回退会话密钥
  sessionData['xfa-secret-v1'] = { deepseekKey: 'session-only' };
  assert.strictEqual((await service.AIService.getSecrets()).deepseekKey, 'session-only');

  // 9. 硅基流动密钥走同一套开关：勾选“记住”才落盘
  assert.strictEqual(get('cf-remember-sf').checked, false);
  get('cf-remember-sf').checked = true;
  get('cf-sf-key').value = 'sf-fake-key';
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-siliconflow-secret-v1'].siliconflowKey, 'sf-fake-key');
  assert.strictEqual(get('cf-sf-key').value, '');
  assert.match(get('cf-key-state').textContent, /硅基流动已保存到本地/);
  assert.match(get('cf-key-state').textContent, /…-key/, '状态行要露尾号，便于核对用的是哪把');

  // 10. 硅基流动也本地优先于会话
  sessionData['xfa-secret-v1'] = { siliconflowKey: 'sf-session-old' };
  assert.strictEqual((await service.AIService.getSecrets()).siliconflowKey, 'sf-fake-key');

  // 11. 取消勾选：清除本地落盘，回退会话
  get('cf-remember-sf').checked = false;
  get('cf-sf-key').value = '';
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-siliconflow-secret-v1'].siliconflowKey, undefined);
  assert.match(get('cf-key-state').textContent, /硅基流动仅当前会话已保存/);

  // 12. 不勾选时重新输入：只进会话，不落盘
  get('cf-sf-key').value = 'sf-session-new';
  await get('cf-save').onclick();
  assert.strictEqual(sessionData['xfa-secret-v1'].siliconflowKey, 'sf-session-new');
  assert.strictEqual(localData['xfa-siliconflow-secret-v1'].siliconflowKey, undefined);

  // 13. 清除硅基流动密钥：会话与本地都清
  await get('cf-clear-sf').onclick();
  assert.strictEqual((await service.AIService.getSecrets()).siliconflowKey, undefined);
  assert.match(get('cf-key-state').textContent, /硅基流动未保存/);

  // 14. 两家的 API 地址与模型分开保存：改一家不影响另一家
  get('cf-provider').value = 'siliconflow';
  get('cf-provider').onchange();
  get('cf-base').value = 'https://proxy.example.com/v1';
  get('cf-model').value = 'custom-model';
  await get('cf-save').onclick();
  const saved = localData['xfa-config-v1'];
  assert.strictEqual(saved.endpoints.siliconflow.baseUrl, 'https://proxy.example.com/v1');
  assert.strictEqual(saved.endpoints.siliconflow.model, 'custom-model');
  assert.strictEqual(saved.endpoints.deepseek.baseUrl, '');
  assert.strictEqual(saved.baseUrl, 'https://proxy.example.com/v1');

  // 15. 切换到另一家：输入框回填它自己那一套（不是上一家残留），保存也不串
  get('cf-provider').value = 'deepseek';
  get('cf-provider').onchange();
  assert.strictEqual(get('cf-base').value, '', 'deepseek 不该带出 siliconflow 的自定义地址');
  assert.match(get('cf-base').placeholder, /api\.deepseek\.com/);
  get('cf-model').value = 'ds-custom';
  await get('cf-save').onclick();
  assert.strictEqual(localData['xfa-config-v1'].endpoints.deepseek.model, 'ds-custom');
  assert.strictEqual(localData['xfa-config-v1'].endpoints.siliconflow.baseUrl, 'https://proxy.example.com/v1');
  assert.strictEqual(localData['xfa-config-v1'].baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(localData['xfa-config-v1'].model, 'ds-custom');

  // 16. 后台按当前服务商取自己那一套，绝不串用另一家的地址
  let runtime = await service.AIService.getConfig();
  assert.strictEqual(runtime.baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(runtime.model, 'ds-custom');
  localData['xfa-config-v1'] = { ...localData['xfa-config-v1'], provider: 'siliconflow' };
  runtime = await service.AIService.getConfig();
  assert.strictEqual(runtime.baseUrl, 'https://proxy.example.com/v1');
  assert.strictEqual(runtime.model, 'custom-model');

  // 17. 旧版扁平配置（只有一组 baseUrl/model）仍能读，且只归当时选中的那一家
  localData['xfa-config-v1'] = { provider: 'deepseek', baseUrl: 'https://legacy.example.com', model: 'legacy-model' };
  runtime = await service.AIService.getConfig();
  assert.strictEqual(runtime.baseUrl, 'https://legacy.example.com');
  assert.strictEqual(runtime.endpoints.siliconflow.baseUrl, '');
  assert.strictEqual(runtime.endpoints.siliconflow.model, '');
  assert.strictEqual(runtime.endpoints.deepseek.model, 'legacy-model');

  // 18. 401 报错要带出“实际用的密钥尾号 + 来自哪里”，否则查不出是不是用了旧的本地密钥
  localData['xfa-siliconflow-secret-v1'] = { siliconflowKey: 'sk-test-xyz9' };
  localData['xfa-config-v1'] = { ...localData['xfa-config-v1'], provider: 'siliconflow' };
  const ctx401 = vm.createContext({
    chrome, console,
    FilterRules: { templateDraft: () => ({ en: 'tpl' }) },
    fetch: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Authentication Fails, Your api key: ****xyz9 is invalid"}}' })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ai-service.js'), 'utf8'), ctx401);
  const denied = await ctx401.AIService.generateDraft({ handle: 'friend', text: 'hello' });
  assert.match(denied.fallbackReason, /…xyz9/, 'must show the key tail actually used');
  assert.match(denied.fallbackReason, /本地存储/, 'must say the key came from local storage');

  console.log('PASS: session-only default, opt-in persistence, no overwrite, storage failure, clear, per-provider endpoints');}
main().catch(error => { console.error(error); process.exitCode = 1; });
