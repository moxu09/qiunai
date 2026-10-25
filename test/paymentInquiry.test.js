const test = require("node:test");
const assert = require("node:assert/strict");
const { monthWindow, getMonthlyPaymentInquiry } = require("../utils/paymentInquiry");
test("台灣跨年、月末與UTC月界正確", () => {
  assert.deepEqual(monthWindow("2026-01-01T00:01:00+08:00", -1), {month:"2025-12",start:"2025-11-30T16:00:00.000Z",end:"2025-12-31T16:00:00.000Z"});
  assert.equal(monthWindow("2026-09-30T16:00:00Z", -1).month, "2026-09");
  assert.equal(monthWindow("2026-03-31T12:00:00+08:00", -1).month, "2026-02");
});
test("查詢隔離群組與顧客，排除退款作廢並讀取所有分頁", async () => {
  const calls=[]; const db={from(table){calls.push(["from",table]);const q={};for(const name of ["select","eq","gte","lt","order"])q[name]=(...args)=>(calls.push([name,...args]),q);q.range=async from=>({data:from===0?Array.from({length:1000},(_,i)=>({id:i,final_price:10})): [{final_price:50,is_deleted:true},{final_price:60,status:"refunded"},{final_price:0,price:99},{price:20}]});return q;}};
  const r=await getMonthlyPaymentInquiry(db,"guild","customer","2026-10-11T00:00:00Z");
  assert.equal(r.amount,10020);assert.equal(r.count,1002);assert.equal(r.orders.length,10);
  assert.ok(calls.some(x=>x[0]==="eq"&&x[1]==="guild_id"&&x[2]==="guild"));
  assert.ok(calls.some(x=>x[0]==="eq"&&x[1]==="customer_id"&&x[2]==="customer"));
});
