/* Local-only CSV matching. No requests, cookies or X session access. */
(function(root){
  function parseCSV(text){
    const rows=[];let row=[],cell='',quoted=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
      else if(c===','&&!quoted){row.push(cell);cell=''}
      else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell=''}
      else cell+=c;
    }
    if(quoted)throw Error('CSV 引号不完整');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows;
  }
  function read(text,kind){
    const rows=parseCSV(text),headers=(rows.shift()||[]).map(x=>x.trim());
    const index=headers.findIndex(x=>['用户名','username','handle','screen_name'].includes(x.toLowerCase()));
    if(index<0)throw Error('文件需要“用户名”或 username 列');
    const status=headers.indexOf('状态'),name=headers.indexOf('名称');
    if(kind==='excluded'&&status<0)throw Error('未回关文件需要“状态”列');
    // Avoid interpreting an exclusion list as the complete following list.
    if(kind==='following'&&rows.length&&status>=0&&rows.every(r=>r[status]?.trim()==='未回关'))throw Error('这看起来是未回关名单，不能作为完整关注名单');
    const result=new Map();
    for(let n=0;n<rows.length;n++){
      const r=rows[n];if(kind==='excluded'&&r[status]?.trim()!=='未回关')continue;
      const handle=(r[index]||'').trim().replace(/^@/,'');
      if(!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw Error(`第 ${n+2} 行用户名无效`);
      result.set(handle.toLowerCase(),{handle,name:name>=0?r[name]||handle:handle});
    }
    return [...result.values()];
  }
  function match(following,excluded){const deny=new Set(excluded.map(x=>x.handle.toLowerCase()));return following.filter(x=>!deny.has(x.handle.toLowerCase()))}
  function csv(items,kind){const quote=x=>'"'+String(x).replace(/"/g,'""')+'"';const excluded=kind==='excluded';return '\uFEFF用户名,主页'+(excluded?',状态':'')+'\r\n'+items.map(x=>[quote('@'+x.handle),quote('https://x.com/'+x.handle),...(excluded?[quote('未回关')]:[])].join(',')).join('\r\n')}
  const api={parseCSV,read,match,csv};if(typeof module!=='undefined')module.exports=api;else root.Roster=api;
})(globalThis);
