const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {formatTaipeiTime}=require('../utils/taipeiTime');
test('UTC、無時區 UTC 與 +08:00 顯示同一台北時間，不加兩次八小時',()=>{
  for(const value of ['2026-10-16T02:30:45Z','2026-10-16T02:30:45.000+00:00','2026-10-16 02:30:45','2026-10-16T02:30:45.000000','2026-10-16T10:30:45+08:00','2026-10-16 02:30:45+00'])
    assert.equal(formatTaipeiTime(value),'2026/10/16 10:30:45（台北時間）');
});
test('跨台灣午夜及月底使用正確日期',()=>{
  assert.equal(formatTaipeiTime('2026-10-31T16:00:00Z'),'2026/11/01 00:00:00（台北時間）');
  assert.equal(formatTaipeiTime('2026-10-31T15:59:59Z'),'2026/10/31 23:59:59（台北時間）');
});
test('空值及壞資料不顯示 1970 或 Invalid Date',()=>{
  for(const value of [null,undefined,'','not a date',new Date('invalid')])assert.equal(formatTaipeiTime(value),'未提供時間');
});
test('不受伺服器作業系統時區影響',()=>{
  const script="process.stdout.write(require('./utils/taipeiTime').formatTaipeiTime('2026-10-16 02:30:45'))";
  for(const TZ of ['UTC','Asia/Taipei','America/Los_Angeles']){
    const result=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'});
    assert.equal(result.status,0);assert.equal(result.stdout,'2026/10/16 10:30:45（台北時間）');
  }
});
