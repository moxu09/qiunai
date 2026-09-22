const test = require("node:test");
const assert = require("node:assert/strict");
const { memberHasRole, interactionHasPermission } = require("../utils/interactionPermissions");
const { createServiceFlowStore } = require("../utils/serviceFlowStore");
const { getOrCreateServiceOrder, createOperationGuard, isUnpaidWaitingOrder } = require("../utils/serviceOrderSafety");

function database() {
  const tables = new Map();
  let sequence = 0;
  return {
    tables,
    from(name) {
      if (!tables.has(name)) tables.set(name, []);
      const rows = tables.get(name), filters = [];
      let mode = "select", value;
      const q = {
        select() { return q; }, insert(v) { mode = "insert"; value = v; return q; },
        update(v) { mode = "update"; value = v; return q; },
        eq(k,v) { filters.push(r => r[k] === v); return q; },
        is(k,v) { filters.push(r => (r[k] ?? null) === v); return q; },
        gt(k,v) { filters.push(r => r[k] > v); return q; },
        async maybeSingle() { return run(); }, async single() { return run(); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve,reject); },
      };
      function run() {
        let row = rows.find(r => filters.every(f => f(r)));
        if (mode === "insert") {
          const duplicate = rows.some(r => name === "play_orders"
            ? r.guild_id === value.guild_id && r.service_flow_key === value.service_flow_key
            : r.organization_code === value.organization_code && r.flow_id === value.flow_id);
          if (duplicate) return { error: { code: "23505" }, data: null };
          row = { id: `row-${++sequence}`, ...structuredClone(value) }; rows.push(row);
        } else if (mode === "update" && row) Object.assign(row, structuredClone(value));
        return { data: row ? structuredClone(row) : null, error: null };
      }
      return q;
    },
  };
}

test("權限接受 raw/cached 成員與管理員 bitfield，缺資料不授權", () => {
  assert.equal(memberHasRole({ roles: ["staff"] }, "staff"), true);
  assert.equal(memberHasRole({ roles: { cache: new Map([["staff", true]]) } }, "staff"), true);
  assert.equal(memberHasRole(null,"staff"), false);
  assert.equal(memberHasRole({roles:["player"]},"staff"), false);
  for (const raw of ["8", 8n, {has: () => true}]) {
    assert.equal(interactionHasPermission({ member: {permissions:raw}},8n),true);
  }
  for (const raw of [undefined,null,"bad","0"]) assert.equal(interactionHasPermission({member:{permissions:raw}},8n),false);
});

test("流程保存後換新 store 仍可讀取，資料按店隔離", async () => {
  const db=database(), a=createServiceFlowStore(db), b=createServiceFlowStore(db);
  await a.set("flow",{customerId:"customer",quotedPrice:500});
  assert.deepEqual(await b.get("flow"),{customerId:"customer",quotedPrice:500});
  assert.equal(await createServiceFlowStore(db,{organization:"deepnight"}).get("flow"),undefined);
});

test("同時更改流程只能一份成功，結束流程不可被舊按鈕復活", async () => {
  const db=database(), a=createServiceFlowStore(db);
  await a.set("flow",{quotedPrice:500});
  const first=await a.get("flow"), stale=await a.get("flow");
  first.quotedPrice=600; await a.set("flow",first);
  stale.quotedPrice=700; await assert.rejects(a.set("flow",stale),/已更新/);
  await a.delete("flow");
  assert.equal(await a.get("flow"),undefined);
  await assert.rejects(a.set("flow",first),/已更新/);
  await assert.rejects(a.set("flow",{quotedPrice:1}),/已更新/);
});

test("過期與資料庫失敗不會退回舊記憶體資料", async () => {
  let now=0; const db=database(), a=createServiceFlowStore(db,{now:()=>now});
  await a.set("flow",{x:1}); now=24*3600e3+1;
  assert.equal(await a.get("flow"),undefined);
  const bad={from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({error:{message:"offline"}})})};
  await assert.rejects(createServiceFlowStore(bad).get("flow"),/無法讀取/);
});

test("兩個並行建單及重試只得到原單，分單用各自唯一 key", async () => {
  const db=database(); let n=0;
  const p={guild_id:"guild",service_flow_key:"flow:single",status:"waiting_payment",paid:false,customer_id:"customer",channel_id:"channel",final_price:500,payment_method:"儲值卡"};
  const create=payload=>getOrCreateServiceOrder(db,payload,async()=>`ORD-${++n}`);
  const [a,b]=await Promise.all([create(p),create(p)]);
  assert.equal(a.id,b.id);assert.equal(db.tables.get("play_orders").length,1);
  assert.equal((await create(p)).id,a.id);
  await create({...p,service_flow_key:"split:娛樂"});await create({...p,service_flow_key:"split:技術"});
  assert.equal(db.tables.get("play_orders").length,3);
  await assert.rejects(create({...p,final_price:600}),/原付款訊息/);
  db.tables.get("play_orders")[0].paid=true;
  await assert.rejects(create(p),/已有付款/);
});

test("同一訂單操作互斥，失敗後可重試，獨立訂單不受阻", async () => {
  const guard=createOperationGuard();let release;
  const first=guard("one",()=>new Promise(r=>{release=r}),()=>"busy");
  assert.equal(await guard("one",()=>"duplicate",()=>"busy"),"busy");
  assert.equal(await guard("two",()=>"independent",()=>"busy"),"independent");
  release("ok");assert.equal(await first,"ok");
  await assert.rejects(guard("one",()=>{throw Error("failed")},()=>"busy"),/failed/);
  assert.equal(await guard("one",()=>"retry",()=>"busy"),"retry");
});

test("付款取消只接受尚未付款且尚未完成的訂單", () => {
  for(const status of ["quoted","waiting_payment","waiting_confirm"]) assert.equal(isUnpaidWaitingOrder({status,paid:false}),true);
  for(const status of ["cancelled","completed","accepted","pending",null]) assert.equal(isUnpaidWaitingOrder({status,paid:false}),false);
  assert.equal(isUnpaidWaitingOrder({status:"waiting_payment",paid:true}),false);
  assert.equal(isUnpaidWaitingOrder({status:"waiting_payment",paid:false,is_deleted:true}),false);
});

test("實際客服回呼在重按時不再派單，已付款取消亦不改狀態", async () => {
  const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
  const filename = path.join(__dirname,"..","events","dispatchSystem.js");
  const loaded = new Module(filename,module);
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename,"utf8") + `
    module.exports.__test = {transitionServicePayment, wire(db,effects) {
      supabase=db;
      paymentHelpers={countOrderVipSpentOnce:async()=>{effects.spends++}};
      paidOrderDispatcher=async()=>{
        effects.dispatches++;
        effects.panels++;
        db.markDispatched?.();
        return {state:"dispatched"};
      };
    }};`,filename);
  const api=loaded.exports.__test,effects={spends:0,dispatches:0,panels:0};
  const row={id:"order",status:"waiting_payment",paid:false};
  api.wire({
    markDispatched(){row.dispatch_status="dispatched"},
    rpc:async(_name,args)=>{
      if(!isUnpaidWaitingOrder(row))return {data:[],error:null};
      if(args.p_action==="cancel")row.status="cancelled";
      else {row.status="pending";row.paid=true;row.dispatch_status="pending";}
      return {data:[{...row}],error:null};
    },
    from(){
      const query={
        select(){return query},eq(){return query},
        then(resolve,reject){return Promise.resolve({data:[{...row}],error:null}).then(resolve,reject)},
      };
      return query;
    },
  },effects);
  let closed=0;
  const interaction=()=>({customId:"confirm_order",user:{id:"staff"},guildId:"guild",
    member:{permissions:"8",roles:[]},deferReply:async()=>{},editReply:async p=>p,
    message:{edit:async()=>{closed++}},channel:{send:async()=>{}}});
  await api.transitionServicePayment(interaction(),"confirm_",false,"confirm");
  const duplicate=await api.transitionServicePayment(interaction(),"confirm_",false,"confirm");
  const cancellation=await api.transitionServicePayment(interaction(),"confirm_",false,"cancel");
  assert.deepEqual(effects,{spends:1,dispatches:1,panels:1});
  assert.equal(closed,3);assert.equal(row.paid,true);assert.equal(row.status,"pending");
  assert.match(duplicate.content,/沒有重複/);assert.match(cancellation.content,/退款流程/);
  row.paid=false;row.status="waiting_payment";
  await api.transitionServicePayment(interaction(),"confirm_",false,"cancel");
  assert.equal(row.status,"cancelled");assert.equal(effects.dispatches,1);
});
