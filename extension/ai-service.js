/* 云端草稿服务（仅 background 运行）。
 * 硅基流动密钥存会话；DeepSeek 密钥可保存在扩展本地存储。
 * 任何失败都回退本地模板，保证审核流程不中断。 */
(function (root) {
  const CONFIG_KEY = 'xfa-config-v1';
  const SECRET_KEY = 'xfa-secret-v1';

  const PROVIDERS = {
    siliconflow: {
      label: '硅基流动',
      baseUrl: 'https://api.siliconflow.cn/v1',
      defaultModel: 'Qwen/Qwen3-8B'
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash'
    }
  };

  const DEFAULT_CONFIG = {
    provider: 'siliconflow',
    model: '',
    minDelay: 15,
    maxDelay: 120,
    dailyLimit: 30,
    workStart: 9,
    workEnd: 23,
    focusTab: false,
    autoRun: false
  };

  function storageGet(store, key) {
    return new Promise(resolve => store.get(key, r => resolve(r[key])));
  }
  function storageSet(store, obj) {
    return new Promise((resolve, reject) =>
      store.set(obj, () => {
        const e = chrome.runtime.lastError;
        e ? reject(Error(e.message)) : resolve();
      }));
  }

  /* 每个服务商各自一套地址与模型：endpoints[provider] = { baseUrl, model }，
   * 空字符串表示“用该服务商的默认值”。旧版只有一组扁平 baseUrl/model，
   * 这里按“它属于当时选中的服务商”兼容读取，不会被另一家串用。 */
  function resolveEndpoint(saved, name) {
    const preset = PROVIDERS[name];
    const ep = ((saved && saved.endpoints) || {})[name] || {};
    const legacy = saved && !saved.endpoints && (saved.provider || 'siliconflow') === name ? saved : {};
    return {
      baseUrl: String(ep.baseUrl || legacy.baseUrl || '').trim(),
      model: String(ep.model || legacy.model || '').trim()
    };
  }

  async function getConfig() {
    const saved = await storageGet(chrome.storage.local, CONFIG_KEY);
    const cfg = { ...DEFAULT_CONFIG, ...(saved || {}) };
    if (!PROVIDERS[cfg.provider]) cfg.provider = 'siliconflow';
    cfg.endpoints = {};
    for (const name of Object.keys(PROVIDERS)) cfg.endpoints[name] = resolveEndpoint(saved, name);
    const preset = PROVIDERS[cfg.provider];
    const cur = cfg.endpoints[cfg.provider];
    cfg.model = cur.model || preset.defaultModel;
    cfg.baseUrl = cur.baseUrl || preset.baseUrl;
    return cfg;
  }

  async function saveConfig(patch) {
    const current = await getConfig();
    const endpoints = { ...current.endpoints, ...(patch.endpoints || {}) };
    const provider = patch.provider || current.provider;
    const preset = PROVIDERS[provider] || PROVIDERS.siliconflow;
    const cur = endpoints[provider] || {};
    const next = {
      ...current,
      ...patch,
      provider: PROVIDERS[provider] ? provider : 'siliconflow',
      endpoints,
      baseUrl: cur.baseUrl || preset.baseUrl,
      model: cur.model || preset.defaultModel
    };
    await storageSet(chrome.storage.local, { [CONFIG_KEY]: next });
    return next;
  }

  async function getSecrets() {
    const session = (await storageGet(chrome.storage.session, SECRET_KEY)) || {};
    const saved = (await storageGet(chrome.storage.local, 'xfa-deepseek-secret-v1')) || {};
    const savedSf = (await storageGet(chrome.storage.local, 'xfa-siliconflow-secret-v1')) || {};
    const siliconflowKey = savedSf.siliconflowKey || session.siliconflowKey;
    const deepseekKey = saved.deepseekKey || session.deepseekKey;
    return {
      ...session,
      siliconflowKey,
      deepseekKey,
      // 这把密钥最终是从哪儿取的：本地优先于会话，出错时要能说清楚
      sources: {
        siliconflowKey: savedSf.siliconflowKey ? 'local' : session.siliconflowKey ? 'session' : 'none',
        deepseekKey: saved.deepseekKey ? 'local' : session.deepseekKey ? 'session' : 'none'
      }
    };
  }

  async function saveSecrets(patch) {
    const current = (await storageGet(chrome.storage.session, SECRET_KEY)) || {};
    const { deepseekKey, siliconflowKey, ...sessionPatch } = patch;
    await storageSet(chrome.storage.session, { [SECRET_KEY]: { ...current, ...sessionPatch } });
    if (deepseekKey !== undefined) await storageSet(chrome.storage.local, { 'xfa-deepseek-secret-v1': { deepseekKey } });
    if (siliconflowKey !== undefined) await storageSet(chrome.storage.local, { 'xfa-siliconflow-secret-v1': { siliconflowKey } });
  }

  /* 账号本人的真实回复，用作风锚点：极短、口语、爱玩梗。
   * few-shot 比"要自然"这类形容词有效得多——模型会直接模仿句长和用词。 */
  const VOICE_SAMPLES = [
    '这野人魔了',
    '典',
    '乐',
    '?!区区!?',
    '神了',
    '但是，原神是一款。。。',
    '奶家人是无敌的'
  ];

  /* 每次随机挑一个"回应角度"，避免一批回复全收敛成同一个句型。
   * 同质化比单条 AI 味更容易被人看出来。 */
  const ANGLES = [
    '只对帖子里某一个具体细节或数字做反应，别面面俱到',
    '用一句反问接话，像在跟人斗嘴，而不是在点评',
    '说一句自己类似的感受，不编造具体事实',
    '轻微调侃或损一句，但只允许在原帖本身就在自嘲、玩梗或吐槽时用',
    '接住对方话里的梗，顺着玩下去',
    '先丢一个短判断词，再补半句理由'
  ];

  /* 判语种：与 auto-review.js 的 langOf 同口径（这里独立实现，避免模块加载顺序依赖） */
  function langOf(text) {
    const t = String(text || '');
    const kana = (t.match(/[\u3040-\u30FF]/g) || []).length;
    const han = (t.match(/[\u4E00-\u9FFF]/g) || []).length;
    const words = (t.match(/[A-Za-z][A-Za-z']*/g) || []).length;
    if (kana >= 2) return 'ja';
    if (han >= 3) return 'zh';
    if (words >= 3) return 'en';
    return '';
  }

  function buildMessages(post, original = false) {
    if (original) return [
      { role: 'system', content: 'Write one short, engaging original English post for X about games, anime, entertainment or social media. Encourage genuine conversation without inventing facts, hashtags, links, mentions, or begging for likes. Return only JSON: {"en":"the post"}.' },
      { role: 'user', content: 'Create one interesting original post.' }
    ];
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    const lang = langOf(`${post.text || ''} ${post.quoteText || ''}`);
    const langLine = lang === 'zh'
      ? 'Reply language: Chinese. The post is Chinese — write the reply in Chinese only, no English sentence.'
      : lang === 'ja'
        ? 'Reply language: Japanese. The post is Japanese — write the reply in Japanese only.'
        : lang === 'en'
          ? 'Reply language: English. The post is English — write the reply in English only, no Chinese or Japanese characters.'
          : 'Reply language: match the post exactly; if the post is mostly Chinese, reply in Chinese.';
    const system = [
      'You are a real person replying on X, in a hurry, half-serious. Write like you type: short, spoken, slightly unserious.',
      'This account really replies like these lines below (imitate their rhythm and length, do NOT copy the wording verbatim, and do not reuse one of them as your whole reply):',
      VOICE_SAMPLES.map(s => `- ${s}`).join('\n'),
      'These samples are Chinese, but they only set the RHYTHM. The language of your reply is decided by the post, not by the samples.',
      langLine,
      'STEP 0 — read what the poster is actually doing, then reply in the SAME direction:',
      '- sharing good news / a win → be glad with them. No caution, no "but", no downside, no contrarian take.',
      '- complaining or venting → agree, add your own complaint, or joke along. Do not lecture them.',
      '- asking something → answer it plainly, or ask them back.',
      '- dropping info / a link-less observation → react to the one detail that caught you.',
      '- joking / self-deprecating → you may tease back.',
      'If you cannot tell what they mean, say something short and clearly on their side. Being on their side beats being clever.',
      'Rules:',
      '1. React to ONE concrete thing in the post — a word, a detail, a number. Never summarize or paraphrase the post.',
      '2. One sentence, spoken register. Chinese/Japanese: 4-60 characters, and short is good (4-12 characters is often enough). English: 4-40 words. Never exceed the cap.',
      '3. Use the SAME language as the post: English, Chinese or Japanese only. A Chinese post never gets an English reply, and an English post never gets a Chinese one.',
      '4. Chinese may use internet slang sparingly (典 / 乐 / 神了 / 啊这 / 绷不住了) when the post invites it. English stays casual but plain.',
      '5. No closing summary, no wishes ("hope you...", "keep it up"), no three-part parallel lists, no em-dash chains, no openers like "确实" "不得不说" "总的来说" "值得一提的是".',
      '6. Never praise the post generically ("great post", "so true", "nice shot"). If it is not funny or interesting, just react drier.',
      '7. Never use hashtags, links, @mentions; never mention being AI or a model.',
      '8. If the post is a quote/retweet, react to the quoted thing.',
      '9. No balanced-contrast punchlines: no "A is easy, B is hard", no "not X but Y", no "looks X, actually Y". Symmetrical couplets read machine-made.',
      '10. Never twist the poster\'s own word into a negative reading. Fandom or industry slang ("进池", "流量池", "破圈", "上热门") means exactly what the poster means by it — do not literalize it or turn it into a warning.',
      '11. No warnings or advice unless they asked. This is banter between strangers, not a consultation.',
      `This time: ${angle}.`,
      'Return ONLY a JSON object: {"en":"your reply","kind":"one word tone label"}.'
    ].join('\n');
    const userContent = [
      `Author: @${post.handle}`,
      `Post type: ${post.type}`,
      `Post text: ${post.text || '(media-only post)'}`,
      post.quoteText ? `Quoted content: ${post.quoteText}` : ''
    ].filter(Boolean).join('\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: userContent }
    ];
  }

  function extractJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch {}
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return null;
  }

  /* 从错误响应体里挖上游的真实原因，避免只显示状态码。
   * 常见结构：{"error":{"message":"余额不足"}} / {"message":"坏在哪"} /
   * {"error":{"message":"{\"error\":{\"message\":\"坏在哪\"}}"}（把上游错误序列化成字符串）。
   * 挖不出来就退回原始文本。 */
  function upstreamReason(text) {
    const cap = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return '';
    let node;
    try { node = JSON.parse(text); } catch { return cap(text); }
    const pick = o => {
      if (!o || typeof o !== 'object') return '';
      if (typeof o.message === 'string' && o.message) return o.message;
      if (typeof o.error === 'string' && o.error) return o.error;
      if (o.error && typeof o.error === 'object') return pick(o.error);
      if (typeof o.detail === 'string' && o.detail) return o.detail;
      return '';
    };
    let msg = pick(node);
    if (msg) {
      try {
        const inner = pick(JSON.parse(msg));
        if (inner) msg = inner;
      } catch {}
    }
    return cap(msg);
  }

  async function callCloud(cfg, secrets, post, original = false, signal) {
    const preset = PROVIDERS[cfg.provider] || PROVIDERS.siliconflow;
    const key = cfg.provider === 'deepseek' ? secrets.deepseekKey : secrets.siliconflowKey;
    if (!key) throw Error('未配置该服务商的密钥，将使用模板兜底');
    const base = (cfg.baseUrl || preset.baseUrl).replace(/\/$/, '');
    const body = {
      model: cfg.model || preset.defaultModel,
      messages: buildMessages(post, original),
      temperature: 0.8,
      max_tokens: cfg.provider === 'deepseek' ? 256 : 120
    };
    if (cfg.provider === 'deepseek') {
      body.thinking = { type: 'disabled' };
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) {
      // 状态码不够用：余额不足、模型不存在、配额耗尽都藏在响应体里
      let detail = '';
      try { detail = upstreamReason(await res.text()); } catch {}
      const tail = detail ? `（${detail}）` : '';
      if (res.status === 401 || res.status === 403) {
        // 401 最常见的原因是“用的根本不是刚填的那把”：本地记住的旧密钥优先于会话，
        // 所以把实际使用的密钥尾号和来源一起报出来，便于核对是不是同一把
        const which = cfg.provider === 'deepseek' ? 'deepseekKey' : 'siliconflowKey';
        const src = (secrets.sources && secrets.sources[which]) || 'none';
        const where = src === 'local' ? '本地存储（勾选了“记住”）' : src === 'session' ? '当前会话' : '未知';
        throw Error(`云端密钥无效或无权限（所用密钥 …${String(key).slice(-4)}，来源：${where}）${tail}`);
      }
      if (res.status === 429) throw Error(`云端限流${tail}`);
      throw Error(`云端返回 ${res.status}${detail ? `：${detail}` : ''}`);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw Error('云端回复被截断，可重新生成');
    if (choice?.finish_reason && !['stop'].includes(choice.finish_reason)) throw Error(`云端未正常完成（${choice.finish_reason}）`);
    const content = choice?.message?.content || '';
    if (typeof content !== 'string' || !content.trim()) throw Error('云端返回空回复，可重新生成');
    const parsed = extractJson(content);
    const reply = [parsed?.en, parsed?.reply, parsed?.text].find(v => typeof v === 'string' && v.trim());
    if (!reply) throw Error('云端回复格式不符合要求，可重新生成');
    return {
      en: reply.trim().slice(0, 300),
      kind: String(parsed?.kind || '').slice(0, 30) || 'AI',
      source: `ai:${cfg.provider}`
    };
  }

  /* 为单条帖子生成草稿；云端失败自动回退模板。 */
  async function generateDraft(post) {
    const cfg = await getConfig();
    const secrets = await getSecrets();
    try {
      return await callCloud(cfg, secrets, post);
    } catch (e) {
      const tpl = FilterRules.templateDraft(post);
      return { en: tpl.en, kind: tpl.zh, source: 'template', fallbackReason: e.message };
    }
  }

  async function generateOriginal() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try { return await callCloud(await getConfig(), await getSecrets(), {}, true, controller.signal); }
    catch (error) { if (error.name === 'AbortError') throw Error('原创草稿请求超时，请重试'); throw error; }
    finally { clearTimeout(timer); }
  }

  const api = {
    PROVIDERS,
    DEFAULT_CONFIG,
    getConfig,
    saveConfig,
    getSecrets,
    saveSecrets,
    generateDraft,
    generateOriginal,
    // 仅为测试可读
    upstreamReason
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.AIService = api;
})(globalThis);
