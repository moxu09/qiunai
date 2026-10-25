const {test}=require('node:test');const assert=require('node:assert/strict');
const {findDatedCandidates}=require('../scripts/auditVipUpgradesSince20261010');
const fixture=()=>({users:[{user_id:'old',level_key:null,total_spent:1500,highest_single_topup:10000}],
 baseline:[{user_id:'old',previous_state:{level_key:null,total_spent:1500,highest_single_topup:10000}}],
 claims:[],oldLevels:[{level_key:'vip1',total_spend_required:9999,single_topup_required:9999}],events:[],
 cutover:'2026-10-15T16:44:27.918Z',end:'2026-10-16T01:00:00.000Z'});
test('舊會員舊累積符合新門檻，但期間沒有交易時不能列為補發對象',()=>{assert.deepEqual(findDatedCandidates(fixture()),[]);});
test('十號後實際交易且符合當時門檻，才列待核對；已領取不重發',()=>{
 const f=fixture();f.events=[{user_id:'old',at:'2026-10-12T01:00:00.000Z'}];assert.equal(findDatedCandidates(f).length,1);
 f.claims=[{user_id:'old',new_level_key:'vip1'}];assert.deepEqual(findDatedCandidates(f),[]);
});
test('新制當期有效交易及已升級紀錄互相核對，不因舊級別重發',()=>{
 const f=fixture();f.events=[{user_id:'old',at:'2026-10-15T17:00:00.000Z'}];f.claims=[{user_id:'old',new_level_key:'vip0'},{user_id:'old',new_level_key:'vip1'},{user_id:'old',new_level_key:'vip2'}];
 assert.deepEqual(findDatedCandidates(f),[]);
});
