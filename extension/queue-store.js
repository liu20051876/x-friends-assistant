/* 目标帖队列存储层。扩展环境用 chrome.storage.local；Node 环境用内存，便于单测。 */
(function (root) {
  const QUEUE_KEY = 'xfa-queue-v1';
  const HISTORY_KEY = 'xfa-history-v1'; // 已处理帖子 id（sent/skipped），跨队列去重
  const DAILY_KEY = 'xfa-daily-v1';     // 当日发送计数，与队列解耦，归档不影响上限
  const DAILY_HANDLES_KEY = 'xfa-daily-handles-v1'; // 当日已发过的好友，用于"同一人当天只发一条"
  const STATUS = ['pending', 'drafting', 'ready', 'approved', 'sending', 'sent', 'failed', 'uncertain', 'skipped'];

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  const memory = { queue: [], history: [], daily: null, handles: null };
  let localLock = Promise.resolve();

  function locked(fn) {
    if (globalThis.navigator?.locks) return globalThis.navigator.locks.request('xfa-queue-write-v1', fn);
    // 浏览器中必须使用跨页面与后台共享的锁，避免退化为不安全的并发写入。
    if (hasChrome()) return Promise.reject(Error('浏览器不支持队列锁，无法安全保存'));
    const result = localLock.then(fn);
    localLock = result.catch(() => {});
    return result;
  }

  async function rawGet(key) {
    if (hasChrome()) {
      return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])));
    }
    if (key === QUEUE_KEY) return memory.queue;
    if (key === HISTORY_KEY) return memory.history;
    if (key === DAILY_HANDLES_KEY) return memory.handles;
    return memory.daily;
  }

  async function rawSet(key, value) {
    if (hasChrome()) {
      return new Promise((resolve, reject) =>
        chrome.storage.local.set({ [key]: value }, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          err ? reject(Error(err.message)) : resolve();
        }));
    }
    if (key === QUEUE_KEY) memory.queue = value;
    else if (key === HISTORY_KEY) memory.history = value;
    else if (key === DAILY_HANDLES_KEY) memory.handles = value;
    else memory.daily = value;
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const Store = {
    STATUS,
    QUEUE_KEY,
    HISTORY_KEY,

    async loadQueue() {
      const q = await rawGet(QUEUE_KEY);
      return Array.isArray(q) ? q : [];
    },

    async saveQueue(queue) {
      await rawSet(QUEUE_KEY, queue);
    },

    async loadHistory() {
      const h = await rawGet(HISTORY_KEY);
      return Array.isArray(h) ? h : [];
    },

    async saveHistory(history) {
      // 历史最多保留 5000 条，防止无限膨胀
      await rawSet(HISTORY_KEY, history.slice(-5000));
    },

    /* 新采集帖子入库；返回实际新增数量。已在历史或队列中的跳过。 */
    async addPosts(posts) {
      return locked(async () => {
      const [queue, history] = await Promise.all([this.loadQueue(), this.loadHistory()]);
      const queuedIds = new Set(queue.map(x => x.id));
      const historyIds = new Set(history);
      const now = new Date().toISOString();
      let added = 0;
      for (const p of posts) {
        if (!p || !p.id || queuedIds.has(p.id) || historyIds.has(String(p.id))) continue;
        queue.push({
          id: String(p.id),
          handle: p.handle,
          url: p.url,
          text: p.text || '',
          quoteText: p.quoteText || '',
          date: p.date,
          type: p.type || '原创',
          source: p.source || 'roster',
          imageAlt: Array.isArray(p.imageAlt) ? p.imageAlt : [],
          status: 'pending',
          draft: '',
          draftKind: '',
          draftSource: '',
          error: '',
          addedAt: now,
          sentAt: ''
        });
        queuedIds.add(String(p.id));
        added++;
      }
      await this.saveQueue(queue);
      return added;
      });
    },

    async update(id, patch) {
      return locked(async () => {
      const queue = await this.loadQueue();
      const idx = queue.findIndex(x => x.id === String(id));
      if (idx < 0) return null;
        if (queue[idx].status === 'sending' && !['sent', 'failed', 'uncertain', 'skipped'].includes(patch.status)) throw Error('该帖子正在发送，请等待处理完成');
      queue[idx] = { ...queue[idx], ...patch };
      await this.saveQueue(queue);
      return queue[idx];
      });
    },

    async editDraft(id, draft) {
      return locked(async () => {
        const queue = await this.loadQueue();
        const idx = queue.findIndex(x => x.id === String(id));
        if (idx < 0) return null;
        const item = queue[idx];
        if (item.status === 'sending') throw Error('该帖子正在发送，请等待处理完成');
        const demoted = item.status === 'approved' && item.draft !== draft;
        // 退回待确认时一并清掉自动过审标记，否则卡片会同时显示“待你确认”和“✓ 自动过审”
        queue[idx] = { ...item, draft, draftSource: 'manual',
          status: demoted ? 'ready' : item.status,
          autoApproved: demoted ? false : item.autoApproved };
        await this.saveQueue(queue);
        return queue[idx];
      });
    },

    async claimForSend(id, draft, draftSource) {
      return locked(async () => {
        const queue = await this.loadQueue();
        const idx = queue.findIndex(x => x.id === String(id));
        if (idx < 0 || queue[idx].status !== 'approved' || queue[idx].draft !== draft || queue[idx].draftSource !== draftSource) return null;
        queue[idx] = { ...queue[idx], status: 'sending' };
        await this.saveQueue(queue);
        return queue[idx];
      });
    },

    async updateIfUnchanged(id, expected, patch) {
      return locked(async () => {
        const queue = await this.loadQueue();
        const idx = queue.findIndex(x => x.id === String(id));
        if (idx < 0 || Object.keys(expected).some(key => queue[idx][key] !== expected[key])) return null;
        queue[idx] = { ...queue[idx], ...patch };
        await this.saveQueue(queue);
        return queue[idx];
      });
    },

    async list(predicate) {
      const queue = await this.loadQueue();
      return typeof predicate === 'function' ? queue.filter(predicate) : queue;
    },

    /* 终态条目移入历史并从队列移除 */
    async archive(id) {
      return locked(async () => {
      const [queue, history] = await Promise.all([this.loadQueue(), this.loadHistory()]);
      const idx = queue.findIndex(x => x.id === String(id));
      if (idx < 0) return;
      const [item] = queue.splice(idx, 1);
      if (item.status === 'sent' || item.status === 'skipped') {
        if (!history.includes(String(id))) history.push(String(id));
      }
      await Promise.all([this.saveQueue(queue), this.saveHistory(history)]);
      });
    },

    async todaySentCount() {
      const d = await rawGet(DAILY_KEY);
      if (!d || d.date !== today()) return 0;
      return Number(d.count) || 0;
    },

    /* 发送成功后递增当日计数。跨天自动归零。 */
    async incrementDaily() {
      return locked(async () => {
      const d = await rawGet(DAILY_KEY);
      const next = (!d || d.date !== today())
        ? { date: today(), count: 1 }
        : { date: d.date, count: (Number(d.count) || 0) + 1 };
      await rawSet(DAILY_KEY, next);
      return next.count;
      });
    },

    async handleLedger() {
      const v = await rawGet(DAILY_HANDLES_KEY);
      if (!v || v.date !== today()) return { date: today(), handles: [] };
      return { date: v.date, handles: Array.isArray(v.handles) ? v.handles : [] };
    },

    async todayHandles() {
      return (await this.handleLedger()).handles;
    },

    /* 发送成功后登记好友，供"同一人当天只发一条"判定 */
    async addDailyHandle(handle) {
      const key = String(handle || '').toLowerCase();
      if (!key) return;
      return locked(async () => {
        const ledger = await this.handleLedger();
        if (!ledger.handles.includes(key)) ledger.handles.push(key);
        await rawSet(DAILY_HANDLES_KEY, { date: today(), handles: ledger.handles.slice(-200) });
      });
    },

    async clearAll() {
      return locked(async () => {
      await Promise.all([
        this.saveQueue([]),
        this.saveHistory([]),
        rawSet(DAILY_KEY, { date: today(), count: 0 }),
        rawSet(DAILY_HANDLES_KEY, { date: today(), handles: [] })
      ]);
      });
    }
  };

  if (typeof module !== 'undefined') module.exports = { Store, QUEUE_KEY, HISTORY_KEY, STATUS };
  else root.QueueStore = Store;
})(globalThis);
