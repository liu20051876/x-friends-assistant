// Serialized by chrome.scripting into the isolated world. Only DOM reads and scrolling.
function readXPage(kind, expectedHandle, move) {
  const handle=String(expectedHandle).replace(/^@/,'').toLowerCase();
  const route=location.pathname.replace(/\/$/,'');
  if(location.hostname!=='x.com')throw Error('页面不是 x.com');
  if(/\/i\/(flow|challenge)|\/account\/access|\/login/.test(route))throw Error('需要登录或完成验证，请在 X 页面手动处理');
  const primary=document.querySelector('[data-testid="primaryColumn"]');
  if(!primary)throw Error('无法识别 X 内容区域，停止读取');
  const errors=[...primary.querySelectorAll('[role="alert"],[data-testid="error-detail"]')].map(x=>x.innerText).join(' ');
  if(errors.trim())throw Error('X 页面报告异常，停止读取：'+errors.slice(0,180));
  const login=document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  const profile=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if(!login||!profile)throw Error('未能确认登录状态，请检查 X 页面');
  const own=new URL(profile.href).pathname.split('/')[1]?.toLowerCase();
  if(kind==='following'&&(route.toLowerCase()!==`/${handle}/following`||own!==handle))throw Error('请打开当前登录账号自己的 following 页面，且用户名须与工作台一致');
  if(kind==='posts'&&route.toLowerCase()!==`/${handle}`)throw Error('页面已改变或不是目标好友主页');
  const gate=primary.innerText;
  if(/Rate limit exceeded|Something went wrong|Try reloading|Account suspended|These posts are protected|超出速率限制|出错了|账号已被冻结|这些帖子已受到保护/i.test(gate))throw Error('页面出现限制、错误或受保护状态，请检查后再继续');
  let result;
  if(kind==='following'){
    const users=new Map();
    for(const cell of primary.querySelectorAll('[data-testid="UserCell"]')){
      // Prefer the link containing a literal @handle rather than display names.
      const link=[...cell.querySelectorAll('a[href]')].find(a=>/^@[A-Za-z0-9_]{1,15}$/.test(a.innerText.trim()));
      if(!link)continue;const name=link.innerText.trim().slice(1);
      if(new URL(link.href).pathname.toLowerCase()!=='/'+name.toLowerCase())continue;
      users.set(name.toLowerCase(),{handle:name,name});
    }
    result={users:[...users.values()],owner:own,position:Math.round(scrollY),bottom:innerHeight+scrollY>=document.documentElement.scrollHeight-20};
  }else{
    const posts=[],skipped=[];
    for(const article of primary.querySelectorAll('article[data-testid="tweet"]')){
      const user=article.querySelector('[data-testid="User-Name"]');
      const time=user?.querySelector('time');const link=time?.closest('a');
      if(!link)continue;const match=new URL(link.href).pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
      if(!match||match[1].toLowerCase()!==handle)continue;
      const social=article.querySelector('[data-testid="socialContext"]');
      if(social?.innerText.trim()){skipped.push({id:match[2],reason:'置顶、转发或其他上下文标记：'+social.innerText.slice(0,80)});continue}
      const quote=article.querySelector('[data-testid="quoteTweet"], [data-testid="quotedTweet"]');
      const textNode=article.querySelector('[data-testid="tweetText"]');
      const text=textNode?.innerText||'';
      const prefix=text?article.innerText.split(text)[0]:article.innerText;
      if(/Replying to|回复\s?@|回复给|正在回复|回覆給|返信先/i.test(prefix)){skipped.push({id:match[2],reason:'回复帖'});continue}
      const date=time.getAttribute('datetime');if(!date||!Number.isFinite(Date.parse(date)))continue;
      const imageAlt=[...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(x=>x.alt).filter(Boolean);
      posts.push({id:match[2],handle,url:`https://x.com/${match[1]}/status/${match[2]}`,date,text,imageAlt,type:quote?'引用转发':'原创',quoteText:quote?.innerText||'',visibleContext:article.innerText.slice(0,8000),note:quote?'检测到引用卡片；请人工确认引用正文完整。':'页面显示为原创候选；回复标记和置顶标记均按可见信息排除。'});
    }
    posts.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    result={posts,skipped,owner:own};
  }
  if(move==='top')window.scrollTo({top:0,behavior:'instant'});
  else if(move==='next')window.scrollBy({top:Math.max(400,Math.floor(innerHeight*.75)),behavior:'instant'});
  return result;
}
if(typeof module!=='undefined')module.exports={readXPage};
