// Independently implemented passive reader. Never creates/replays network requests.
(()=>{
  const key='__xfaFollowingReader04';if(window[key])return;
  const initial=location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);if(!initial)return;
  const owner=initial[1].toLowerCase(),users=new Map();let active=true,pages=0,error='',lease=Date.now()+30000;
  const originalFetch=window.fetch,originalOpen=XMLHttpRequest.prototype.open,requests=new WeakMap();
  function accepts(raw){try{const u=new URL(raw,location.origin);return active&&Date.now()<lease&&location.pathname.toLowerCase().replace(/\/$/,'')==='/'+owner+'/following'&&u.origin===location.origin&&/\/graphql\/[^/]+\/Following$/.test(u.pathname)}catch{return false}}
  function ingest(data){
    if(!active||Date.now()>lease)return;if(data?.errors?.length){error='关注数据返回错误，请停止并检查 X 页面';return}
    // Only follow the selected user's following timeline, not arbitrary nested user objects.
    const timeline=data?.data?.user?.result?.timeline;const instructions=timeline?.timeline?.instructions||timeline?.instructions;
    if(!Array.isArray(instructions)){error='关注数据结构无法识别';return}
    let found=0;
    for(const instruction of instructions){for(const entry of instruction.entries||[]){
      const contents=[entry.content?.itemContent,...(entry.content?.items||[]).map(x=>x.item?.itemContent)];
      for(const content of contents){let user=content?.user_results?.result;if(user?.__typename==='UserWithVisibilityResults')user=user.user;
        const handle=user?.core?.screen_name||user?.legacy?.screen_name;if(!user?.rest_id||!handle||! /^[A-Za-z0-9_]{1,15}$/.test(handle))continue;
        const value=user.relationship_perspectives?.followed_by??user.legacy?.followed_by;
        const mutual=typeof value==='boolean'?value:null;
        if(users.size>=10000&&!users.has(handle.toLowerCase())){error='超过本次读取上限';return}
        users.set(handle.toLowerCase(),{handle,name:String(user.core?.name||user.legacy?.name||handle).slice(0,200),mutual});found++;
      }
    }}pages++;
  }
  function inspect(response,url){if(!accepts(url))return;if(response.status===429||response.status===401||response.status===403){error='X 返回限流或授权限制，已停止读取';return}if(!response.ok){error='X 关注数据请求失败';return}response.clone().json().then(ingest).catch(()=>{error='无法解析关注数据'})}
  function wrappedFetch(...args){const raw=typeof args[0]==='string'?args[0]:args[0]?.url;return originalFetch.apply(this,args).then(response=>{inspect(response,raw);return response})}
  function wrappedOpen(method,url,...rest){requests.set(this,url);this.addEventListener('load',()=>{if(!accepts(requests.get(this)))return;if(this.status!==200){error='X 关注数据请求失败或受限';return}try{ingest(this.responseType==='json'?this.response:JSON.parse(this.responseText))}catch{error='无法解析关注数据'}},{once:true});return originalOpen.call(this,method,url,...rest)}
  window.fetch=wrappedFetch;XMLHttpRequest.prototype.open=wrappedOpen;
  window[key]={snapshot(){lease=Date.now()+30000;return {owner,users:[...users.values()],pages,error}},stop(){active=false;users.clear();if(window.fetch===wrappedFetch)window.fetch=originalFetch;if(XMLHttpRequest.prototype.open===wrappedOpen)XMLHttpRequest.prototype.open=originalOpen;delete window[key]}};
})();
