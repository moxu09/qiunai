// Presentation-only repair. Never updates orders, salaries, approval, or wallets.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { REST, Routes } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { buildUpdatedReportEmbed } = require('../events/workReportSystem');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const rest = new REST({version:'10'}).setToken(process.env.TOKEN);
const apply = process.argv.includes('--apply');
const since = '2026-10-20T16:00:00Z';
function completedMeta(row) {
  try {
    const meta = JSON.parse(row.admin_note || '{}');
    const minutes = (meta.segments || []).reduce((s,x)=>s+Number(x.minutes||0),0);
    if (!meta.endedAt || meta.pendingSegmentStart ||
      (!meta.closedEarly && minutes < Number(meta.expectedDurationMinutes||0))) return null;
    return meta;
  } catch { return null; }
}
(async()=>{
  const me = await rest.get(Routes.user('@me'));
  const rows=[];
  for(let page=0;;page+=1000) {
    const {data,error}=await db.from('qiunai_salary_orders')
      .select('id,discord_id,status,admin_note,created_at').like('order_id','WORK-%')
      .eq('status','工時待審核').gte('created_at',since).order('id').range(page,page+999);
    if(error)throw error;rows.push(...data);if(data.length<1000)break;
  }
  const candidates=rows.map(row=>({row,meta:completedMeta(row)})).filter(x=>x.meta);
  const channelCache=new Map(), plans=[],skipped=[];
  for(const {row,meta} of candidates) {
    const {data:staff,error}=await db.from('qiunai_staff').select('salary_channel_id').eq('discord_id',row.discord_id).maybeSingle();
    if(error)throw error;
    const channelId=staff?.salary_channel_id;
    if(!channelId){skipped.push({id:row.id,reason:'no_channel'});continue;}
    if(!channelCache.has(channelId)) {
      try{channelCache.set(channelId,await rest.get(Routes.channelMessages(channelId),{query:new URLSearchParams({limit:'100'})}));}
      catch(error){skipped.push({id:row.id,reason:`channel_${error.code||error.status}`});continue;}
    }
    const matches=channelCache.get(channelId).filter(m=>m.author.id===me.id&&m.components?.some(r=>r.components?.some(b=>b.custom_id===`work_report_add_${row.id}`)));
    if(matches.length!==1){skipped.push({id:row.id,reason:`panel_matches_${matches.length}`});continue;}
    const message=matches[0];
    if(message.embeds[0]?.title?.endsWith('｜已結束'))continue;
    plans.push({row,meta,channelId,message,payload:{
      content:`<@${row.discord_id}> ✅ 本筆服務已結束，工時已送交薪資後台審核。`,
      embeds:[buildUpdatedReportEmbed(message,meta).toJSON()],
      allowed_mentions:{parse:[]},
    }});
  }
  const dir=path.resolve('outputs/work-report-display-20261021');fs.mkdirSync(dir,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  fs.writeFileSync(path.join(dir,`${stamp}-${apply?'apply':'dry-run'}.json`),JSON.stringify({since,plans,skipped},null,2));
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',candidateReports:candidates.length,panelsToUpdate:plans.length,skipped}));
  if(!apply)return;
  let updated=0;
  for(const p of plans) {
    const {data:current,error}=await db.from('qiunai_salary_orders').select('status,admin_note').eq('id',p.row.id).single();
    if(error)throw error;
    if(current.status!==p.row.status||current.admin_note!==p.row.admin_note)continue;
    const message=await rest.get(Routes.channelMessage(p.channelId,p.message.id));
    if(message.edited_timestamp!==p.message.edited_timestamp)continue;
    const result=await rest.patch(Routes.channelMessage(p.channelId,p.message.id),{body:p.payload});
    assert(result.embeds[0].title.endsWith('｜已結束'));
    assert.equal(result.embeds[0].fields.find(f=>f.name==='申報狀態').value,'已結束｜薪資待審核');
    const {data:after,error:verifyError}=await db.from('qiunai_salary_orders').select('status,admin_note').eq('id',p.row.id).single();
    if(verifyError)throw verifyError;
    assert.deepEqual(after,current,'Concurrent report change after panel edit; review audit');
    updated++;
  }
  console.log(JSON.stringify({updated,financialWrites:0,notifications:0}));
})().catch(e=>{console.error(e.message||e);process.exitCode=1;});
