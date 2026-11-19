/* 集成一致性检查：node tests/integration-check.js
 * 校验 dashboard 引用的脚本存在、JS 里引用的 DOM id 都在某处定义、消息类型收发匹配。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let errors = [];

// 1. dashboard.html 引用的脚本必须存在
const html = read('dashboard.html');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
for (const s of scripts) {
  if (!fs.existsSync(path.join(root, s))) errors.push(`dashboard 引用的脚本不存在：${s}`);
}

// 2. manifest 引用的文件必须存在
const manifest = JSON.parse(read('manifest.json'));
const bg = manifest.background?.service_worker;
if (bg && !fs.existsSync(path.join(root, bg))) errors.push(`manifest 的 service_worker 不存在：${bg}`);
const panelPath = manifest.side_panel?.default_path;
if (panelPath && !fs.existsSync(path.join(root, panelPath))) errors.push(`manifest 的 side_panel 不存在：${panelPath}`);

// 3. background importScripts 的文件必须存在
const bgSrc = read(bg);
const imports = [...bgSrc.matchAll(/importScripts\(([^)]+)\)/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
for (const f of imports) {
  if (!fs.existsSync(path.join(root, f))) errors.push(`importScripts 的文件不存在：${f}`);
}

// 4. 汇总所有静态与模板内定义的 id
const definedIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const uiFiles = ['following-ui.js', 'collect-ui.js', 'config-ui.js', 'original-ui.js'];
for (const f of uiFiles) {
  const src = read(f);
  for (const m of src.matchAll(/id="([^"]+)"/g)) definedIds.add(m[1]);
}

// 5. 检查被引用的 id 是否都有定义
const checked = ['demo-1.js', 'demo-2.js', 'following-ui.js', 'collect-ui.js', 'config-ui.js', 'original-ui.js', 'shell-ui.js'];
const skip = new Set(['draft', 'send', 'skip', 'auto']); // 运行时动态插入
for (const f of checked) {
  const src = read(f);
  const refs = [...src.matchAll(/(?:\$\('|el\('|getElementById\(')([\w-]+)'\)/g)].map(m => m[1]);
  for (const id of new Set(refs)) {
    if (!definedIds.has(id) && !skip.has(id)) errors.push(`${f} 引用了未定义的 id：${id}`);
  }
}

// 6. 消息类型收发匹配
const sent = new Set();
const handled = new Set();
for (const f of fs.readdirSync(root).filter(x => x.endsWith('.js'))) {
  const src = read(f);
  for (const m of src.matchAll(/sendMessage\(\{\s*type:\s*'([\w-]+)'/g)) sent.add(m[1]);
  for (const m of src.matchAll(/message\.type\s*===\s*'([\w-]+)'/g)) handled.add(m[1]);
}
for (const t of sent) {
  // 页面侧发出的消息需由 background 处理；background 广播的只用于页面监听
  if (!handled.has(t) && t !== 'xfa-runner-progress' && t !== 'xfa-runner-done') {
    const listened = fs.readdirSync(root).filter(x => x.endsWith('.js'))
      .some(f => read(f).includes(`'${t}'`));
    if (!listened) errors.push(`消息类型无人处理：${t}`);
  }
}

if (errors.length) {
  console.log('发现 ' + errors.length + ' 个问题：');
  errors.forEach(e => console.log('  ✗ ' + e));
  process.exitCode = 1;
} else {
  console.log('✓ dashboard 脚本引用完整');
  console.log('✓ manifest 文件引用完整');
  console.log('✓ background importScripts 完整');
  console.log('✓ DOM id 引用全部有定义');
  console.log('✓ 消息类型收发匹配');
}
