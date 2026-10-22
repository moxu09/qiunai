const {createHmac,timingSafeEqual}=require('node:crypto');
const ORG='qiunai:website-orders',GUILD='1206138511535898654';
function validPayload(value){
  if(!value||!/^WEB-[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(value.requestId)||!/^\d{17,20}$/.test(value.userId))return false;
  const r=value.requirements;
  return r&&['customerName','game','serviceType','quantity'].every(k=>typeof r[k]==='string'&&r[k].trim()&&r[k].length<=80)&&
    ['platform','targetRank','companionRank'].every(k=>typeof r[k]==='string'&&r[k].length<=80)&&
    typeof r.notes==='string'&&r.notes.length<=500&&Number.isInteger(r.companionCount)&&r.companionCount>=1&&r.companionCount<=8;
}
function authenticate(request,body,token,now=Date.now()){
  if(!token)return false;
  const timestamp=request.headers['x-website-time'],signature=request.headers['x-website-signature'];
  if(typeof timestamp!=='string'||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',token).update(`qiunai-website-v1\n${timestamp}\n${request.method}\n${request.url}\n${body}`).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function createWebsiteOrderBridge({db,client,token,createOrder,logger=console}){
  const table=()=>db.from('bot_service_order_flows');
  const scoped=(q,id)=>q.eq('organization_code',ORG).eq('flow_id',id);
  async function read(id){const r=await scoped(table().select('*'),id).maybeSingle();if(r.error)throw r.error;return r.data;}
  const responseData=row=>({status:row.payload.status,channelUrl:row.payload.status==='opened'?`https://discord.com/channels/${GUILD}/${row.payload.channelId}`:undefined});
  async function handleHttpRequest(request,response){
    if(!request.url?.startsWith('/website/orders'))return false;
    const reply=(status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data));return true;};
    let body='';
    for await(const chunk of request){body+=chunk.toString();if(Buffer.byteLength(body)>10000)return reply(413,{error:'payload_too_large'});}
    if(!authenticate(request,body,token))return reply(401,{error:'unauthorized'});
    if(request.method==='GET'&&request.url==='/website/orders/health')return reply(200,{status:'ready'});
    if(request.method==='POST'&&request.url==='/website/orders'){
      let value;try{value=JSON.parse(body);}catch{return reply(400,{error:'invalid_json'});}
      if(!validPayload(value))return reply(400,{error:'invalid_request'});
      let row=await read(value.requestId);
      if(!row){
        const inserted=await table().insert({organization_code:ORG,flow_id:value.requestId,revision:1,
          payload:{...value,status:'queued'},expires_at:new Date(Date.now()+7*86400000).toISOString()});
        if(inserted.error&&inserted.error.code!=='23505')throw inserted.error;
        row=await read(value.requestId);
      }
      if(!row||row.payload.userId!==value.userId||JSON.stringify(row.payload.requirements)!==JSON.stringify(value.requirements))return reply(409,{error:'request_conflict'});
      return reply(200,responseData(row));
    }
    if(request.method==='GET'){
      const url=new URL(request.url,'http://localhost');
      const id=url.pathname.replace('/website/orders/','');
      if(!/^WEB-[0-9A-F-]{36}$/.test(id))return reply(404,{error:'not_found'});
      const row=await read(id);
      if(!row||row.payload.userId!==url.searchParams.get('userId'))return reply(404,{error:'not_found'});
      return reply(200,responseData(row));
    }
    return reply(405,{error:'method_not_allowed'});
  }
  async function processRow(row){
    const p=row.payload;
    if(p.status==='opened'||Date.parse(row.expires_at)<Date.now()||(p.leaseUntil&&p.leaseUntil>Date.now()))return;
    const claim=await scoped(table().update({payload:{...p,status:'processing',leaseUntil:Date.now()+120000},revision:row.revision+1,updated_at:new Date().toISOString()}),row.flow_id).eq('revision',row.revision).select('*').maybeSingle();
    if(claim.error)throw claim.error;if(!claim.data)return;
    let next;
    try{const order=await createOrder(p);next=order?{...p,status:'opened',channelId:order.channelId,orderId:order.orderId}:{...p,status:'waiting_member'};}
    catch(error){logger.error('[官網需求開單]',row.flow_id,String(error.message).slice(0,150));next={...p,status:'retry'};}
    delete next.leaseUntil;
    const saved=await scoped(table().update({payload:next,revision:row.revision+2,updated_at:new Date().toISOString()}),row.flow_id).eq('revision',row.revision+1);
    if(saved.error)throw saved.error;
  }
  let running=false;
  async function recover(userId){
    if(running&&!userId)return;
    if(!userId)running=true;
    try{
      let query=table().select('*').eq('organization_code',ORG).is('closed_at',null).gt('expires_at',new Date().toISOString()).neq('payload->>status','opened').order('updated_at').limit(20);
      if(userId)query=query.eq('payload->>userId',userId);
      const rows=await query;if(rows.error)throw rows.error;
      for(const row of rows.data||[])await processRow(row);
    }finally{if(!userId)running=false;}
  }
  function start(){
    const run=userId=>void recover(userId).catch(e=>logger.error('[官網接單重試]',e.message));
    client.on('guildMemberAdd',m=>{if(m.guild.id===GUILD)run(m.id);});
    client.on('guildMemberUpdate',(old,m)=>{if(m.guild.id===GUILD&&old.pending&&!m.pending)run(m.id);});
    const timer=setInterval(()=>run(),15000);timer.unref?.();run();return timer;
  }
  return {handleHttpRequest,start,recover};
}
module.exports={createWebsiteOrderBridge,authenticate,validPayload};
