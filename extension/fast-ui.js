(()=>{
  const area=document.createElement('section');area.className='panel';area.innerHTML='<h2>互关快速读取实验 · 0.4</h2><p>读取 X 正常加载的关注数据，减少对页面元素识别的依赖。会刷新目标关注页并自动滚动；不会主动重放接口请求，实际速度仍受 X 加载影响。</p><div class="actions"><button id="fast-ball">启用悬浮球</button><button id="fast-run">读取互关名单</button><button id="fast-stop" disabled>停止</button></div><p id="fast-status" role="status">等待开始。建议优先用这一入口；旧的逐屏扫描作为备用。</p><p>仅“明确回关”的账号进入候选名单；未回关和状态未知账号排除。人数须核对后确认，不自动声称扫描完整。</p>';
  document.querySelector('main').insertBefore(area,document.querySelector('.layout'));
  const el=id=>document.getElementById(id),perm={permissions:['scripting'],origins:['https://x.com/*']};let busy=false,stop=false;
  const status=t=>el('fast-status').textContent=t,wait=ms=>new Promise(r=>setTimeout(r,ms));
  async function float(){const scripts=await chrome.scripting.getRegisteredContentScripts();if(!scripts.some(s=>s.id==='xfa-ball'))await chrome.scripting.registerContentScripts([{id:'xfa-ball',matches:['https://x.com/*'],js:['floating.js'],runAt:'document_idle',persistAcrossSessions:true}]);const tabs=await chrome.tabs.query({url:'https://x.com/*'});for(const t of tabs)await chrome.scripting.executeScript({target:{tabId:t.id},files:['floating.js']}).catch(()=>{});}
  el('fast-ball').onclick=async()=>{try{if(!await chrome.permissions.request(perm)){status('未授予权限');return}await float();status('悬浮球已启用：在 X 页面右侧点击“好友”，可拖动调整高度。')}catch(e){status(e.message)}};
  el('fast-stop').onclick=()=>{stop=true;status('正在停止，将保留已识别名单。')};
  const check=()=>{if(stop)throw Error('已停止。当前保存的是部分名单，请勿当成完整结果')};
  el('fast-run').onclick=async()=>{
    if(busy)return;let tabId=null;busy=true;stop=false;el('fast-run').disabled=true;el('fast-stop').disabled=false;
    for(const id of ['x-scan','x-three'])el(id).disabled=true;
    try{
      if(!await chrome.permissions.contains(perm))throw Error('请先点击“启用悬浮球”完成授权');
      const owner=el('roster-owner').value.trim().replace(/^@/,'');if(!/^[A-Za-z0-9_]{1,15}$/.test(owner))throw Error('请先填写名单所属用户名');
      const win=await chrome.windows.getCurrent(),tabs=await chrome.tabs.query({windowId:win.id,url:'https://x.com/*'});
      const matching=tabs.filter(t=>new URL(t.url).pathname.replace(/\/$/,'').toLowerCase()==='/'+owner.toLowerCase()+'/following');
      const tab=matching.find(t=>t.active)||matching[0];if(!tab)throw Error('请先使用“打开我的关注列表”，等待加载后再开始');tabId=tab.id;
      await chrome.scripting.executeScript({target:{tabId},func:readXPage,args:['following',owner,'']});check();
      await float();await chrome.scripting.unregisterContentScripts({ids:['xfa-network']}).catch(()=>{});
      await chrome.scripting.registerContentScripts([{id:'xfa-network',matches:[`https://x.com/${owner}/following*`,`https://x.com/${owner.toLowerCase()}/following*`].filter((v,i,a)=>a.indexOf(v)===i),js:['network-reader.js'],runAt:'document_start',world:'MAIN',persistAcrossSessions:false}]);
      await chrome.tabs.update(tabId,{active:true});await chrome.tabs.reload(tabId);status('正在刷新关注页，准备读取结构化数据…');
      let ready=false;for(let i=0;i<30;i++){check();await wait(500);if((await chrome.tabs.get(tabId)).status==='complete'){ready=true;break}}
      if(!ready)throw Error('页面加载超时，请手动检查 X 页面');await wait(1000);check();
      await chrome.scripting.executeScript({target:{tabId},func:readXPage,args:['following',owner,'top']});
      let stale=0,last=0,lastSummary='';
      for(let n=0;n<200;n++){
        check();const snapshot=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>window.__xfaFollowingReader04?.snapshot()||null});
        check();const data=snapshot[0]?.result;if(!data)throw Error('未能启动结构化读取。可使用备用逐屏扫描，或导出页面报错供排查');
        if(data.owner!==owner.toLowerCase())throw Error('名单所属账号不匹配');if(data.error)throw Error(data.error);
        const rows=Array.isArray(data.users)?data.users.filter(u=>/^[A-Za-z0-9_]{1,15}$/.test(u.handle)):[];
        const mutual=rows.filter(u=>u.mutual===true),no=rows.filter(u=>u.mutual===false),unknown=rows.length-mutual.length-no.length;
        stale=rows.length===last?stale+1:0;last=rows.length;
        lastSummary=`已读取 ${rows.length} 人：互关 ${mutual.length}，未回关 ${no.length}，未知 ${unknown}；数据页 ${data.pages}`;status(lastSummary);
        // Revalidate the logged-in owner before accepting each batch.
        await chrome.scripting.executeScript({target:{tabId},func:readXPage,args:['following',owner,'']});check();
        if(rows.length)window.dispatchEvent(new CustomEvent('xfa-mutual-snapshot',{detail:{owner,users:mutual,counts:{all:rows.length,mutual:mutual.length,excluded:no.length,unknown},at:new Date().toISOString()}}));
        if(stale>=16)break;
        await chrome.scripting.executeScript({target:{tabId},func:readXPage,args:['following',owner,'next']});await wait(stale?1000:600);
      }
      status(lastSummary+'。本次读取结束，可能仍不完整。请核对总数并确认名单；刷新/停止前已读部分已保存。');
    }catch(e){status(e.message)}finally{
      if(tabId!==null)await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{window.__xfaFollowingReader04?.stop()}}).catch(()=>{});
      await chrome.scripting.unregisterContentScripts({ids:['xfa-network']}).catch(()=>{});
      busy=false;el('fast-run').disabled=false;el('fast-stop').disabled=true;for(const id of ['x-scan','x-three'])el(id).disabled=false;
    }
  };
})();
