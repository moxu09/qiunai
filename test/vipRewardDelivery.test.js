const test = require("node:test");
const assert = require("node:assert/strict");
const { createVipRewardCoordinator } = require("../utils/vipRewardDelivery");

function createRewardDb() {
  const state = {
    dbApplied: false,
    rewardAsdApplications: 0,
    couponApplications: 0,
    applyCalls: 0,
    deliveryStatus: "pending",
    deliveryAttempts: 0,
  };
  const operation = {
    guild_id: "guild-qiu",
    user_id: "user-1",
    level_key: "gold",
    role_id: "role-gold",
    reward_asd: 100,
    reward_coupons: [{ name: "九折券", count: 1 }],
    level_name: "黃金會員",
  };
  return {
    state,
    operation,
    async rpc(name, args) {
      if (name === "qiunai_apply_vip_level_reward") {
        state.applyCalls += 1;
        if (!state.dbApplied) {
          state.dbApplied = true;
          state.rewardAsdApplications += 1;
          state.couponApplications += 1;
        }
        return {
          data: { ...operation, delivery_status: state.deliveryStatus },
          error: null,
        };
      }
      if (name === "qiunai_claim_vip_reward_delivery") {
        if (state.deliveryStatus === "completed") {
          return { data: { claimed: false, state: "completed", operation }, error: null };
        }
        if (state.deliveryStatus === "processing") {
          return { data: { claimed: false, state: "processing", operation }, error: null };
        }
        state.deliveryStatus = "processing";
        state.deliveryAttempts += 1;
        return {
          data: {
            claimed: true,
            state: "processing",
            attempt: state.deliveryAttempts,
            operation: { ...operation, delivery_attempts: state.deliveryAttempts },
          },
          error: null,
        };
      }
      if (name === "qiunai_complete_vip_reward_delivery") {
        assert.equal(args.p_attempt, state.deliveryAttempts);
        state.deliveryStatus = "completed";
        return { data: null, error: null };
      }
      if (name === "qiunai_fail_vip_reward_delivery") {
        assert.equal(args.p_attempt, state.deliveryAttempts);
        state.deliveryStatus = "failed";
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

const rewardParams = {
  p_guild_id: "guild-qiu",
  p_user_id: "user-1",
  p_level_key: "gold",
  p_old_level_key: "silver",
  p_trigger_type: "topup",
  p_trigger_amount: 1000,
  p_reward_coupons: [{ name: "九折券", count: 1 }],
};

test("VIP reward 在 DB 完成後程序中斷，重試不再增加 ASD 或優惠券", async () => {
  const db = createRewardDb();
  let deliveryRuns = 0;
  let roleAssigned = false;
  let roleAdds = 0;
  const coordinator = createVipRewardCoordinator({
    supabase: db,
    deliver: async () => {
      deliveryRuns += 1;
      if (!roleAssigned) {
        roleAssigned = true;
        roleAdds += 1;
      }
      if (deliveryRuns === 1) throw new Error("process crashed after role");
    },
  });

  await assert.rejects(
    coordinator.applyAndDeliver(rewardParams),
    /process crashed after role/,
  );
  assert.equal(db.state.deliveryStatus, "failed");

  const recovered = await coordinator.applyAndDeliver(rewardParams);
  assert.equal(recovered.state, "completed");
  assert.equal(db.state.applyCalls, 2, "重試仍會確認同一 DB operation");
  assert.equal(db.state.rewardAsdApplications, 1);
  assert.equal(db.state.couponApplications, 1);
  assert.equal(roleAdds, 1, "角色新增本身亦可重入");
  assert.equal(deliveryRuns, 2);
});

test("兩個並行 VIP reward delivery 只有 claim 成功者執行外部派送", async () => {
  const db = createRewardDb();
  let release;
  let deliveryRuns = 0;
  const coordinator = createVipRewardCoordinator({
    supabase: db,
    deliver: async () => {
      deliveryRuns += 1;
      await new Promise((resolve) => { release = resolve; });
    },
  });
  const first = coordinator.applyAndDeliver(rewardParams);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = await coordinator.applyAndDeliver(rewardParams);
  assert.equal(second.state, "processing");
  assert.equal(deliveryRuns, 1);
  assert.equal(db.state.rewardAsdApplications, 1);
  assert.equal(db.state.couponApplications, 1);
  release();
  await first;
  assert.equal(db.state.deliveryStatus, "completed");
});
