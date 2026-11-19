/* 自动过审校验器单测：node tests/auto-review-check.js */
const AutoReview = require('../auto-review.js');
let fails = 0;
const t = (name, cond, extra = '') => {
  if (cond) console.log('✓ ' + name);
  else { fails++; console.log('✗ ' + name + (extra ? ` — ${extra}` : '')); }
};

const ai = (en) => ({ en, kind: 'warm', source: 'ai:deepseek' });
const post = { handle: 'alice', text: 'Finally got the espresso machine working. First shot was terrible, second one was perfect.', quoteText: '' };

// 1. 正常英文
let r = AutoReview.check({ post, draft: ai('Second shot always wins. Congrats on dialing it in!') });
t('正常英文草稿通过', r.ok, r.reason);

// 2. 正常中文
r = AutoReview.check({ post: { handle: 'alice', text: '今天终于把咖啡机修好了，第一杯难喝得要命，第二杯直接封神。' }, draft: { en: '第二次就成功啦，手感找到了就好办，恭喜！', kind: 'warm', source: 'ai:siliconflow' } });
t('正常中文草稿通过', r.ok, r.reason);

// 3. 正常日文
r = AutoReview.check({ post: { handle: 'alice', text: 'やっとエスプレッソマシンが直った。1杯目はひどかったけど2杯目は完璧。' }, draft: { en: '2回目で成功したのすごい！慣れると安定しますよね。', kind: 'warm', source: 'ai:deepseek' } });
t('正常日文草稿通过', r.ok, r.reason);

// 3b. 中文帖回英文：必须拦下
r = AutoReview.check({ post: { handle: 'alice', text: '今天终于把咖啡机修好了，第一杯难喝得要命，第二杯直接封神。' }, draft: ai('Nice, the second shot always wins. Congrats on dialing it in!') });
t('中文帖回英文被拦截', !r.ok, r.reason);

// 3c. 英文帖回中文：同样拦下
r = AutoReview.check({ post, draft: { en: '第二杯就稳了，手感这东西就是练出来的。', kind: 'warm', source: 'ai:deepseek' } });
t('英文帖回中文被拦截', !r.ok, r.reason);

// 4. 模板兜底不自动过审
r = AutoReview.check({ post, draft: { en: 'This is a nice post, thanks for sharing it with us today.', source: 'template' } });
t('模板兜底不自动过审', !r.ok, r.reason);

// 5. 不支持的语言（韩文 / 俄文）
r = AutoReview.check({ post, draft: { en: '정말 멋진 커피네요. 축하드려요!', source: 'ai:deepseek' } });
t('韩文被拦截', !r.ok, r.reason);
r = AutoReview.check({ post, draft: { en: 'Отличная работа, поздравляю тебя с успехом!', source: 'ai:deepseek' } });
t('俄文被拦截', !r.ok, r.reason);

// 6. 含链接
r = AutoReview.check({ post, draft: { en: 'Nice! Check https://example.com for tips on espresso.', source: 'ai:deepseek' } });
t('含链接被拦截', !r.ok, r.reason);

// 7. 含 @ 提及
r = AutoReview.check({ post, draft: { en: 'Nice work @alice, second shot always wins.', source: 'ai:deepseek' } });
t('含 @ 被拦截', !r.ok, r.reason);

// 8. 含话题标签
r = AutoReview.check({ post, draft: { en: 'Nice work! #espresso #coffee life is good.', source: 'ai:deepseek' } });
t('含话题标签被拦截', !r.ok, r.reason);

// 9. 过短
r = AutoReview.check({ post, draft: { en: 'Nice!', source: 'ai:deepseek' } });
t('过短被拦截', !r.ok, r.reason);

// 9b. 中文口语短回复（4 字以上）放行，两个字的纯语气词仍拦
const zhPost = { handle: 'alice', text: '今天终于把咖啡机修好了，第一杯难喝得要命，第二杯直接封神。' };
r = AutoReview.check({ post: zhPost, draft: { en: '典，这也太野了', source: 'ai:deepseek' } });
t('中文口语短回复放行', r.ok, r.reason);
r = AutoReview.check({ post: zhPost, draft: { en: '神了', source: 'ai:deepseek' } });
t('两个字的语气词仍拦', !r.ok, r.reason);
t('超短回复被识别为短回复', AutoReview.isShortReply('典，这也太野了'), '');
t('常规长度不算短回复', !AutoReview.isShortReply('这次的手感确实稳,第二杯能拉出花了'), '');

// 10. 过长
r = AutoReview.check({ post, draft: { en: ('This is a very long reply that keeps going and going ' .repeat(8)) + 'end.', source: 'ai:deepseek' } });
t('过长被拦截', !r.ok, r.reason);

// 11. 原帖复述
r = AutoReview.check({ post, draft: { en: 'Finally got the espresso machine working, first shot was terrible, second one was perfect.', source: 'ai:deepseek' } });
t('原帖复述被拦截', !r.ok, r.reason);

// 12. 与其他草稿重复
r = AutoReview.check({ post, draft: ai('Second shot always wins. Congrats on dialing it in!'), seenDrafts: new Set([AutoReview.norm('Second shot always wins. Congrats on dialing it in!')]) });
t('重复草稿被拦截', !r.ok, r.reason);

// 13. 同一好友今天已有一条
r = AutoReview.check({ post: { ...post, handle: 'Bob' }, draft: ai('Second shot always wins. Congrats on dialing it in!'), handleToday: new Set(['bob']) });
t('同一好友当天重复被拦截', !r.ok, r.reason);

// 13b. 时间线来源不受「当天一条」限制
r = AutoReview.check({ post: { ...post, handle: 'Bob', source: 'timeline' }, draft: ai('Second shot always wins. Congrats on dialing it in!'), handleToday: new Set(['bob']) });
t('时间线来源豁免当天限制', r.ok, r.reason);

// 13c. 但同一批内仍不允许同一账号两条
r = AutoReview.check({ post: { ...post, handle: 'Bob', source: 'timeline' }, draft: ai('Second shot always wins. Congrats on dialing it in!'), handleBatch: new Set(['bob']) });
t('时间线同批重复仍被拦截', !r.ok, r.reason);

// 14. 允许 emoji
r = AutoReview.check({ post, draft: ai('Second shot always wins ☕ congrats on dialing it in!') });
t('含 emoji 通过', r.ok, r.reason);

// 15. AI 自述被拦截
r = AutoReview.check({ post, draft: ai('As an AI I think your second shot looks great and promising.') });
t('AI 自述被拦截', !r.ok, r.reason);

// 16. 原创帖：正常英文通过
r = AutoReview.checkOriginalDraft('Spent the whole evening chasing a weird rendering bug that turned out to be one missing comma. Worth it.');
t('原创英文草稿通过', r.ok, r.reason);

// 17. 原创帖：中日文被拦（要求英文）
r = AutoReview.checkOriginalDraft('今天花了一晚上排查一个渲染问题，最后发现只是少了一个逗号。');
t('原创中文被拦截', !r.ok, r.reason);

// 18. 原创帖：超 280 字符被拦
r = AutoReview.checkOriginalDraft('Rendering bugs are the worst. '.repeat(20));
t('原创超长被拦截', !r.ok, r.reason);

// 19. 原创帖：链接、@、# 被拦
r = AutoReview.checkOriginalDraft('Check this out https://example.com and tell me what you think about it.');
t('原创含链接被拦截', !r.ok, r.reason);
r = AutoReview.checkOriginalDraft('Hey @alice, this rendering bug took me all evening long to fix.');
t('原创含@被拦截', !r.ok, r.reason);
r = AutoReview.checkOriginalDraft('Late night debugging vibes #gamedev are truly something else today.');
t('原创含#被拦截', !r.ok, r.reason);

// 20. 原创帖：过短被拦
r = AutoReview.checkOriginalDraft('Bug.');
t('原创过短被拦截', !r.ok, r.reason);

if (fails) { console.log(`\n${fails} 项失败`); process.exitCode = 1; }
else console.log('\n自动过审校验全部通过（20 项）');
