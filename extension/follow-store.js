/* 定向交友候选存储层。候选来自关键词搜索页的蓝V作者，人工确认后逐个关注。
 * 已停用（0.6.2）：background 不再 importScripts 本文件，仅保留数据与状态机定义以供恢复。
 * 浏览器环境用 chrome.storage.local；Node 环境用内存，便于单测。 */
(function (root) {
  const FOLLOW_KEY = 'xfa-follow-v1';
  const DEFAULT_KEYWORDS = ['新人蓝V', '交友', '浇友'];
  const DEFAULT_DAILY_LIMIT = 50;
  const CANDIDATE_CAP = 500;
  const STATUS = ['new', 'approved', 'following', 'followed', 'failed', 'skipped'];

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  const memory = { state: null };
  let localLock = Promise.resolve();
  function locked(fn) {
    if (globalThis.navigator?.locks) return globalThis.navigator.locks.request('xfa-follow-write-v1', fn);
    if (hasChrome()) return Promise.reject(Error('浏览器不支持关注存储锁，无法安全保存'));
    const result = localLock.then(fn);
    localLock = result.catch(() => {});
    return result;
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function freshState() {
    return {
      keywords: [...DEFAULT_KEYWORDS],
      dailyLimit: DEFAULT_DAILY_LIMIT,
      candidates: [],
      daily: { date: today(), count: 0 }
    };
  }

  function normalize(s) {
    if (!s || typeof s !== 'object') return freshState();
    if (!Array.isArray(s.keywords) || !s.keywords.length) s.keywords = [...DEFAULT_KEYWORDS];
    if (!Number.isInteger(s.dailyLimit) || s.dailyLimit < 1) s.dailyLimit = DEFAULT_DAILY_LIMIT;
    if (!Array.isArray(s.candidates)) s.candidates = [];
    if (!s.daily || s.daily.date !== today()) s.daily = { date: today(), count: 0 };
    return s;
  }

  async function load() {
    if (hasChrome()) {
      const r = await new Promise(resolve => chrome.storage.local.get(FOLLOW_KEY, resolve));
      return normalize(r[FOLLOW_KEY]);
    }
    return normalize(memory.state);
  }
  async function save(s) {
    if (hasChrome()) {
      await new Promise((resolve, reject) => chrome.storage.local.set({ [FOLLOW_KEY]: s }, () => {
        const e = chrome.runtime?.lastError; e ? reject(Error(e.message)) : resolve();
      }));
    } else {
      memory.state = s;
    }
  }

  const Store = {
    STATUS,
    FOLLOW_KEY,

    async get() { return load(); },

    async setKeywords(list) {
      const keywords = [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\n,，]/))
        .map(x => String(x || '').trim()).filter(Boolean))].slice(0, 30);
      if (!keywords.length) throw Error('至少保留一个搜索关键词');
      return locked(async () => { const s = await load(); s.keywords = keywords; await save(s); return s; });
    },

    async setDailyLimit(value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 400) throw Error('每日上限需为 1 至 400 的整数');
      return locked(async () => { const s = await load(); s.dailyLimit = n; await save(s); return s; });
    },

    /* 采集结果入库：按 handle 去重，已存在（含已关注/失败）的账号不重复入库。
     * 返回新增数量。 */
    async addCandidates(items) {
      return locked(async () => {
        const s = await load();
        const known = new Set(s.candidates.map(c => c.handle));
        const now = new Date().toISOString();
        let added = 0;
        for (const item of items) {
          const handle = String(item.handle || '').replace(/^@/, '').toLowerCase();
          if (!/^[a-z0-9_]{1,15}$/.test(handle) || known.has(handle)) continue;
          s.candidates.push({
            handle,
            name: String(item.name || '').slice(0, 80),
            tweetUrl: String(item.tweetUrl || ''),
            keyword: String(item.keyword || '').slice(0, 40),
            badge: item.badge === 'blue' ? 'blue' : 'unknown',
            status: 'new',
            error: '',
            addedAt: now,
            followedAt: ''
          });
          known.add(handle);
          added++;
        }
        s.candidates = s.candidates.slice(-CANDIDATE_CAP);
        await save(s);
        return added;
      });
    },

    async remove(handle) {
      const key = String(handle || '').toLowerCase();
      return locked(async () => {
        const s = await load();
        s.candidates = s.candidates.filter(c => c.handle !== key);
        await save(s);
      });
    },

    async approve(handle, approved) {
      const key = String(handle || '').toLowerCase();
      return locked(async () => {
        const s = await load();
        const c = s.candidates.find(x => x.handle === key);
        if (!c || ['following', 'followed'].includes(c.status)) return false;
        c.status = approved ? 'approved' : 'new';
        c.error = '';
        await save(s);
        return true;
      });
    },

    /* 一键把所有未处理候选标记为待关注 */
    async approveAllNew() {
      return locked(async () => {
        const s = await load();
        let n = 0;
        for (const c of s.candidates) {
          if (c.status === 'new') { c.status = 'approved'; n++; }
        }
        await save(s);
        return n;
      });
    },

    async claimForFollow(handle) {
      const key = String(handle || '').toLowerCase();
      return locked(async () => {
        const s = await load();
        const c = s.candidates.find(x => x.handle === key);
        if (!c || c.status !== 'approved') return null;
        c.status = 'following';
        await save(s);
        return { ...c };
      });
    },

    async finishFollow(handle, status, error) {
      if (!['followed', 'failed', 'uncertain', 'skipped'].includes(status)) throw Error('未知的关注结果状态');
      const key = String(handle || '').toLowerCase();
      return locked(async () => {
        const s = await load();
        const c = s.candidates.find(x => x.handle === key);
        if (!c || c.status !== 'following') return false;
        if (status === 'followed') {
          c.status = 'followed';
          c.followedAt = new Date().toISOString();
          c.error = '';
          s.daily = s.daily.date === today() ? { date: today(), count: s.daily.count + 1 } : { date: today(), count: 1 };
        } else if (status === 'uncertain') {
          // 关注结果不确定：保留在 following，由用户核实后再处理
          c.error = String(error || '关注结果未确认，请在 X 核实').slice(0, 250);
        } else {
          c.status = status;
          c.error = String(error || '').slice(0, 250);
        }
        await save(s);
        return true;
      });
    },

    /* 用户核实 uncertain 项：已关注 → followed 并计数；未关注 → failed 可重试 */
    async resolveFollow(handle, followed) {
      const key = String(handle || '').toLowerCase();
      return locked(async () => {
        const s = await load();
        const c = s.candidates.find(x => x.handle === key);
        if (!c || c.status !== 'following' || !c.error) return false;
        if (followed) {
          c.status = 'followed';
          c.followedAt = new Date().toISOString();
          c.error = '';
          s.daily = s.daily.date === today() ? { date: today(), count: s.daily.count + 1 } : { date: today(), count: 1 };
        } else {
          c.status = 'failed';
          c.error = '人工核实未关注，可重新批准后重试';
        }
        await save(s);
        return true;
      });
    },

    async todayFollowCount() {
      const s = await load();
      return s.daily.date === today() ? s.daily.count : 0;
    },

    /* 崩溃恢复：卡在 following 且没有错误信息的，结果未知，标记为待核实 */
    async recover() {
      return locked(async () => {
        const s = await load();
        let n = 0;
        for (const c of s.candidates) {
          if (c.status === 'following' && !c.error) {
            c.error = '关注处理中断，可能已经关注，请先在 X 核实';
            n++;
          }
        }
        await save(s);
        return n;
      });
    },

    /* 清理已关注的历史候选，保留未处理项 */
    async archiveFollowed() {
      return locked(async () => {
        const s = await load();
        const before = s.candidates.length;
        s.candidates = s.candidates.filter(c => c.status !== 'followed');
        await save(s);
        return before - s.candidates.length;
      });
    }
  };

  if (typeof module !== 'undefined') module.exports = { Store, FOLLOW_KEY, STATUS };
  else root.FollowStore = Store;
})(globalThis);
