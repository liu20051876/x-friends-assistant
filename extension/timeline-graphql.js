/* 时间线接口（X 自己的 GraphQL HomeTimeline 响应）解析，纯函数、可 Node 单测。
 * 和 DOM 采集相比，这里拿到的字段是原始数据：正文、作者、浏览数、能否回复、
 * 语言标签、是否广告、游标都在，不依赖虚拟列表有没有渲染出来。 */
(function (root) {
  /* 阿语系语言码：X 自己的 lang 字段比按字形猜准得多，两种判据一起用 */
  const ARABIC_LANGS = ['ar', 'fa', 'ur', 'ps', 'sd', 'ckb', 'ug'];
  const ARABIC_CH = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

  function textOf(node, key) {
    return node && node[key] != null ? node[key] : '';
  }

  /* 计数可能是数字，也可能是 "1,234" / "3.6K" / "1.2M" */
  function parseCount(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[,\s]/g, '');
    const m = /^([\d.]+)\s*([KMB万亿]?)$/i.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = m[2];
    const mul = unit === 'K' || unit === 'k' || unit === '千' ? 1e3
      : unit === 'M' || unit === 'm' ? 1e6
        : unit === 'B' || unit === 'b' ? 1e9
          : unit === '万' ? 1e4
            : unit === '亿' ? 1e8
              : 1;
    return Math.round(n * mul);
  }

  function isoDate(s) {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  }

  /* TweetWithVisibilityResults 是包了一层的外壳，真正的 tweet 在 .tweet */
  function unwrap(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
    if (result.tweet && result.tweet.rest_id && !result.rest_id) return result.tweet;
    return result;
  }

  /* 用户信息两代 schema 都见过：core.user_results.result.core 或 .legacy */
  function userOf(result) {
    const ur = result && (result.core && result.core.user_results && result.core.user_results.result);
    if (!ur) return { handle: '', name: '' };
    const inner = ur.core || ur.legacy || {};
    return {
      handle: String(inner.screen_name || '').toLowerCase(),
      name: inner.name || ''
    };
  }

  function isArabicText(text) {
    const t = String(text || '');
    const letters = t.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const arabic = letters.filter(ch => /\p{Script=Arabic}/u.test(ch)).length;
    return !!arabic && arabic >= 3 && arabic / letters.length >= 0.5;
  }

  function tweetFromEntry(entry) {
    const content = (entry && entry.content) || {};
    const item = content.itemContent;
    if (!item || !item.tweet_results) return null;
    const raw = unwrap(item.tweet_results.result);
    if (!raw || !raw.rest_id) return null;
    const legacy = raw.legacy || {};
    const user = userOf(raw);
    const noteText = raw.note_tweet && raw.note_tweet.note_tweet_results
      && raw.note_tweet.note_tweet_results.result
      && raw.note_tweet.note_tweet_results.result.text;
    const text = String(noteText || legacy.full_text || '');
    // 广告：显式 promotedMetadata，或 entryId 以 promoted 开头
    const promoted = !!(content.promotedMetadata || item.promotedMetadata
      || /^promoted[-_]/i.test(String(entry.entryId || '')));
    const viewsRaw = raw.views && raw.views.count != null ? raw.views.count : null;
    const lang = String(legacy.lang || '').toLowerCase();
    const arabic = ARABIC_LANGS.includes(lang) || isArabicText(text);
    return {
      id: String(raw.rest_id),
      handle: user.handle,
      name: user.name,
      url: user.handle ? `https://x.com/${user.handle}/status/${raw.rest_id}` : '',
      text,
      date: isoDate(legacy.created_at),
      lang,
      quoted: !!(legacy.is_quote_status || legacy.quoted_status_result),
      repost: !!(legacy.retweeted_status_result),
      promoted,
      // can_reply 缺省表示接口没给，按可回复处理（后面还有回复按钮兜底）
      replyVisible: legacy.can_reply !== false,
      arabic,
      views: parseCount(viewsRaw),
      viewsRaw: viewsRaw == null ? '' : String(viewsRaw)
    };
  }

  /* 从响应 JSON 里取时间线指令。兼容 home_timeline_urt / home_latest_timeline_urt
   * 两种命名，游标取 Bottom（下一页）优先，其次 ShowMore。 */
  function timelineRoot(json) {
    const home = json && json.data && json.data.home;
    if (!home) return null;
    return home.home_timeline_urt || home.homeLatest_timeline_urt
      || home.home_latest_timeline_urt || home.home_timeline_v2_urt || null;
  }

  function parseInstructions(json) {
    const rootUrt = timelineRoot(json);
    const out = { cards: [], cursor: '', bottomCursor: '', topCursor: '', entries: 0 };
    if (!rootUrt) return out;
    const instructions = rootUrt.instructions || [];
    for (const ins of instructions) {
      const entries = ins.entries || ins.moduleItems || [];
      if (Array.isArray(ins.moduleItems)) {
        // 会话模块：里面的 tweet 也算时间线内容
        for (const mi of ins.moduleItems) {
          const card = tweetFromEntry(mi);
          if (card) { out.cards.push(card); out.entries++; }
        }
        continue;
      }
      for (const entry of entries) {
        const content = (entry && entry.content) || {};
        if (content.entryType === 'TimelineTimelineCursor' || content.cursorType) {
          const type = String(content.cursorType || '').toLowerCase();
          if (type === 'bottom') out.bottomCursor = String(content.value || out.bottomCursor);
          else if (type === 'top') out.topCursor = String(content.value || out.topCursor);
          if (!out.cursor && content.value) out.cursor = String(content.value);
          continue;
        }
        out.entries++;
        const card = tweetFromEntry(entry);
        if (card) out.cards.push(card);
      }
    }
    out.cursor = out.bottomCursor || out.cursor || '';
    return out;
  }

  const api = { parseInstructions, tweetFromEntry, parseCount, isoDate, isArabicText, ARABIC_LANGS };
  if (typeof module !== 'undefined') module.exports = api;
  else root.XfaTl = api;
})(globalThis);
