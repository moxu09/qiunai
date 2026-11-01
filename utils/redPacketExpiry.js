const {createHash} = require('node:crypto');
const {EmbedBuilder} = require('discord.js');
const RED_PACKET_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PERMANENT_DISCORD_ERRORS = new Set([10003,10008,10013,50001,50007,50013,50278]);
function createRedPacketExpiry({supabase,client,guildId,logger=console,intervalMs=60_000}) {
  let running=false,timer=null,lastAdoption=0;
  async function adoptLegacy() {
    const {data,error}=await supabase.from('red_packets').select('id,channel_id,organization_code').is('organization_code',null).eq('status','active').limit(500);
    if(error)throw error;
    const verified=new Map();
    for(const p of data||[]){
      if(!p.channel_id)continue;
      if(!verified.has(p.channel_id)){
        const channel=await client.channels.fetch(String(p.channel_id)).catch(()=>null);
        verified.set(p.channel_id,String(channel?.guildId||channel?.guild?.id||'')===String(guildId));
      }
      if(!verified.get(p.channel_id))continue;
      const r=await supabase.from('red_packets').update({organization_code:'qiunai'}).eq('id',p.id).is('organization_code',null).eq('status','active');
      if(r.error)throw r.error;
    }
  }
  async function notifyPacket(p){
    if(p.message_id && p.channel_id){
      try{
        const channel=await client.channels.fetch(String(p.channel_id));
        const msg=await channel.messages.fetch(String(p.message_id));
        const embed=msg.embeds?.[0]?EmbedBuilder.from(msg.embeds[0]):new EmbedBuilder().setDescription(`紅包編號：${p.packet_no||p.id}`);
        embed.setColor('#999999').setTitle('🧧 星雨紅包｜已到期').setFields({name:'狀態',value:`已超過24小時；未領取的 ${Number(p.refunded_amount).toLocaleString('zh-TW')} 星雨幣已退回發送人。`});
        await msg.edit({embeds:[embed],components:[]});
      }catch(e){if(!PERMANENT_DISCORD_ERRORS.has(Number(e.code)))throw e;}
    }
    if(Number(p.refunded_amount)>0){
      try{
        const user=await client.users.fetch(String(p.sender_id));
        await user.send({embeds:[new EmbedBuilder().setColor('#ffd700').setTitle('🧧 紅包到期退回').setDescription(`紅包 ${p.packet_no||p.id} 已超過24小時。\n未領取的 **${Number(p.refunded_amount).toLocaleString('zh-TW')} 星雨幣**已退回錢包。\n退款後餘額：${Number(p.refund_balance).toLocaleString('zh-TW')} 星雨幣。`)],
          nonce:createHash('sha256').update(`qiunai-red-packet-expiry:${p.id}`).digest('hex').slice(0,24),enforceNonce:true});
      }catch(e){if(!PERMANENT_DISCORD_ERRORS.has(Number(e.code)))throw e;}
    }
    const r=await supabase.from('red_packets').update({expiry_notified_at:new Date().toISOString()}).eq('id',p.id).eq('organization_code','qiunai').is('expiry_notified_at',null);
    if(r.error)throw r.error;
  }
  async function run(){
    if(running)return;running=true;
    try{
      if(Date.now()-lastAdoption>=5*60_000){await adoptLegacy();lastAdoption=Date.now();}
      const {data,error}=await supabase.from('red_packets').select('id').eq('organization_code','qiunai').eq('status','active').lte('expires_at',new Date().toISOString()).order('expires_at').limit(50);
      if(error)throw error;
      for(const p of data||[]){
        const r=await supabase.rpc('qiunai_expire_red_packet',{p_packet_id:p.id});
        if(r.error)logger.error('[紅包到期退款失敗]',{packetId:p.id,code:r.error.code});
      }
      const pending=await supabase.from('red_packets').select('id,packet_no,sender_id,channel_id,message_id,refunded_amount,refund_balance').eq('organization_code','qiunai').not('expired_at','is',null).is('expiry_notified_at',null).order('expired_at').limit(50);
      if(pending.error)throw pending.error;
      for(const p of pending.data||[])await notifyPacket(p).catch(e=>logger.error('[紅包到期通知失敗]',{packetId:p.id,code:e.code||'unknown'}));
    }finally{running=false;}
  }
  function start(){if(timer)return;void run().catch(e=>logger.error('[紅包到期檢查失敗]',{code:e.code||'unknown'}));timer=setInterval(()=>void run().catch(e=>logger.error('[紅包到期檢查失敗]',{code:e.code||'unknown'})),intervalMs);timer.unref?.();}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {run,start,stop,adoptLegacy,notifyPacket};
}
module.exports={createRedPacketExpiry,RED_PACKET_LIFETIME_MS};
