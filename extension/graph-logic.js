/* 互关判定：优先用 X 返回的关系字段，缺失时用粉丝列表做集合差集补齐。
 * 纯函数，无副作用，可在 Node 单测。 */
(function (root) {
  function compute(following, followers, options = {}) {
    const list = Array.isArray(following) ? following : [];
    const followerSet = Array.isArray(followers)
      ? new Set(followers.map(u => String(u.handle || u).toLowerCase()))
      : null;

    const mutual = [];
    const notMutual = [];
    const unknown = [];

    for (const u of list) {
      if (!u || !u.handle) continue;
      let theyFollowMe = u.theyFollowMe;
      if (theyFollowMe === null || theyFollowMe === undefined) {
        // 关系字段缺失时，用粉丝集合兜底：在集合里就是互关
        if (followerSet?.has(String(u.handle).toLowerCase())) theyFollowMe = true;
        else if (followerSet && options.followersComplete !== false) theyFollowMe = false;
      }
      if (theyFollowMe === true) mutual.push(u);
      else if (theyFollowMe === false) notMutual.push(u);
      else unknown.push(u);
    }

    return {
      mutual,
      notMutual,
      unknown,
      counts: {
        all: list.length,
        mutual: mutual.length,
        notMutual: notMutual.length,
        unknown: unknown.length,
        protected: list.filter(u => u && u.protected).length,
        restricted: list.filter(u => u && u.restricted).length
      }
    };
  }

  const api = { compute };
  if (typeof module !== 'undefined') module.exports = api;
  else root.GraphLogic = api;
})(globalThis);
