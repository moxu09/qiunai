const { createHash } = require('node:crypto');
const ORG = 'qiunai:cashback-groups';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0,24);
const cents = value => Math.round(Number(value || 0) * 100);
function snapshot(orders, awards) {
  const eligible = orders.filter(o => o.paid && o.status === 'completed' && !o.is_deleted);
  const ids = new Set(eligible.map(o => o.id));
  const rows = awards.filter(a => ids.has(a.order_id) && !a.reversed_at).sort((a,b)=>a.order_id.localeCompare(b.order_id));
  return { rows, points:rows.reduce((n,a)=>n+cents(a.points),0)/100,
    debt:rows.reduce((n,a)=>n+cents(a.debt_repaid),0)/100,
    recipients:new Set(eligible.filter(o=>rows.some(a=>a.order_id===o.id)).map(o=>o.assigned_player).filter(Boolean)).size,
    signature:hash(JSON.stringify(rows.map(a=>[a.order_id,a.points,a.debt_repaid]))) };
}
function groupMessage(data, marker) {
  return `🌧️ 小奈｜打賞消費回饋\n本筆打賞共 ${data.recipients} 位受賞人、${data.rows.length} 筆明細，已合併通知。\n` +
    `消費回饋共 ${data.points} 點` + (data.debt ? `（抵扣先前退單欠點 ${data.debt} 點）` : '') +
    `，本筆實際入帳 ${Math.round((data.points-data.debt)*100)/100} 點。\n` +
    `可到 <#1513531969315537096> 按「我的消費點數」查詢可用餘額及異動。\n${marker}`;
}
function createGroupedCashbackNotifier(db, client, logger=console) {
  const table=()=>db.from('bot_service_order_flows');
  const scoped=(q,key)=>q.eq('organization_code',ORG).eq('flow_id',key);
  return async function notify(order) {
    const key=hash(`${order.guild_id}:${order.customer_id}:${order.order_group_id}`);
    const result=await db.from('play_orders').select('id,paid,status,is_deleted,assigned_player,created_at')
      .eq('guild_id',order.guild_id).eq('customer_id',order.customer_id).eq('order_type','打賞')
      .eq('order_group_id',order.order_group_id);
    if(result.error) throw result.error;
    const orders=result.data||[];
    // Allow sequential recipient inserts and their award triggers to settle before the first notification.
    if(orders.some(o=>!o.created_at || Date.now()-Date.parse(o.created_at.endsWith('Z')?o.created_at:o.created_at+'Z')<60000)) return false;
    const awards=[];
    for(let offset=0;offset<orders.length;offset+=100){
      const r=await db.from('qiunai_membership_cashbacks').select('*').eq('user_id',order.customer_id)
        .in('order_id',orders.slice(offset,offset+100).map(o=>o.id));
      if(r.error) throw r.error; awards.push(...r.data||[]);
    }
    const data=snapshot(orders,awards); if(!data.rows.length) return false;
    const inserted=await table().insert({organization_code:ORG,flow_id:key,payload:{},expires_at:'2099-01-01T00:00:00Z'});
    if(inserted.error && inserted.error.code!=='23505') throw inserted.error;
    const current=await scoped(table().select('*'),key).single(); if(current.error) throw current.error;
    const row=current.data, prior=row.payload||{};
    if(prior.signature===data.signature || Date.parse(prior.leaseUntil||'')>Date.now()) return false;
    const revision=Number(row.revision)+1;
    const payload={...prior,leaseUntil:new Date(Date.now()+300000).toISOString()};
    const claim=await scoped(table().update({payload,revision}),key).eq('revision',row.revision).select('revision').maybeSingle();
    if(claim.error) throw claim.error; if(!claim.data) return false;
    const finish=async patch=>{
      const r=await scoped(table().update({payload:{...payload,...patch,leaseUntil:null},updated_at:new Date().toISOString()}),key).eq('revision',revision);
      if(r.error) throw r.error;
    };
    try {
      const legacy=[];
      for(let offset=0;offset<data.rows.length;offset+=100){
        const r=await table().select('flow_id,payload,closed_at').eq('organization_code','qiunai:cashback-notifications:receipts')
          .in('flow_id',data.rows.slice(offset,offset+100).map(a=>`cashback-completed:${a.order_id}`));
        if(r.error) throw r.error; legacy.push(...r.data||[]);
      }
      // Previously delivered batches remain quiet when this feature is deployed.
      if(!prior.messageId && !prior.signature && legacy.filter(r=>r.closed_at).length===data.rows.length){
        await finish({signature:data.signature,status:'legacy_delivered',messageId:legacy.find(r=>r.payload?.messageId)?.payload.messageId||null}); return false;
      }
      const channel=await (await client.users.fetch(order.customer_id)).createDM();
      let message;
      const messageId=prior.messageId||legacy.find(r=>r.payload?.messageId)?.payload.messageId;
      if(messageId) { try {message=await channel.messages.fetch(messageId);} catch(e){if(Number(e.code)!==10008) throw e;} }
      const marker=`回饋編號：打賞-${key}`;
      if(!message){
        let before;
        for(let page=0;page<50;page++){
          const history=await channel.messages.fetch({limit:100,...(before?{before}:{})});
          message=history.find(m=>m.author?.id===client.user.id && m.content?.endsWith(marker));
          if(message||history.size<100) break;
          before=history.last().id;
          if(page===49) throw Error('通知歷史尚未查完，暫緩寄送避免重複');
        }
      }
      const content=groupMessage(data,marker);
      if(message) {if(message.content!==content) await message.edit({content,allowedMentions:{parse:[]}});}
      else message=await channel.send({content,allowedMentions:{parse:[]},nonce:key,enforceNonce:true});
      await finish({signature:data.signature,status:'sent',messageId:message.id}); return true;
    } catch(e){
      await finish({...(Number(e.code)===50007?{signature:data.signature}:{}),status:Number(e.code)===50007?'dm_blocked':'retry',error:String(e.message).slice(0,300)});
      logger.error('[合併消費回饋通知]',key,e.message); return false;
    }
  };
}
module.exports={snapshot,groupMessage,createGroupedCashbackNotifier};
