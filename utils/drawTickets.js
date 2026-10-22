const {randomUUID}=require('node:crypto');
const GUILD='1206138511535898654';
const KILL_TICKETS=['殺比死卡池抽獎券','殺比死卡池抽獎劵','殺必死卡池抽獎券','殺必死卡池抽獎劵'];
const ICHIBAN_TICKETS=['秋奈一番賞抽獎券','秋奈一番賞抽獎劵'];
const LIMITED_TICKETS=['限定卡池抽獎券','限定卡池抽獎劵','限定卡池獎券','限定卡池獎劵'];
async function ticketCount(db,userId,names){
 const q=await db.from('user_items').select('id',{count:'exact',head:true}).eq('user_id',userId)
  .eq('guild_id',GUILD).eq('item_type','ticket').in('item_name',names);
 if(q.error)throw q.error;
 return Number(q.count||0);
}
function parseDrawChoice(id,userId){
 const m=/^qdraw:(\d+):([0-9a-f-]{36}):(\d+):(1|10):(\d+):(\d+)$/.exec(id);
 if(!m||m[1]!==userId)throw Error('這不是你的抽獎選項');
 const choice={requestId:m[2],poolId:Number(m[3]),amount:Number(m[4]),ticketCount:Number(m[5]),price:Number(m[6])};
 if(choice.ticketCount>choice.amount)throw Error('用券張數無效');
 return choice;
}
async function prepareGacha(db,interaction,amount,poolId){
 if(interaction.guildId!==GUILD&&interaction.guild?.id!==GUILD)throw Error('此抽獎入口僅供秋奈使用');
 let query=db.from('gacha_pools').select('*');
 query=poolId?query.eq('id',poolId):query.order('id').limit(1);
 const q=await query;
 if(q.error)throw q.error;
 const pool=q.data?.[0];if(!pool)throw Error('找不到卡池');
 const names=/殺[比必]死/.test(pool.pool_name)?KILL_TICKETS:/限定/.test(pool.pool_name)?LIMITED_TICKETS:null;
 const count=names?await ticketCount(db,interaction.user.id,names):0;
 const ticketLabel=names===LIMITED_TICKETS?'限定卡池':'殺必死卡池';
 const requestId=randomUUID();
 const choice={requestId,poolId:pool.id,amount,ticketCount:0,price:pool.price};
 if(!count)return {choice};
 const use=Math.min(count,amount),cost=(amount-use)*Number(pool.price);
 const id=n=>`qdraw:${interaction.user.id}:${requestId}:${pool.id}:${amount}:${n}:${pool.price}`;
 return {prompt:{content:`🎟️ ${pool.pool_name}｜你有 ${count} 張${ticketLabel}券。\n要使用 ${use} 張券抽 ${amount} 次嗎？使用後另付 ${cost} ASD；不使用則付 ${amount*pool.price} ASD。\n確認後才扣券／扣款；抽獎失敗不消耗。`,
  embeds:[],components:[{type:1,components:[{type:2,style:3,label:`使用 ${use} 張券`,custom_id:id(use)},
   {type:2,style:1,label:'不使用券，錢包付款',custom_id:id(0)},
   {type:2,style:2,label:'取消',custom_id:`qdrawcancel:${interaction.user.id}:${requestId}`}]}]}};
}
function ticketBalanceButton(kind){
 if(!['kill','ichiban','limited'].includes(kind))throw Error('無效的抽獎券類別');
 const {ButtonBuilder}=require('discord.js');
 return new ButtonBuilder({type:2,style:2,label:'🎟️ 查詢抽獎券數量',custom_id:`qticket_balance:${kind}`});
}
async function handleTicketBalance(db,interaction){
 const kind={'qticket_balance:kill':'kill','qticket_balance:ichiban':'ichiban','qticket_balance:limited':'limited'}[interaction.customId];
 if(!kind)return false;
 if((interaction.guildId||interaction.guild?.id)!==GUILD){
  await interaction.reply({content:'此查詢入口僅供秋奈使用。',flags:64});return true;
 }
 await interaction.deferReply({flags:64});
 try{
  const kinds={kill:[KILL_TICKETS,'殺必死卡池'],ichiban:[ICHIBAN_TICKETS,'秋奈一番賞'],limited:[LIMITED_TICKETS,'限定卡池']};
  const counts=await Promise.all(Object.values(kinds).map(([names])=>ticketCount(db,interaction.user.id,names)));
  const count=counts[Object.keys(kinds).indexOf(kind)];
  await interaction.editReply({content:`🎟️ 你目前有 **${count} 張${kinds[kind][1]}抽獎券**。\n\n背包券種明細：\n${Object.values(kinds).map(([,label],i)=>`${label}券：${counts[i]} 張`).join('\n')}\n\n各券僅適用對應卡池／一番賞，不互相混用。請按對應入口的抽獎按鈕，有券時會先詢問是否使用。\n此查詢不會消耗抽獎券或扣款。`,allowedMentions:{parse:[]}});
 }catch{
  await interaction.editReply({content:'暫時無法查詢抽獎券數量，請稍後重試；未消耗抽獎券或扣款。'});
 }
 return true;
}
module.exports={GUILD,KILL_TICKETS,ICHIBAN_TICKETS,LIMITED_TICKETS,ticketCount,parseDrawChoice,prepareGacha,ticketBalanceButton,handleTicketBalance};
