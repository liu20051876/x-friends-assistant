/* 原创草稿触发器（时间间隔版）。
 * 两条原创帖之间的间隔在配置的分钟数之间随机，到点无条件生成草稿；
 * 发布仍由用户逐条确认。只记录明确确认的发布结果，不自动补发。 */
(function (root) {
  const KEY = 'xfa-original-drafts-v1';
  const DEFAULT_MIN = 180; // 分钟（3 小时）
  const DEFAULT_MAX = 480; // 分钟（8 小时）
  const DRAFT_CAP = 50;
  const pick = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const id = () => globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const read = () => new Promise((resolve, reject) => chrome.storage.local.get(KEY, r => {
    const e = chrome.runtime.lastError; e ? reject(Error(e.message)) : resolve(r[KEY]);
  }));
  const write = value => new Promise((resolve, reject) => chrome.storage.local.set({ [KEY]: value }, () => {
    const e = chrome.runtime.lastError; e ? reject(Error(e.message)) : resolve();
  }));

  function freshState() {
    return {
      enabled: true,
      min: DEFAULT_MIN,
      max: DEFAULT_MAX,
      nextDueAt: Date.now() + pick(DEFAULT_MIN, DEFAULT_MAX) * 60000,
      task: null,
      drafts: [],
      uncertain: []
    };
  }

  /* 旧版（按回复条数计数）状态迁移：保留草稿与待核实记录，废弃计数，
   * 下一条从现在起按新间隔随机。 */
  function migrate(s) {
    if (!s || typeof s !== 'object') return freshState();
    const enabled = s.enabled === false ? false : true;
    if (typeof s.nextDueAt !== 'number') {
      return {
        enabled,
        min: DEFAULT_MIN,
        max: DEFAULT_MAX,
        nextDueAt: Date.now() + pick(DEFAULT_MIN, DEFAULT_MAX) * 60000,
        task: null,
        drafts: Array.isArray(s.drafts) ? s.drafts : [],
        uncertain: Array.isArray(s.uncertain) ? s.uncertain : []
      };
    }
    s.enabled = enabled;
    if (!Array.isArray(s.uncertain)) s.uncertain = [];
    if (!Array.isArray(s.drafts)) s.drafts = [];
    return s;
  }

  async function mutate(fn) {
    if (!globalThis.navigator?.locks) throw Error('浏览器不支持安全的草稿计数锁');
    return navigator.locks.request(KEY, async () => {
      const s = migrate(await read());
      const result = await fn(s);
      await write(s);
      return result === undefined ? s : result;
    });
  }

  const api = {
    async get() { return mutate(s => s); },
    async setEnabled(flag) {
      return mutate(s => { s.enabled = !!flag; });
    },
    async configure(min, max) {
      min = Number(min); max = Number(max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 10000 || min > max)
        throw Error('间隔需为 1 至 10000 分钟的整数，且最小值不大于最大值');
      return mutate(s => { s.min = min; s.max = max; }); // 下一轮生效
    },
    /* 到点申领：无任务且到时间 → 生成任务；pending 任务（重试）继续推进；
     * 其他状态或未到点返回 null。 */
    async claimDue() {
      return mutate(s => {
        // 暂停期间不自动生成，也不推进重试任务
        if (s.enabled === false) return null;
        if (s.task) {
          if (s.task.status === 'pending') { s.task.status = 'generating'; return { ...s.task }; }
          return null;
        }
        if (Date.now() < s.nextDueAt) return null;
        s.task = { id: id(), status: 'generating', error: '' };
        return { ...s.task };
      });
    },
    async complete(taskId, text) {
      return mutate(s => {
        if (!s.task || s.task.id !== taskId || s.task.status !== 'generating') return false;
        if (!String(text || '').trim()) throw Error('生成的原创草稿为空');
        s.drafts.unshift({ id: taskId, text: String(text).trim(), createdAt: new Date().toISOString() });
        s.drafts = s.drafts.slice(0, DRAFT_CAP);
        s.task = null;
        s.nextDueAt = Date.now() + pick(s.min, s.max) * 60000;
        return true;
      });
    },
    async fail(taskId, message) {
      return mutate(s => {
        if (s.task?.id === taskId && s.task.status === 'generating') {
          s.task.status = 'failed';
          s.task.error = String(message || '生成失败').slice(0, 250);
        }
      });
    },
    async recover() {
      return mutate(s => {
        if (s.task?.status === 'generating') {
          s.task.status = 'interrupted';
          s.task.error = '上次请求中断，可能已产生费用；请手动重试。';
        }
        for (const draft of s.drafts) if (draft.publishStatus === 'publishing') {
          draft.publishStatus = 'uncertain';
          draft.publishError = '发布处理中断，可能已经发出，请先在 X 核实。';
        }
      });
    },
    async retry() {
      return mutate(s => {
        if (s.task && ['failed', 'interrupted'].includes(s.task.status)) {
          s.task.status = 'pending'; s.task.error = ''; return true;
        }
        return false;
      });
    },
    async edit(taskId, text) {
      return mutate(s => {
        const draft = s.drafts.find(x => x.id === taskId);
        if (!draft) throw Error('草稿不存在');
        if (['publishing', 'published', 'uncertain'].includes(draft.publishStatus))
          throw Error('该草稿正在发布、已发布或待核实，不能编辑');
        if (!String(text || '').trim()) throw Error('草稿不能为空');
        draft.text = String(text).trim();
      });
    },
    async remove(taskId) {
      return mutate(s => {
        const d = s.drafts.find(x => x.id === taskId);
        if (d?.publishStatus === 'publishing') throw Error('正在发布，不能删除');
        s.drafts = s.drafts.filter(x => x.id !== taskId);
      });
    },
    async dismissUncertain(replyId) {
      return mutate(s => { s.uncertain = s.uncertain.filter(x => x.id !== String(replyId)); });
    },
    async claimPublish(taskId, text) {
      return mutate(s => {
        const d = s.drafts.find(x => x.id === taskId);
        if (!d || d.text !== text || ['publishing', 'published', 'uncertain'].includes(d.publishStatus)) return false;
        d.publishStatus = 'publishing'; d.publishError = ''; return true;
      });
    },
    async finishPublish(taskId, status, error) {
      return mutate(s => {
        if (!['published', 'uncertain', 'failed'].includes(status)) throw Error('未知的发布状态');
        const d = s.drafts.find(x => x.id === taskId);
        if (!d || d.publishStatus !== 'publishing') return false;
        d.publishStatus = status;
        d.publishError = String(error || '').slice(0, 250);
        return true;
      });
    },
    async resolvePublish(taskId, published) {
      return mutate(s => {
        const d = s.drafts.find(x => x.id === taskId);
        if (!d || d.publishStatus !== 'uncertain') return false;
        d.publishStatus = published ? 'published' : 'failed';
        d.publishError = '';
        return true;
      });
    }
  };
  root.OriginalStore = api;
})(globalThis);
