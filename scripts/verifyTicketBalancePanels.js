// Read-only production verification; credentials remain in process memory.
const {execFileSync}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
async function main(){
 const cli=process.env.RAILWAY_CLI_PATH;
 if(!cli)throw Error('Set RAILWAY_CLI_PATH');
 const env=JSON.parse(execFileSync(cli,['variables','--json'],{encoding:'utf8'}));
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
 const {data,error}=await db.from('panel_messages').select('panel_name,channel_id,message_id')
  .eq('guild_id','1206138511535898654').in('panel_name',['gacha','ichiban']);
 if(error)throw error;
 if(data.length!==2)throw Error('Expected two panel records');
 for(const panel of data){
  const response=await fetch(`https://discord.com/api/v10/channels/${panel.channel_id}/messages/${panel.message_id}`,{headers:{Authorization:`Bot ${env.TOKEN}`}});
  if(!response.ok)throw Error(`Discord panel read failed: ${response.status}`);
  const message=await response.json();
  const wanted=`qticket_balance:${panel.panel_name==='gacha'?'kill':'ichiban'}`;
  const button=message.components.flatMap(row=>row.components).find(x=>x.custom_id===wanted);
  console.log(JSON.stringify({panel:panel.panel_name,channel:panel.channel_id,message:panel.message_id,button:button?.label,enabled:button?!button.disabled:false}));
  if(!button||button.disabled)throw Error(`Missing active ticket balance button: ${panel.panel_name}`);
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
