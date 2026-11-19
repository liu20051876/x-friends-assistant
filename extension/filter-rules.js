/* 目标帖筛选规则（纯函数）与本地模板草稿兜底。无副作用，可在 Node 单测。 */
(function (root) {
  const DEFAULTS = {
    days: 7,              // 只取最近 N 天的帖子
    includeQuotes: true,  // 引用转发是否纳入
    maxPerUser: 1,        // 每个好友最多保留几条（取最新）
    keywords: [],         // 白名单关键词（为空则不限制）
    excludeKeywords: []   // 黑名单关键词
  };

  function normalizeOptions(options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    o.days = Number(o.days) > 0 ? Number(o.days) : 7;
    o.maxPerUser = Number(o.maxPerUser) > 0 ? Number(o.maxPerUser) : 1;
    o.keywords = Array.isArray(o.keywords) ? o.keywords : [];
    o.excludeKeywords = Array.isArray(o.excludeKeywords) ? o.excludeKeywords : [];
    return o;
  }

  function withinDays(post, days) {
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t <= days * 86400000;
  }

  function matchKeywords(text, words) {
    if (!words.length) return true;
    const lower = String(text).toLowerCase();
    return words.some(w => w && lower.includes(String(w).toLowerCase()));
  }

  /* 阿拉伯文字帖过滤：X 上阿语/波斯语/乌尔都语共用一套字母表，发布量很大，
   * 既看不懂也接不上话。判据是「阿语系字母占全部字母的一半以上」，
   * 中文或英文帖里夹带一两个词不会误伤，纯数字/emoji 帖也不会被误判。 */
  function isArabicText(text) {
    const t = String(text || '');
    const letters = t.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const arabic = letters.filter(ch => /\p{Script=Arabic}/u.test(ch)).length;
    if (!arabic) return false;
    return arabic >= 3 && arabic / letters.length >= 0.5;
  }

  /* 判这条帖子该不该因为语种被丢：看它自己的正文；正文为空（纯图/纯引用）才看引用内容。 */
  function isArabicPost(post) {
    const own = String((post && post.text) || '');
    if (own.trim()) return isArabicText(own);
    return isArabicText((post && post.quoteText) || '');
  }

  /* 输入 readXPage 返回的 posts 数组，输出筛选后的目标帖。 */
  function filterPosts(posts, options) {
    const o = normalizeOptions(options);
    if (!Array.isArray(posts)) return [];

    const usedPerUser = new Map();
    const result = [];
    const sorted = [...posts].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

    for (const post of sorted) {
      if (!post || !post.id || !post.url) continue;
      if (!withinDays(post, o.days)) continue;
      if (post.type !== '原创' && !(o.includeQuotes && post.type === '引用转发')) continue;
      if (isArabicPost(post)) continue;   // 阿拉伯文帖一律不采

      const combined = `${post.text || ''} ${post.quoteText || ''}`;
      if (!matchKeywords(combined, o.keywords)) continue;
      if (o.excludeKeywords.length && matchKeywords(combined, o.excludeKeywords)) continue;

      const key = String(post.handle || '').toLowerCase();
      const used = usedPerUser.get(key) || 0;
      if (used >= o.maxPerUser) continue;
      usedPerUser.set(key, used + 1);
      result.push(post);
    }
    return result;
  }

  /* 本地模板草稿：云端调用失败时的兜底，逻辑与 0.4 版 makeDraft 一致。 */
  function templateDraft(post) {
    const t = `${post.text || ''} ${post.quoteText || ''}`.toLowerCase();
    if (/\b(dog|cat|pet|passed away|goodbye|grief|loss|hospital|sick|diagnos|funeral|died|death)\b|去世|离开了|生病|医院|告别|难过|逝世/.test(t))
      return { kind: '温和', en: 'So sorry you’re going through this. Sending you lots of warmth ❤️', zh: '很遗憾你正在经历这些，给你送上温暖与陪伴。' };
    if (/\b(game|gaming|played|level|boss|quest|character)\b|玩家|游戏|副本|通关|角色/.test(t))
      return { kind: '游戏轻松', en: 'The side quest somehow became the main quest 😂', zh: '支线任务不知不觉就变成主线任务了 😂' };
    if (/\b(anime|manga|episode|season|waifu|isekai)\b|动画|动漫|漫画|番剧|下一集/.test(t))
      return { kind: '动漫轻松', en: '“Just one more episode” has defeated us all 😂', zh: '“再看一集”打败过我们所有人 😂' };
    if (/\b(growth|creator|algorithm|followers|engagement|social media|content)\b|创作者|涨粉|算法|运营|流量/.test(t))
      return { kind: '社媒交流', en: 'The best growth hack is still being a real person 😄', zh: '最好的增长技巧，依然是真诚地像个人一样交流 😄' };
    if (/\b(movie|film|show|music|concert|celebrity)\b|电影|音乐|演唱会|综艺/.test(t))
      return { kind: '娱乐轻松', en: 'The hardest part is picking what to watch 😅', zh: '最难的部分果然还是决定看什么 😅' };
    return { kind: '轻松问候', en: 'Just stopping by to say hey 👋', zh: '日常刷到，顺手来打个招呼 👋' };
  }

  const api = { filterPosts, templateDraft, normalizeOptions, isArabicText, isArabicPost, DEFAULTS };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FilterRules = api;
})(globalThis);
