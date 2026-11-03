// Builds a rollback-only integration test using copies of production schemas and claim functions.
// This script never connects to or mutates a database.
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..'),schema='red_packet_expiry_test_20261102';
let sql=`begin;create schema ${schema};\n`;
for(const table of ['users','wallet_logs','red_packets','red_packet_claims']){
 sql+=`create table ${schema}.${table}(like public.${table} including all);\n`;
 if(table!=='users')sql+=`alter table ${schema}.${table} alter column id drop identity if exists;create sequence ${schema}.${table}_local_seq;alter table ${schema}.${table} alter column id set default nextval('${schema}.${table}_local_seq'::regclass);\n`;
}
sql+=`do $copy$ declare fname text;src text;begin
foreach fname in array array['claim_prepared_red_packet_atomic','claim_red_packet_safe'] loop
src:=replace(pg_get_functiondef(to_regprocedure('public.'||fname||'(bigint,text)')),'public.','${schema}.');execute src;
execute format('alter function ${schema}.%I(bigint,text) set search_path = ${schema}',fname);
end loop;end $copy$;\n`;
sql+=fs.readFileSync(path.join(root,'supabase/migrations/20261102050000_qiunai_red_packet_expiry.sql'),'utf8').replace('begin;\n','').replace(/commit;\s*$/,'').replace("notify pgrst,'reload schema';",'').replaceAll('public.',schema+'.').replaceAll('search_path=public','search_path='+schema)+'\n';
sql+=fs.readFileSync(path.join(root,'test/sql/redPacketExpiryCases.sql'),'utf8').replaceAll('create function test_fail_log()',`create function ${schema}.test_fail_log()`).replaceAll('execute function test_fail_log()',`execute function ${schema}.test_fail_log()`).replaceAll('public.',schema+'.')+'\nrollback;\n';
fs.writeFileSync(process.argv[2]||'/private/tmp/red-packet-expiry-live-isolated.sql',sql);
