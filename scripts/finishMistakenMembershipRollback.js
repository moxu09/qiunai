// 僅處理已封存、使用者授權撤回的唯一誤補批次。沒有發獎或付款程式。
const {spawnSync}=require('node:child_process');
const {REST,Routes}=require('discord.js');
const {createClient}=require('@supabase/supabase-js');
const {MEMBERSHIP_LEVELS}=require('../config/qiunaiMembership20261016');
const BATCH='mistaken-backfill-20261016', GUILD='1206138511535898654';
async function main(){
 const run=spawnSync('/Users/moxu/.npm/_npx/d991ede4b4a6395c/node_modules/@railway/cli/bin/railway',['variables','--json'],{encoding:'utf8'});
 if(run.status)throw Error('讀取環境失敗');const env=JSON.parse(run.stdout);
 const s=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_KEY);
 const rest=new REST().setToken(env.DISCORD_TOKEN||env.TOKEN||env.BOT_TOKEN);
 const q=await s.from('qiunai_membership_backfill_rollback').select('*').eq('batch_id',BATCH).single();
 if(q.error||!q.data?.db_completed_at)throw Error('資料庫尚未完成封存撤回，禁止更動 Discord');
 const data=q.data.payload;
 if(data.members.length!==95||data.deliveries.length!==102||data.items.length!==122)throw Error('封存數量不符');
 const me=await rest.get(Routes.user('@me'));
 async function save(){const r=await s.from('qiunai_membership_backfill_rollback').update({payload:data}).eq('batch_id',BATCH);if(r.error)throw r.error;}
 if(!data.discord_before){
  const backup={roles:[],messages:[],already_absent:[]};
  for(const m of data.members){const member=await rest.get(Routes.guildMember(GUILD,m.user_id));backup.roles.push({user_id:m.user_id,roles:member.roles});}
  for(const d of data.deliveries){
   try{const message=await rest.get(Routes.channelMessage(d.channel_id,d.message_id));
    const footer=`VIP:${GUILD}:${d.user_id}:${d.level_key}`;
    if(message.author?.id!==me.id||!message.embeds?.some(e=>e.footer?.text===footer))throw Error('訊息不是此誤補批次，停止撤回');
    backup.messages.push({channel_id:d.channel_id,message});
   }catch(e){if(Number(e.code)===10008)backup.already_absent.push(d.message_id);else throw e;}
  }
  data.discord_before=backup;await save();
  console.log(JSON.stringify({backupRoles:backup.roles.length,backupNotices:backup.messages.length,alreadyDeleted:backup.already_absent.length}));
 }
 data.discord_role_results=data.discord_role_results||[];data.discord_message_results=data.discord_message_results||[];
 for(const m of data.members){
  if(data.discord_role_results.includes(m.user_id))continue;
  const current=await s.from('user_vips').select('level_key').eq('guild_id',GUILD).eq('user_id',m.user_id).single();
  if(current.error)throw current.error;
  if(current.data.level_key!==m.original_level_key){
   // 撤回期間出現真實新付款：依新領獎紀錄及實際付款交叉查證，不降掉這次正式升級。
   const log=await s.from('vip_upgrade_logs').select('new_level_key,trigger_type,trigger_amount,created_at')
    .eq('guild_id',GUILD).eq('user_id',m.user_id).eq('new_level_key',current.data.level_key).gte('created_at',q.data.db_completed_at);
   const orders=await s.from('play_orders').select('id,price,final_price,status,is_deleted,paid_at')
    .eq('guild_id',GUILD).eq('customer_id',m.user_id).eq('paid',true).gte('paid_at',q.data.db_completed_at);
   if(log.error||orders.error)throw Error('核對期間新升級失敗，停止修改身分組');
   const match=orders.data.find(o=>!o.is_deleted&&!['cancelled','canceled','refunded'].includes(o.status)&&
    log.data.some(l=>l.trigger_type==='spend'&&Number(l.trigger_amount)===Number(o.final_price??o.price)&&new Date(l.created_at)>=new Date(/[zZ]|[+-]\d\d:\d\d$/.test(o.paid_at)?o.paid_at:o.paid_at+'Z')));
   if(!match)throw Error('等級已有其他變動但無法驗證新付款，停止修改身分組：'+m.user_id);
   const protectedRole=MEMBERSHIP_LEVELS.find(x=>x.levelKey===current.data.level_key)?.roleId;
   if(!protectedRole)throw Error('新等級身分組無法核對');
   const member=await rest.get(Routes.guildMember(GUILD,m.user_id));
   if(!member.roles.includes(protectedRole))await rest.put(Routes.guildMemberRole(GUILD,m.user_id,protectedRole),{reason:'保留撤回期間由真實新付款觸發的正式升級'});
   data.protected_upgrades=data.protected_upgrades||[];
   if(!data.protected_upgrades.some(x=>x.user_id===m.user_id))data.protected_upgrades.push({user_id:m.user_id,level_key:current.data.level_key,order_id:match.id});
   if(!data.discord_role_results.includes(m.user_id))data.discord_role_results.push(m.user_id);
   await save();continue;
  }
  const originalRole=MEMBERSHIP_LEVELS.find(x=>x.levelKey===m.original_level_key)?.roleId;
  const member=await rest.get(Routes.guildMember(GUILD,m.user_id));
  if(originalRole&&!member.roles.includes(originalRole))await rest.put(Routes.guildMemberRole(GUILD,m.user_id,originalRole),{reason:'撤回誤補批次，恢復原有會員等級'});
  const mistakenRoles=[...new Set(data.keys.filter(x=>x.user_id===m.user_id).map(x=>x.role_id))].filter(x=>x&&x!==originalRole);
  for(const role of mistakenRoles)if(member.roles.includes(role))await rest.delete(Routes.guildMemberRole(GUILD,m.user_id,role),{reason:'撤回誤補批次，不影響原有福利'});
  const checked=await rest.get(Routes.guildMember(GUILD,m.user_id));
  if((originalRole&&!checked.roles.includes(originalRole))||mistakenRoles.some(x=>checked.roles.includes(x)))throw Error('身分組恢復核對失敗：'+m.user_id);
  if(!data.discord_role_results.includes(m.user_id))data.discord_role_results.push(m.user_id);
  if(data.discord_role_results.length%10===0){await save();console.log('rolesVerified',data.discord_role_results.length);}
 }
 await save();
 for(const item of data.discord_before.messages){
  const id=item.message.id;
  if(data.discord_message_results.includes(id))continue;
  try{await rest.delete(Routes.channelMessage(item.channel_id,id),{reason:'撤回經使用者確認的誤補通知；內容已封存'});}catch(e){if(Number(e.code)!==10008)throw e;}
  data.discord_message_results.push(id);
 }
 await save();
 const finished=await s.from('qiunai_membership_backfill_rollback').update({discord_completed_at:new Date().toISOString()}).eq('batch_id',BATCH);
 if(finished.error)throw finished.error;
 console.log('COMPLETED',JSON.stringify({rolesVerified:data.discord_role_results.length,removedNotices:data.discord_message_results.length,alreadyAbsent:data.discord_before.already_absent.length,archivedTickets:data.items.length}));
}
main().catch(e=>{console.error(String(e.message||e).slice(0,400));process.exitCode=1;});
