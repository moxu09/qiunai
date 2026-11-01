const test=require('node:test');
const assert=require('node:assert/strict');
const packages=require('../config/crownPackages');
const {buildCrownOrderItem,describeCrownPackage}=require('../utils/crownOrders');
const {parseCrownDurationHours,calculateCrownEndAt}=require('../events/workReportSystem');
test('純後綴四方案不附存單、不顯示每日價格，報單沿用正確到期時間',()=>{
 const expected=[[820,24],[2120,72],[4520,168],[15920,720]];
 const rows=packages.filter(p=>p.suffixOnly);assert.equal(rows.length,4);
 for(const [i,p] of rows.entries()){
  assert.deepEqual([p.price,p.durationHours],expected[i]);assert.equal(p.giftedHours,0);assert.equal(p.custom,false);
  const text=describeCrownPackage(p);assert.match(text,/不含存單/);assert.doesNotMatch(text,/\/天|706|645|530/);
  const item=buildCrownOrderItem({...p,crownName:p.name,changeSuffixes:true,staffSuffix:'專屬'});
  assert.match(item,/不含存單/);assert.doesNotMatch(item,/贈送還單/);assert.match(item,/專屬/);
  const hours=parseCrownDurationHours(item);assert.equal(hours,p.durationHours);
  assert.equal(calculateCrownEndAt('2026-11-02T00:00:00Z',hours).getTime()-Date.parse('2026-11-02T00:00:00Z'),hours*3600000);
 }
 assert.equal(new Set(packages.map(p=>p.key)).size,packages.length);
});
