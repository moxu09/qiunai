const test = require("node:test");
const assert = require("node:assert/strict");
const { MEMBERSHIP_LEVELS: levels, getMembershipPromotion, calculateMembershipCashback, compileMembershipPolicy } = require("../config/qiunaiMembership20261016");

test("補上熟稔Lv5、18個級別與正式角色均有公告來源", () => {
  assert.equal(levels.length, 18);
  const level = levels.find(row => row.levelKey === "vip10");
  assert.equal(level.totalSpendRequired, 200000);
  assert.equal(level.singleTopupRequired, 188888);
  assert.equal(level.cashbackPercent, 4);
  assert.equal(level.roleId, "1273529740598444098");
  assert.ok(levels.every(row => row.sourceMessageId && row.description));
});
test("1000入門；任一門檻達標即可，不能把累積儲值誤當單次購幣", () => {
  assert.equal(getMembershipPromotion({totalSpent:999,highestSingleTopup:999}).level,null);
  assert.equal(getMembershipPromotion({totalSpent:1000,highestSingleTopup:0}).level.levelKey,"vip0");
  assert.equal(getMembershipPromotion({totalSpent:0,highestSingleTopup:35000}).level.levelKey,"vip5");
});
test("舊會員保級保留已領福利，僅跨過下一級才有新升級", () => {
  const result=getMembershipPromotion({totalSpent:160000,highestSingleTopup:155555,currentLevelKey:"vip10"});
  assert.equal(result.level.levelKey,"vip10");assert.equal(result.promoted,false);assert.deepEqual(result.newlyCrossed,[]);
  assert.equal(getMembershipPromotion({totalSpent:334420,highestSingleTopup:0,currentLevelKey:"vip10"}).level.levelKey,"vvip1");
  assert.throws(()=>getMembershipPromotion({totalSpent:1,highestSingleTopup:0,currentLevelKey:"unknown"}));
});
test("邀請制絕不因滿額自動授予，已有邀請會員也不自動降級", () => {
  const result=getMembershipPromotion({totalSpent:99999999,highestSingleTopup:99999999});
  assert.equal(result.level.levelKey,"evip");
  const invited=levels.find(row=>row.invitationOnly);
  assert.equal(invited.invitationLimit,20);
  assert.equal(getMembershipPromotion({totalSpent:0,highestSingleTopup:0,currentLevelKey:"exclusive"}).level.levelKey,"exclusive");
});
test("依公告回饋1到7%，多人2%與3%額外回饋，實付零不送點", () => {
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"vip1"}),10);
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"vip10"}),40);
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"vvip2",playerCount:3}),70);
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"vvip3",playerCount:3}),80);
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"evip"}),70);
  assert.equal(calculateMembershipCashback({paidAmount:1000,levelKey:"exclusive"}),50);
  assert.equal(calculateMembershipCashback({paidAmount:0,levelKey:"evip"}),0);
  assert.equal(calculateMembershipCashback({paidAmount:175,levelKey:"vip1"}),1.75);
  assert.equal(calculateMembershipCashback({paidAmount:342,levelKey:"vip4"}),6.84);
});
test("公告缺級或資料不全時停止，不以舊門檻猜測補齊", () => {
  assert.throws(()=>compileMembershipPolicy({roles:[],messages:[]}));
});
test("正式資料表完整版本標記才切換，其他店不套用", () => {
  const { getActiveVipLevels } = require("../config/qiunaiVipPoints");
  const rows=levels.map(level=>({guild_id:"1206138511535898654",level_key:level.levelKey,
    role_id:level.roleId,membership_policy_version:"20261016",reward_points:999}));
  const active=getActiveVipLevels(rows);
  assert.equal(active.find(row=>row.level_key==="vip1").total_spend_required,3000);
  assert.equal(active.find(row=>row.level_key==="vip0").single_topup_required,1000);
  assert.equal(active.find(row=>row.level_key==="exclusive").invitation_only,true);
  assert.ok(active.every(row=>row.reward_points===0&&row.reward_asd===0));
  assert.throws(()=>getActiveVipLevels(rows.slice(1)),/尚未完整/);
  const other=[{guild_id:"other",level_key:"none",membership_policy_version:"20261016"}];
  assert.deepEqual(getActiveVipLevels(other),other);
});
test("原有會員缺少低階發獎紀錄不補領；真正未完成操作仍可重試", () => {
  const { shouldIssueMembershipReward: issue }=require("../config/qiunaiMembership20261016");
  const parameters={level:{sort_order:1},oldSortOrder:10,newSortOrder:11};
  assert.equal(issue(parameters),false);
  assert.equal(issue({...parameters,operationState:"pending"}),true);
  assert.equal(issue({...parameters,operationState:"completed"}),false);
  assert.equal(issue({...parameters,level:{sort_order:11}}),true);
  assert.equal(issue({...parameters,level:{sort_order:18,invitation_only:true},newSortOrder:18}),false);
});
