(function(){
  const panel=document.createElement('section');panel.className='panel';
  panel.innerHTML='<h2>X 只读试运行 · 0.4.1</h2><p>先在浏览器打开你自己的 X 关注列表，再授权并扫描。扫描只读取页面和滚动，不点击关注、点赞或发送按钮。</p><p class="muted">浏览器权限提示可能写“读取和更改网站数据”，这是脚本访问权限的标准范围；本版采集代码仅执行读取与滚动。授权只限定 x.com，可随时撤销。</p><div class="actions"><button id="x-grant">授权 X 网站读取</button><button id="x-revoke">撤销网站权限</button><button id="x-open">打开我的关注列表</button><button id="x-scan">扫描已打开的关注列表</button><button id="x-stop" disabled>停止采集</button></div><p id="x-status" aria-live="polite">尚未开始采集</p><p class="muted">工作台上方填写名单所属用户名。扫描达到无新增或次数上限时停止，不自动认定完整；请比对 X 显示的关注数后，再勾选名单完整性确认。</p><div class="actions"><label>每批好友数 <select id="x-batch"><option value="3">3 人</option><option value="5">5 人</option><option value="10">10 人</option></select></label><button id="x-three">继续读取下一批</button><button id="x-reset-batch">从第一位重新开始</button><button id="x-report">导出只读检查报告</button></div><div id="x-results"></div>';
  document.querySelector('main').insertBefore(panel,document.querySelector('.layout'));
  const el=id=>document.getElementById(id),permission={permissions:['scripting'],origins:['https://x.com/*']};
  let running=false,cancelled=false,report={version:'0.4.2',scan:null,profiles:[]};const batchKey='x-friends-review-progress-v1';let batchState={owner:'',cursor:0,profiles:[],seen:{}};try{const v=JSON.parse(localStorage.getItem(batchKey));if(v)batchState={...batchState,...v}}catch{};
  const say=t=>el('x-status').textContent=t;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const stop=()=>{if(cancelled)throw Error('已停止；已读结果保留，未完成部分不视为完整')};
  function busy(on){running=on;for(const id of ['x-scan','x-three','x-grant','x-open','fast-run'])if(el(id))el(id).disabled=on;el('x-stop').disabled=!on;}
  async function allowed(){if(!await chrome.permissions.contains(permission))throw Error('请先点击“授权 X 网站读取”');}
  async function read(tabId,kind,handle,move){stop();const response=await chrome.scripting.executeScript({target:{tabId},func:readXPage,args:[kind,handle,move||'']});stop();if(!response[0]?.result)throw Error('页面读取没有返回数据');return response[0].result;}
  async function run(fn){if(running)return;cancelled=false;busy(true);try{await allowed();await fn()}catch(e){say(e.message)}finally{busy(false)}}
  el('x-grant').onclick=async()=>{try{const yes=await chrome.permissions.request(permission);say(yes?'网站读取权限已授予；点击扫描才开始访问。':'没有授予权限，未访问 X。')}catch(e){say(e.message)}};
  el('x-revoke').onclick=async()=>{cancelled=true;try{await chrome.permissions.remove(permission);say('已撤销 X 网站权限，采集停止。')}catch(e){say(e.message)}};
  el('x-stop').onclick=()=>{cancelled=true;say('正在停止，不再安排下一次页面读取。')};
  function ownerHandle(){const h=el('roster-owner').value.trim().replace(/^@/,'');if(!/^[A-Za-z0-9_]{1,15}$/.test(h))throw Error('请先填写名单所属 X 用户名');return h}
  function matches(t,h){try{const u=new URL(t.url);return u.origin==='https://x.com'&&u.pathname.replace(/\/$/,'').toLowerCase()==='/'+h.toLowerCase()+'/following'}catch{return false}}
  async function target(h){const win=await chrome.windows.getCurrent();const tabs=await chrome.tabs.query({url:'https://x.com/*',windowId:win.id});const found=tabs.filter(t=>matches(t,h));return {tab:found.find(t=>t.active)||found[0],count:found.length,xCount:tabs.length,windowId:win.id}}
  el('x-open').onclick=()=>run(async()=>{const h=ownerHandle(),result=await target(h);if(result.tab)await chrome.tabs.update(result.tab.id,{active:true});else await chrome.tabs.create({windowId:result.windowId,url:'https://x.com/'+h+'/following',active:true});say('已打开目标关注列表。请等待页面加载完成，再点击扫描；若需要登录，请在 X 页面手动完成。')});
  el('x-scan').onclick=()=>run(async()=>{
    const handle=el('roster-owner').value.trim().replace(/^@/,'');if(!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw Error('请先在上方填写名单所属 X 用户名');
    const result=await target(handle);
    if(!result.tab)throw Error('当前浏览器窗口未找到 @'+handle+' 的关注列表（可见 X 标签页 '+result.xCount+' 个）。请点击“打开我的关注列表”。其他浏览器、其他用户配置或应用内浏览器的页面无法共用。');
    const tab=result.tab;await chrome.tabs.update(tab.id,{active:true});
    const users=new Map();let stale=0,reason='达到 160 次读取上限';
    report.scan={owner:handle,started:new Date().toISOString(),complete:false,count:0};
    await read(tab.id,'following',handle,'top');await wait(1500);
    try{for(let n=0;n<160;n++){
      stop();const page=await read(tab.id,'following',handle,'');const before=users.size;
      for(const u of page.users)users.set(u.handle.toLowerCase(),u);
      stale=users.size===before?stale+1:0;report.scan.count=users.size;
      // Incremental snapshots survive interruption, but always need user completeness confirmation.
      if(users.size)window.dispatchEvent(new CustomEvent('x-following-snapshot',{detail:{owner:handle,users:[...users.values()],label:'X 页面扫描（待核对完整性）'}}));
      say(`扫描第 ${n+1} 次：累计 ${users.size} 个账号。可返回工作台停止。`);
      if(stale>=6){reason='连续 6 次没有新增，需人工核对是否完整';break}
      await read(tab.id,'following',handle,'next');await wait(1800);
    }}finally{report.scan.finished=new Date().toISOString();report.scan.count=users.size;report.scan.reason=cancelled?'用户停止':reason;}
    say(`扫描停止：${users.size} 人。${reason}。已保存至真实名单工作区，请核对数量后确认。`);
  });
  function saveBatch(){try{localStorage.setItem(batchKey,JSON.stringify(batchState))}catch{say('浏览器本地空间不足，当前批次进度可能无法保存。')}}
  el('x-reset-batch').onclick=()=>{if(!confirm('将阅读进度重置到第一位？已读取记录保留。'))return;batchState.cursor=0;saveBatch();say('阅读顺序已重置。')};
  el('x-three').onclick=()=>run(async()=>{
    const roster=JSON.parse(localStorage.getItem('x-friends-roster-v1')||'{}');
    if(!roster.confirmed||!roster.followingFile)throw Error('请先导入并确认完整互关名单');
    const users=roster.following;if(!users.length)throw Error('候选好友名单为空');
    const owner=String(roster.owner).replace(/^@/,'').toLowerCase();
    if(batchState.owner.toLowerCase()!==owner){batchState={owner,cursor:0,profiles:[],seen:{}};saveBatch()}
    const count=Number(el('x-batch').value)||3,start=batchState.cursor%users.length,selected=users.slice(start,start+count);
    report.profiles=[];el('x-results').replaceChildren();if(!selected.length)throw Error('已到名单末尾，请重置顺序或稍后继续');
    const tab=await chrome.tabs.create({url:'https://x.com/'+selected[0].handle,active:true});
    for(let i=0;i<selected.length;i++){
      stop();const person=selected[i];if(i)await chrome.tabs.update(tab.id,{url:'https://x.com/'+person.handle,active:true});
      say('读取名单 '+(start+i+1)+'/'+users.length+'：@'+person.handle);
      let page=null;
      // Poll for a fully rendered profile for up to 15 seconds; stop on challenges and rate limits.
      for(let attempt=0;attempt<10;attempt++){
        await wait(1500);stop();
        try{page=await read(tab.id,'posts',person.handle,'');if(page.posts.length||page.skipped.length)break}catch(e){if(/验证|限制|出错|受保护|页面已改变/.test(e.message))throw e}
      }
      if(!page)throw Error('未能读取主页；已保存此前完成项，请稍后继续');
      if(page.owner!==owner)throw Error('登录账号与名单所属账号不一致，已停止');
      const candidates=page.posts.filter(p=>p.type==='原创'||p.type==='引用转发');
      const candidate=candidates[0]||null;
      const signature=person.handle.toLowerCase()+':'+(candidate?.id||'none');
      if(candidate&&batchState.seen[signature]){batchState.cursor=start+i+1;saveBatch();say('@'+person.handle+' 的这条帖子已记录过，跳过重复项。');continue}
      const entry={handle:person.handle,readAt:new Date().toISOString(),candidate,skipped:page.skipped};report.profiles.push(entry);batchState.profiles.push(entry);
      if(candidate)batchState.seen[signature]=true;
      batchState.cursor=start+i+1;saveBatch();
      const box=document.createElement('div');box.className='post';const h=document.createElement('strong');h.textContent='@'+person.handle;box.append(h);
      const text=document.createElement('p');text.textContent=candidate?`${candidate.date} · ${candidate.type}\n${candidate.text||'仅媒体帖子：请在 X 查看媒体'}${candidate.quoteText?'\n引用内容：'+candidate.quoteText:''}\n\n${candidate.note}`:'未识别到符合条件的原创帖或引用转发；请人工查看主页。';box.append(text);
      if(candidate){
        const link=document.createElement('a');link.textContent='在 X 核对原帖';link.href=candidate.url;link.target='_blank';link.rel='noopener noreferrer';box.append(link);
        const draft=makeDraft(candidate);const label=document.createElement('label');label.textContent='英文回复草稿（本地建议，可编辑）';label.style.display='block';label.style.marginTop='12px';box.append(label);
        const area=document.createElement('textarea');area.rows=2;area.style.width='100%';area.value=batchState.drafts?.[candidate.id]||draft.en;label.append(area);
        area.oninput=()=>{batchState.drafts=batchState.drafts||{};batchState.drafts[candidate.id]=area.value;saveBatch()};
        const translation=document.createElement('p');translation.className='muted';translation.textContent=`建议语气：${draft.kind} · 中文参考：${draft.zh}`;box.append(translation);
        const copy=document.createElement('button');copy.textContent='复制草稿';copy.onclick=async()=>{try{await navigator.clipboard.writeText(area.value);say('草稿已复制；尚未在 X 发送。')}catch{area.select();say('请手动复制已选中的草稿。')}};box.append(copy);
      }el('x-results').append(box);
      if(i<selected.length-1)await wait(1800);
    }
    say(`本批完成：${report.profiles.length} 人。进度 ${Math.min(batchState.cursor,users.length)}/${users.length}；进度和草稿保存在本机，可继续下一批。`);
  });
  function makeDraft(post){
    const t=(post.text+' '+post.quoteText).toLowerCase();
    if(/\b(dog|cat|pet|passed away|goodbye|grief|loss|hospital|sick|diagnos|funeral|died|death)\b|去世|离开了|生病|医院|告别|难过|逝世/.test(t))return {kind:'温和',en:'So sorry you’re going through this. Sending you lots of warmth ❤️',zh:'很遗憾你正在经历这些，给你送上温暖与陪伴。'};
    if(/\b(game|gaming|played|level|boss|quest|character)\b|玩家|游戏|副本|通关|角色/.test(t))return {kind:'游戏轻松',en:'The side quest somehow became the main quest 😂',zh:'支线任务不知不觉就变成主线任务了 😂'};
    if(/\b(anime|manga|episode|season|waifu|isekai)\b|动画|动漫|漫画|番剧|下一集/.test(t))return {kind:'动漫轻松',en:'“Just one more episode” has defeated us all 😂',zh:'“再看一集”打败过我们所有人 😂'};
    if(/\b(growth|creator|algorithm|followers|engagement|social media|content)\b|创作者|涨粉|算法|运营|流量/.test(t))return {kind:'社媒交流',en:'The best growth hack is still being a real person 😄',zh:'最好的增长技巧，依然是真诚地像个人一样交流 😄'};
    if(/\b(movie|film|show|music|concert|celebrity)\b|电影|音乐|演唱会|综艺/.test(t))return {kind:'娱乐轻松',en:'The hardest part is picking what to watch 😅',zh:'最难的部分果然还是决定看什么 😅'};
    return {kind:'轻松问候',en:'Just stopping by to say hey 👋',zh:'日常刷到，顺手来打个招呼 👋'};
  }
  el('x-report').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='x-readonly-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
})();
