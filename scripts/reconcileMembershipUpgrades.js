// 預設唯讀；--apply 才會升級、登記新制福利並在消費福利頻道補播。
// 不加總或覆寫消費、不扣款、不補發已領過的同級福利。
const { spawnSync } = require('node:child_process');
const { Client,GatewayIntentBits,Events,EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { MEMBERSHIP_LEVELS,getMembershipPromotion } = require('../config/qiunaiMembership20261016');
const { createVipRewardCoordinator } = require('../utils/vipRewardDelivery');
const { sendVipChannelDelivery,VIP_CHANNEL_ID } = require('../utils/vipChannelDelivery');
const GUILD = '1206138511535898654';
async function main() {
  throw new Error('此全量歷史補發腳本已停用；請使用唯讀 scripts/auditVipUpgradesSince20261010.js 核對指定期間，不可依舊累積套用新門檻');
  // 使用者已明確限縮為 10/10 起實際交易造成的漏升級，不能再跑全量累積補發。
  if (process.argv.includes('--apply')) throw new Error('已停用全量歷史補發：只能核對 2026-10-10 起實際跨越當時門檻的交易，不得重發原有會員福利');
  let env=process.env;
  if (process.argv.includes('--railway-env')) {
    const result=spawnSync('/Users/moxu/.npm/_npx/d991ede4b4a6395c/node_modules/@railway/cli/bin/railway',['variables','--json'],{encoding:'utf8'});
    if(result.status) throw Error('無法讀取正式環境');
    env=JSON.parse(result.stdout);
  }
  const apply=process.argv.includes('--apply');
  const supabase=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_KEY);
  const client=new Client({intents:[GatewayIntentBits.Guilds]});
  try {
    const ready=new Promise(resolve=>client.once(Events.ClientReady,resolve));
    await client.login(env.DISCORD_TOKEN||env.TOKEN||env.BOT_TOKEN);await ready;
    const guild=await client.guilds.fetch(GUILD);
    const channel=await client.channels.fetch(VIP_CHANNEL_ID);
    if(channel.guildId!==GUILD||!channel.isTextBased())throw Error('補發頻道不正確');
    const users=await supabase.from('user_vips').select('*').eq('guild_id',GUILD);
    if(users.error)throw users.error;
    const baseline=await supabase.from('qiunai_membership_grandfather_20261016').select('user_id,previous_state').eq('guild_id',GUILD);
    const claims=await supabase.from('vip_upgrade_logs').select('user_id,new_level_key').eq('guild_id',GUILD);
    const operations=await supabase.from('bot_vip_reward_operations').select('user_id,level_key,delivery_status').eq('guild_id',GUILD);
    for(const result of [baseline,claims,operations])if(result.error)throw result.error;
    const original=new Map(baseline.data.map(x=>[x.user_id,x.previous_state]));
    const summary={apply,channel:channel.id,candidates:0,left:0,promoted:0,operations:0,completed:0,failed:[]};
    for(const initial of users.data){
      // 以切換前等級界定新權益，確保升級後若中斷仍可安全補完剩餘級別。
      const base=original.get(initial.user_id);
      const promotion=getMembershipPromotion({totalSpent:Number(initial.total_spent||0),highestSingleTopup:Number(initial.highest_single_topup||0),currentLevelKey:base?.level_key||null});
      const outstanding=promotion.newlyCrossed.filter(l=>{
        const op=operations.data.find(x=>x.user_id===initial.user_id&&x.level_key===l.levelKey);
        return op ? op.delivery_status!=='completed' : !claims.data.some(x=>x.user_id===initial.user_id&&x.new_level_key===l.levelKey);
      });
      const currentRank=MEMBERSHIP_LEVELS.find(l=>l.levelKey===initial.level_key)?.sortOrder||0;
      if(!outstanding.length&&(!promotion.level||promotion.level.sortOrder<=currentRank))continue;
      summary.candidates++;
      let member;
      try{member=await guild.members.fetch(initial.user_id);}catch(error){if(Number(error.code)===10007){summary.left++;continue;}throw error;}
      console.log(JSON.stringify({candidate:initial.user_id,from:initial.level_key,to:promotion.level.levelKey,present:true,tiers:promotion.newlyCrossed.map(l=>l.levelKey)}));
      if(!apply)continue;
      try {
        const promoted=await supabase.rpc('qiunai_promote_vip_level',{p_guild_id:GUILD,p_user_id:initial.user_id,p_level_key:promotion.level.levelKey});
        if(promoted.error)throw promoted.error;
        summary.promoted++;
        const current=await supabase.from('user_vips').select('level_key').eq('guild_id',GUILD).eq('user_id',initial.user_id).single();
        if(current.error)throw current.error;
        const target=MEMBERSHIP_LEVELS.find(l=>l.levelKey===current.data.level_key);
        await member.roles.add(target.roleId);
        // 不刪更高身分或人工邀請級別；不因補發低級福利降級。
        for(const lower of MEMBERSHIP_LEVELS.filter(l=>!l.invitationOnly&&l.sortOrder<target.sortOrder&&member.roles.cache.has(l.roleId)))await member.roles.remove(lower.roleId);
        const coordinator=createVipRewardCoordinator({supabase,deliver:async reward=>{
          const tickets=await supabase.rpc('qiunai_issue_membership_upgrade_tickets',{p_user_id:initial.user_id,p_level_key:reward.level_key});
          if(tickets.error)throw tickets.error;
          const entitlement=await supabase.from('qiunai_membership_upgrade_entitlements').upsert({guild_id:GUILD,user_id:initial.user_id,
            level_key:reward.level_key,benefits:reward.reward_note||'會員公告權益'}, {onConflict:'guild_id,user_id,level_key',ignoreDuplicates:true});
          if(entitlement.error)throw entitlement.error;
          const embed=new EmbedBuilder().setColor('#ffd700').setTitle('✨ VIP 達標補升級／福利補登記')
            .setDescription(`<@${initial.user_id}> 已達 **${reward.level_name}** 門檻，已補齊等級身分及本級福利領取資格。\n抽獎券已發至「我的背包」，請聯繫客服核銷兌用；客製福利已列待辦，尚未履約。`)
            .addFields({name:'本級權益',value:String(reward.reward_note||'請見會員公告').slice(0,900)})
            .setTimestamp();
          if(tickets.data?.tickets?.length)embed.addFields({name:'🎟️ 已補發至背包',value:tickets.data.tickets.map(x=>`${x.name} × ${x.count}`).join('\n')});
          await sendVipChannelDelivery({supabase,client,reward,embed});
        }});
        for(const level of outstanding){
          const result=await coordinator.applyAndDeliver({p_guild_id:GUILD,p_user_id:initial.user_id,p_level_key:level.levelKey,p_old_level_key:initial.level_key,
            p_trigger_type:Number(initial.total_spent||0)>=level.totalSpendRequired?'spend':'topup',
            p_trigger_amount:Number(initial.total_spent||0)>=level.totalSpendRequired?initial.total_spent:initial.highest_single_topup,p_reward_coupons:[]});
          summary.operations++;if(result.state==='completed')summary.completed++;
        }
      }catch(error){summary.failed.push({user:initial.user_id,error:String(error.message).slice(0,250)});}
    }
    console.log('SUMMARY',JSON.stringify(summary));
    if(summary.failed.length)process.exitCode=1;
  } finally {client.destroy();}
}
main().catch(error=>{console.error(String(error.message||error).slice(0,300));process.exitCode=1;});
