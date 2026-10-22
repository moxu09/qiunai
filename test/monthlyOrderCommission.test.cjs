const assert = require("node:assert/strict");
const test = require("node:test");
const { getMonthlyOrderAmount } = require("../utils/creditedSalaryCommission");
function client(entries) {
  return { from(table) {
    assert.equal(table, "qiunai_salary_orders");
    let rows = entries;
    const q = {
      select() { return q; },
      eq(k,v) { rows = rows.filter(r=>r[k]===v); return q; },
      or() { rows = rows.filter(r=>r.is_deleted!==true); return q; },
      gte(k,v) { rows = rows.filter(r=>r[k]>=v); return q; },
      lt(k,v) { rows = rows.filter(r=>r[k]<v); return q; },
      order() { return q; },
      async range(a,b) { return {data:rows.slice(a,b+1),error:null}; },
    }; return q;
  }};
}
const row = (amount, at, extra={}) => ({discord_id:"staff",order_amount:amount,
  order_finished_at:at,status:"未入帳",service_name:"特戰",is_deleted:false,...extra});
test("monthly order amount includes completed unpaid orders and tips but excludes drafts and deleted orders",async()=>{
  const db=client([
    row(9000,"2026-09-01T00:00:00Z"),row(1000,"2026-09-30T15:59:59Z",{status:"未發薪",service_name:"打賞：禮物"}),
    row(90000,"2026-09-30T16:00:00Z"),row(90000,"2026-08-31T15:59:59Z"),
    row(90000,"2026-09-10T00:00:00Z",{status:"工時待審核"}),
    row(90000,"2026-09-10T00:00:00Z",{status:"工時待填"}),
    row(90000,"2026-09-10T00:00:00Z",{is_deleted:true}),
    row(90000,"2026-09-10T00:00:00Z",{discord_id:"other"}),
    row(90000,"2026-09-10T00:00:00Z",{status:"已取消"}),
  ]);
  assert.equal(await getMonthlyOrderAmount(db,"staff","2026-10-01T00:00:00+08:00",-1),10000);
  assert.equal(await getMonthlyOrderAmount(db,"staff","2026-11-01T00:00:00+08:00",-1),90000);
  assert.equal(await getMonthlyOrderAmount(db,"staff","2026-12-01T00:00:00+08:00",-1),0);
});
test("order amount calculation reads every page",async()=>{
  const rows=Array.from({length:1001},()=>row(10,"2026-09-15T00:00:00Z"));
  assert.equal(await getMonthlyOrderAmount(client(rows),"staff","2026-10-01T00:00:00+08:00",-1),10010);
});
