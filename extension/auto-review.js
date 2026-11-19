/* 自动过审校验器（纯逻辑，无 chrome 依赖，便于单测）。
 *
 * 设计原则：只有"怎么看都不像出错"的草稿才自动过审；任何一条不满足就落回
 * 待审队列，让人看一眼。宁可多留一条人工审，也不要把可疑内容直接发出去。
 *
 * 允许语言：英文 / 中文 / 日文。出现其他文字系统（俄文、韩文、阿拉伯文等）
 * 一律拦下——那通常是模型跑偏或混入了乱七八糟的东西。
 */
(function (root) {
  const MIN_CHARS = 12;       // 原创帖下限：成句才发得出去
  const MIN_REPLY_CHARS = 4;  // 回复帖下限：允许"典""乐""神了"这种真人反应
  const SHORT_CHARS = 10;     // 不超过这个字符数算"超短回复"，一批要限额
  const MAX_SHORT_PER_BATCH = 5;
  const MAX_CHARS = 240;
  const MIN_LATIN_WORDS = 4;
  const MAX_LATIN_WORDS = 45;
  const MAX_OVERLAP = 0.55;

  const RE_URL = /(https?:\/\/|www\.[a-z0-9]|t\.co\/|\b[a-z0-9-]+\.(com|net|org|io|xyz|link|me)\b)/i;
  const RE_MENTION = /@[A-Za-z0-9_]{1,}/;
  const RE_TAG = /#\w/;
  const RE_AI_SMELL = /\b(as an ai|i am an ai|i'm an ai|language model|chatgpt|openai)\b/i;

  const ALLOWED_PUNCT = /[.,!?;:'"()\[\]{}<>/\\&*%$+=~|^_\-—–…·•、。，！？；：（）「」『』【】《》“”‘’]/;
  const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}\uFE0F\u200D\u2190-\u21FF]/u;
  const HAN = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
  const KANA = /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D]/;
  const LATIN = /[A-Za-z]/;
  const DIGIT = /[0-9]/;
  const SPACE = /[\s\u3000]/;

  function isAllowedChar(ch) {
    return LATIN.test(ch) || DIGIT.test(ch) || SPACE.test(ch) || HAN.test(ch) || KANA.test(ch)
      || ALLOWED_PUNCT.test(ch) || EMOJI.test(ch);
  }

  /* 归一化：去掉标点、空白、大小写差异，只留"内容"用来查重复与相似度 */
  function norm(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\s\u3000]/g, '')
      .replace(/[^\p{Letter}\p{Number}]/gu, '');
  }

  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  /* 与原文重合度（bigram Jaccard）。用来拦"把原帖换个说法抄回去"的草稿。 */
  function overlap(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const x of A) if (B.has(x)) hit++;
    return hit / (A.size + B.size - hit);
  }

  function countLatinWords(text) {
    return (text.match(/[A-Za-z][A-Za-z']*/g) || []).length;
  }
  function countCjk(text) {
    return (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  }

  /* 判原帖语种（够长才判，短帖/纯表情不判，避免误伤） */
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

  /**
   * opts: { post, draft, seenDrafts?:Set<string>, handleToday?:Set<string> }
   * draft: { en, kind, source }   —— source 为 'template' 的一律不自动过审
   * 返回 { ok:true } | { ok:false, reason }
   */
  function check(opts) {
    const post = opts.post || {};
    const draft = opts.draft || {};
    const text = String(draft.en || '').trim();

    // 模板兜底出来的话术质量不可控，必须人工看一眼
    if (!String(draft.source || '').startsWith('ai:')) return { ok: false, reason: '模板兜底生成，需人工确认' };
    if (!text) return { ok: false, reason: '草稿为空' };

    const chars = [...text].length;
    if (chars < MIN_REPLY_CHARS) return { ok: false, reason: '过短' };
    if (chars > MAX_CHARS) return { ok: false, reason: '过长' };

    const bad = [...text].filter(ch => !isAllowedChar(ch));
    if (bad.length) return { ok: false, reason: `含不支持的字符「${bad[0]}」` };

    if (RE_URL.test(text)) return { ok: false, reason: '含链接' };
    if (RE_MENTION.test(text)) return { ok: false, reason: '含 @ 提及' };
    if (RE_TAG.test(text)) return { ok: false, reason: '含话题标签' };
    if (RE_AI_SMELL.test(text)) return { ok: false, reason: '含 AI 自述或品牌词' };

    const cjk = countCjk(text);
    const words = countLatinWords(text);
    if (cjk === 0 && words < MIN_LATIN_WORDS) return { ok: false, reason: '英文词数过少' };
    if (words > MAX_LATIN_WORDS) return { ok: false, reason: '英文词数过多' };
    if (cjk === 0 && !/[.!?]$/.test(text)) return { ok: false, reason: '英文草稿未以句末标点结束' };

    // 语种必须跟原帖一致：中文帖回英文是最容易被一眼看穿的破绽
    const postLang = langOf(`${post.text || ''} ${post.quoteText || ''}`);
    if (postLang === 'zh' && cjk === 0) return { ok: false, reason: '原帖是中文，草稿却不是中文' };
    if (postLang === 'ja' && !/[\u3040-\u30FF]/.test(text)) return { ok: false, reason: '原帖是日文，草稿却没日文假名' };
    if (postLang === 'en' && cjk > 0) return { ok: false, reason: '原帖是英文，草稿却混入中日文' };

    // 与原文太像：等于在人家帖子下面复述人家的话。
    // 极短回复（"典""神了"）本来就没几个 bigram，拿它比重合度只会误杀，只做完全相同判定。
    const orig = norm(`${post.text || ''} ${post.quoteText || ''}`);
    const self = norm(text);
    if (orig && self) {
      if (self === orig) return { ok: false, reason: '与原帖完全相同' };
      if (self.length >= 8) {
        if (orig.length >= 10 && (self.includes(orig) || orig.includes(self))) return { ok: false, reason: '基本上是原帖的复述' };
        if (overlap(self, orig) > MAX_OVERLAP) return { ok: false, reason: '与原帖重合度过高' };
      }
    }

    // 同一批里已经出现过一模一样的草稿（模型偷懒复用）
    if (opts.seenDrafts && opts.seenDrafts.has(self)) return { ok: false, reason: '与其他草稿重复' };

    // 同一人重复：名单来源受「当天一条」限制；时间线来源不受当天限制
    //（时间线本来就可能扫到当天已经访问过的好友），但同一批内仍不允许同一人两条。
    const handle = String(post.handle || '').toLowerCase();
    if (handle) {
      const fromTimeline = String(post.source || 'roster') === 'timeline';
      if (fromTimeline) {
        if (opts.handleBatch && opts.handleBatch.has(handle)) return { ok: false, reason: '该账号本批已有一条' };
      } else if (opts.handleToday && opts.handleToday.has(handle)) {
        return { ok: false, reason: '该好友今天已有一条' };
      }
    }

    return { ok: true };
  }

  /* 原创帖硬规则：原创帖要求英文，比回复草稿更严（不允许中日文），
   * 但不做与原帖重合度检查（它没有对应原帖）。 */
  function checkOriginalDraft(input) {
    const text = String(input || '').trim();
    if (!text) return { ok: false, reason: '原创草稿为空' };
    const chars = [...text].length;
    if (chars < MIN_CHARS) return { ok: false, reason: '过短' };
    if (chars > 280) return { ok: false, reason: '超过 280 字符' };
    const bad = [...text].filter(ch => !isAllowedChar(ch));
    if (bad.length) return { ok: false, reason: `含不支持的字符「${bad[0]}」` };
    if (countCjk(text) > 0) return { ok: false, reason: '原创帖要求英文，含中日文字' };
    if (RE_URL.test(text)) return { ok: false, reason: '含链接' };
    if (RE_MENTION.test(text)) return { ok: false, reason: '含 @ 提及' };
    if (RE_TAG.test(text)) return { ok: false, reason: '含话题标签' };
    if (RE_AI_SMELL.test(text)) return { ok: false, reason: '含 AI 自述或品牌词' };
    if (countLatinWords(text) < MIN_LATIN_WORDS) return { ok: false, reason: '英文词数过少' };
    return { ok: true };
  }

  /* 超短回复（"典""乐""神了"）本身更像真人，但一批里堆多了就像刷屏。
   * background 用它做本批限额。 */
  function isShortReply(text) {
    return [...String(text || '').trim()].length <= SHORT_CHARS;
  }

  const api = { check, checkOriginalDraft, norm, overlap, countLatinWords, countCjk, langOf, isShortReply, MIN_CHARS, MIN_REPLY_CHARS, SHORT_CHARS, MAX_SHORT_PER_BATCH, MAX_CHARS };
  if (typeof module !== 'undefined') module.exports = api;
  else root.AutoReview = api;
})(globalThis);
