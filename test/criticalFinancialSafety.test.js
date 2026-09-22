const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913193000_qiunai_critical_order_safety.sql",
  ),
  "utf8",
);
const dispatchSource = fs.readFileSync(
  path.join(root, "events", "dispatchSystem.js"),
  "utf8",
);
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
const jkopaySource = fs.readFileSync(
  path.join(root, "utils", "jkopay.js"),
  "utf8",
);
const vipRewardDeliverySource = fs.readFileSync(
  path.join(root, "utils", "vipRewardDelivery.js"),
  "utf8",
);

function functionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `找不到 ${name}`);
  assert.notEqual(end, -1, `找不到 ${nextName}`);
  return source.slice(start, end);
}

test("ASD 加時付款由單一 RPC 完成扣款、錢包明細、付款與原單加價", () => {
  assert.match(migration, /function public\.qiunai_pay_extension_with_wallet/);
  const sqlStart = migration.indexOf("function public.qiunai_pay_extension_with_wallet");
  const sqlEnd = migration.indexOf("function public.qiunai_cancel_self_service_order", sqlStart);
  const sql = migration.slice(sqlStart, sqlEnd);
  assert.match(sql, /for update/);
  assert.match(sql, /update public\.users set coins/);
  assert.match(sql, /insert into public\.wallet_logs/);
  assert.match(sql, /update public\.play_orders set/);
  assert.match(sql, /update public\.order_extensions set/);

  const handler = functionBody(
    dispatchSource,
    "handleConfirmExtensionWallet",
    "handleStaffConfirmExtensionPaid",
  );
  assert.match(handler, /qiunai_pay_extension_with_wallet/);
  assert.doesNotMatch(handler, /paymentHelpers\.changeCoins/);
  assert.doesNotMatch(handler, /applyExtensionToPlayOrder/);
});

test("手動及逾時自助棄單共用原子退款 RPC，不再用補償式二次扣款", () => {
  assert.match(migration, /function public\.qiunai_cancel_self_service_order/);
  const timeout = functionBody(
    dispatchSource,
    "failSelfServiceDispatch",
    "scheduleSelfServiceDispatchTimeout",
  );
  const manual = functionBody(
    dispatchSource,
    "cancelAndRefundSelfServiceOrder",
    "confirmSelfServicePlayers",
  );
  for (const body of [timeout, manual]) {
    assert.match(body, /qiunai_cancel_self_service_order/);
    assert.doesNotMatch(body, /paymentHelpers\.changeCoins/);
  }
  assert.match(migration, /primary key \(organization_code, operation_key\)/);
  assert.match(migration, /insert into public\.bot_financial_operations/);
});

test("街口加時退款以持久 operation key 原子回沖原單、加時與未結算薪資", () => {
  const refundHandler = functionBody(
    indexSource,
    "handleJkopayServiceRefunded",
    "isWalletPayment",
  );
  assert.match(refundHandler, /qiunai_reverse_jkopay_extension/);
  assert.match(refundHandler, /payment\.payment_kind === "extension" \? \[\] : context\.salary\.rows/);
  assert.match(migration, /function public\.qiunai_reverse_jkopay_extension/);
  assert.match(migration, /jkopay_extension_reversal/);
  assert.match(migration, /update public\.qiunai_salary_orders set/);
});

test("所有新增財務 RPC 僅允許 service_role", () => {
  for (const name of [
    "qiunai_pay_extension_with_wallet",
    "qiunai_cancel_self_service_order",
    "qiunai_reverse_jkopay_extension",
    "qiunai_promote_vip_level",
    "qiunai_apply_vip_level_reward",
    "qiunai_claim_vip_reward_delivery",
    "qiunai_complete_vip_reward_delivery",
    "qiunai_fail_vip_reward_delivery",
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}`));
  }
});

test("人工儲值以 topup_no 持久去重，不再依賴程序記憶體 Set", () => {
  const handler = functionBody(dispatchSource, "confirmTopup", "submitSaveOrderNote");
  assert.match(handler, /qiunai_apply_manual_topup/);
  assert.doesNotMatch(handler, /processingTopups/);
  assert.doesNotMatch(handler, /paymentHelpers\.changeCoins/);
  assert.match(migration, /create table if not exists public\.bot_manual_topups/);
  assert.match(migration, /primary key \(organization_code, topup_no\)/);
  assert.match(migration, /function public\.qiunai_apply_manual_topup/);
  assert.match(handler, /processFinancialEffect/);
  assert.doesNotMatch(handler, /await paymentHelpers\.checkAndUpgradeVip\(/);
  assert.match(migration, /manual-topup-effects:/);
});

test("所有會自動派單的付款入口改走持久 dispatch recovery", () => {
  assert.match(dispatchSource, /createPaidOrderDispatcher/);
  assert.match(dispatchSource, /async function deliverPaidOrder/);
  assert.match(dispatchSource, /function startPaidOrderDispatchRecovery/);
  assert.match(indexSource, /已付款訂單補派排程/);
  for (const name of [
    "handleServiceConfirmWallet",
    "handleServiceConfirmMonthly",
    "handleServiceGroupPayment",
    "handleJkopayServicePaid",
  ]) {
    const start = dispatchSource.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, `找不到 ${name}`);
    const next = dispatchSource.indexOf("\nasync function ", start + 16);
    const body = dispatchSource.slice(start, next === -1 ? undefined : next);
    assert.match(body, /deliverPaidOrder|handleServiceGroupPayment\(interaction/);
  }
  assert.match(migration, /dispatch_message_id text/);
  assert.match(migration, /dispatch_control_message_id text/);
  assert.match(migration, /function public\.qiunai_claim_order_dispatch/);
  assert.match(migration, /function public\.qiunai_complete_order_dispatch/);
  assert.match(migration, /function public\.qiunai_fail_order_dispatch/);
  assert.match(migration, /function public\.qiunai_pay_service_order_with_wallet/);
  assert.match(migration, /function public\.qiunai_pay_service_order_with_monthly/);
  assert.match(dispatchSource, /payOrderByWallet\(order, \{\s*dispatchAfterPayment: true/s);
  assert.match(dispatchSource, /payOrderByMonthly\(order, \{\s*dispatchAfterPayment: true/s);
  assert.match(indexSource, /dispatchAfterPayment[\s\S]*qiunai_pay_service_order_with_wallet/);
});

test("派單 checkpoint 帶 attempt 柵欄，舊程序不能覆蓋新 claim", () => {
  assert.match(migration, /qiunai_checkpoint_order_dispatch\([\s\S]*p_attempt integer/);
  assert.match(migration, /dispatch_attempts = p_attempt/);
  assert.match(migration, /qiunai_complete_order_dispatch\([\s\S]*p_attempt integer/);
  assert.match(migration, /qiunai_fail_order_dispatch\([\s\S]*p_attempt integer/);
});

test("街口查單已確認付款後，Discord 補派失敗不會把付款退回 pending", () => {
  const catchStart = jkopaySource.indexOf("} catch (serviceError) {");
  const catchEnd = jkopaySource.indexOf("throw serviceError;", catchStart);
  assert.notEqual(catchStart, -1);
  assert.notEqual(catchEnd, -1);
  const handler = jkopaySource.slice(catchStart, catchEnd);
  assert.match(handler, /status: "paid"/);
  assert.doesNotMatch(handler, /status: "pending"/);
  assert.match(handler, /trade_no: transaction\.tradeNo/);
});

test("自助退款與人工儲值的 VIP／會計後處理有持久補償佇列", () => {
  assert.match(migration, /effects_status text not null default 'pending'/);
  assert.match(migration, /function public\.qiunai_claim_financial_effect/);
  assert.match(migration, /function public\.qiunai_complete_financial_effect/);
  assert.match(migration, /function public\.qiunai_fail_financial_effect/);
  assert.match(dispatchSource, /async function processFinancialEffect/);
  assert.match(dispatchSource, /function startFinancialEffectsRecovery/);
  assert.match(indexSource, /VIP 與會計補償排程/);
  const timeout = functionBody(
    dispatchSource,
    "failSelfServiceDispatch",
    "scheduleSelfServiceDispatchTimeout",
  );
  const manual = functionBody(
    dispatchSource,
    "cancelAndRefundSelfServiceOrder",
    "confirmSelfServicePlayers",
  );
  assert.match(timeout, /processFinancialEffect\(`self-service-timeout-refund:/);
  assert.match(manual, /processFinancialEffect\(`self-service-cancel-refund:/);
  assert.match(migration, /create table if not exists public\.bot_vip_effects/);
  assert.match(migration, /function public\.qiunai_apply_vip_effect/);
  assert.match(dispatchSource, /async function applyPersistentVipEffect/);
  assert.match(dispatchSource, /qiunai_apply_vip_effect/);
  assert.doesNotMatch(dispatchSource, /membership\.qualifying_(?:topup|spend)/);
});

test("VIP 升等獎勵在 DB 原子去重，level 已保存後仍可補送未完成獎勵", () => {
  assert.match(migration, /create table if not exists public\.bot_vip_reward_operations/);
  const applyStart = migration.indexOf("function public.qiunai_apply_vip_level_reward");
  const applyEnd = migration.indexOf("function public.qiunai_claim_vip_reward_delivery", applyStart);
  const applySql = migration.slice(applyStart, applyEnd);
  assert.match(applySql, /pg_advisory_xact_lock/);
  assert.match(applySql, /update public\.users set coins/);
  assert.match(applySql, /insert into public\.wallet_logs/);
  assert.match(applySql, /insert into public\.user_items/);
  assert.match(applySql, /insert into public\.vip_upgrade_logs/);
  assert.match(applySql, /insert into public\.bot_vip_reward_operations/);

  const grant = functionBody(indexSource, "grantVipLevelReward", "retryPendingVipRewards");
  assert.match(grant, /applyAndDeliver/);
  assert.match(vipRewardDeliverySource, /qiunai_apply_vip_level_reward/);
  assert.doesNotMatch(grant, /changeCoins|addUserItem|vip_upgrade_logs/);
  const check = functionBody(indexSource, "checkAndUpgradeVip", "countOrderVipSpentOnce");
  assert.match(check, /bot_vip_reward_operations/);
  assert.match(check, /rewardOperationStates\.get\(level\.level_key\) !== "completed"/);
  assert.match(vipRewardDeliverySource, /qiunai_claim_vip_reward_delivery/);
  assert.match(vipRewardDeliverySource, /qiunai_complete_vip_reward_delivery/);
  assert.match(vipRewardDeliverySource, /qiunai_fail_vip_reward_delivery/);
  assert.match(dispatchSource, /retryPendingVipRewards/);
});

test("VIP 歷史獎勵回填只接受明確屬於秋奈的 guild，不推測 NULL 舊紀錄", () => {
  const logsBackfillStart = migration.indexOf(
    "from public.vip_upgrade_logs log",
  );
  const logsBackfillEnd = migration.indexOf(
    "on conflict (organization_code, guild_id, user_id, level_key) do nothing;",
    logsBackfillStart,
  );
  assert.notEqual(logsBackfillStart, -1);
  assert.notEqual(logsBackfillEnd, -1);
  const logsBackfill = migration.slice(logsBackfillStart, logsBackfillEnd);
  assert.match(
    logsBackfill,
    /where log\.guild_id = '1206138511535898654'/,
  );
  assert.doesNotMatch(logsBackfill, /coalesce\(log\.guild_id,\s*level\.guild_id\)/);
});

test("持久 VIP effect 只讀 DB 最新累積並以原子 RPC 升級，不回寫過期 total 快照", async () => {
  const promoteStart = migration.indexOf("function public.qiunai_promote_vip_level");
  const promoteEnd = migration.indexOf(
    "function public.qiunai_apply_vip_level_reward",
    promoteStart,
  );
  const promoteSql = migration.slice(promoteStart, promoteEnd);
  assert.match(promoteSql, /for update/);
  assert.match(promoteSql, /requested_sort > previous_sort/);
  assert.doesNotMatch(promoteSql, /total_(?:spent|topup)\s*=/);
  assert.doesNotMatch(promoteSql, /highest_single_topup\s*=/);

  const checkSource = functionBody(
    indexSource,
    "checkAndUpgradeVip",
    "countOrderVipSpentOnce",
  );
  assert.match(checkSource, /const useAtomicVipTotals = strict && useAbsoluteTotal/);
  assert.match(checkSource, /"qiunai_promote_vip_level"/);
  assert.match(checkSource, /if \(useAtomicVipTotals\) return null/);

  const levels = [
    {
      level_key: "bronze",
      level_name: "銅級",
      sort_order: 1,
      total_spend_required: 100,
      single_topup_required: 0,
    },
    {
      level_key: "gold",
      level_name: "金級",
      sort_order: 2,
      total_spend_required: 150,
      single_topup_required: 0,
    },
  ];
  let readCount = 0;
  let saveCalls = 0;
  let actualLevelKey = null;
  let actualSortOrder = 0;
  let releaseHighPromotion;
  const highPromotionDone = new Promise((resolve) => {
    releaseHighPromotion = resolve;
  });
  let signalLowPromotion;
  const lowPromotionStarted = new Promise((resolve) => {
    signalLowPromotion = resolve;
  });

  function queryResult(data) {
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      order() {
        return Promise.resolve({ data, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const fakeSupabase = {
    from(table) {
      if (table === "vip_levels") return queryResult(levels);
      if (table === "bot_vip_reward_operations") return queryResult([]);
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name, args) {
      assert.equal(name, "qiunai_promote_vip_level");
      const requested = levels.find(
        (level) => level.level_key === args.p_level_key,
      );
      assert.ok(requested);
      if (requested.level_key === "bronze") {
        signalLowPromotion();
        // 模擬 A 已拿到 total=100 的舊快照後，B 先把 DB 升到 150/金級。
        await highPromotionDone;
      }
      const previousLevelKey = actualLevelKey;
      const previousSortOrder = actualSortOrder;
      if (Number(requested.sort_order) > actualSortOrder) {
        actualLevelKey = requested.level_key;
        actualSortOrder = Number(requested.sort_order);
      }
      if (requested.level_key === "gold") releaseHighPromotion();
      return {
        data: {
          previous_level_key: previousLevelKey,
          previous_sort_order: previousSortOrder,
          level_key: actualLevelKey,
          level_name: levels.find((level) => level.level_key === actualLevelKey)
            ?.level_name,
          sort_order: actualSortOrder,
        },
        error: null,
      };
    },
  };
  const dependencies = {
    supabase: fakeSupabase,
    getUserVipRecord: async () => {
      readCount += 1;
      return {
        data: {
          id: "vip-1",
          level_key: null,
          total_spent: readCount === 1 ? 100 : 150,
          total_topup: 0,
          highest_single_topup: 0,
        },
        error: null,
      };
    },
    saveUserVipRecord: async () => {
      saveCalls += 1;
      throw new Error("atomic path must not save a VIP snapshot");
    },
    explainUserVipSaveFailure: async () => {},
    qualifiesForVipLevel: ({ totalSpent, totalSpendRequired }) =>
      totalSpendRequired > 0 && totalSpent >= totalSpendRequired,
    grantVipLevelReward: async () => {},
  };
  const checkAndUpgradeVip = Function(
    ...Object.keys(dependencies),
    `"use strict"; ${checkSource.replace(/\nasync\s*$/, "\n")}; return checkAndUpgradeVip;`,
  )(...Object.values(dependencies));

  const olderEffect = checkAndUpgradeVip(
    "user-1",
    "spend",
    100,
    "1206138511535898654",
    null,
    100,
    null,
    true,
  );
  await lowPromotionStarted;
  const newerEffect = checkAndUpgradeVip(
    "user-1",
    "spend",
    50,
    "1206138511535898654",
    null,
    150,
    null,
    true,
  );
  await Promise.all([olderEffect, newerEffect]);

  assert.equal(saveCalls, 0, "持久路徑不可把 RPC 的 absolute total 寫回");
  assert.equal(actualLevelKey, "gold");
  assert.equal(actualSortOrder, 2, "較舊 operation 晚完成也不能把等級降回去");
});

test("已付款補派只掃秋奈 guild，不做共用表全表掃描", () => {
  const recovery = functionBody(
    dispatchSource,
    "retryPendingPaidOrderDispatches",
    "startPaidOrderDispatchRecovery",
  );
  assert.match(recovery, /recoveryGuildId/);
  assert.match(recovery, /\.eq\("guild_id", recoveryGuildId\)/);
  assert.match(migration, /qiunai_claim_order_dispatch\(\s*p_order_id text, p_guild_id text/);
  assert.match(migration, /where id::text = p_order_id and guild_id = p_guild_id for update/);
  assert.match(migration, /drop function if exists public\.qiunai_claim_order_dispatch\(text\)/);
  assert.match(dispatchSource, /guildId: process\.env\.GUILD_ID/);
});

test("歷史 paid 但只有 dispatched 標記的單會進 recovery，不假設 Discord 已送達", () => {
  const backfillStart = migration.indexOf("update public.play_orders\nset dispatch_status");
  const backfillEnd = migration.indexOf("alter table public.play_orders alter column", backfillStart);
  const backfill = migration.slice(backfillStart, backfillEnd);
  assert.match(backfill, /status in \('accepted', 'completed'\) then 'dispatched'/);
  assert.match(backfill, /quote_status = 'dispatched'[\s\S]*then 'pending'/);
  assert.match(backfill, /guild_id = '1206138511535898654'/);
  assert.match(migration, /set dispatch_status = 'not_ready'\nwhere dispatch_status is null/);
});

test("員工扣薪與訂單付款由單一 RPC 原子提交並持久去重", () => {
  const handler = functionBody(
    dispatchSource,
    "applySalaryDeductionToOrders",
    "canCustomerOrStaffSubmit",
  );
  assert.match(handler, /qiunai_apply_salary_order_payment/);
  assert.doesNotMatch(handler, /\.from\("qiunai_staff_bonus"\)/);
  assert.doesNotMatch(handler, /\.from\("play_orders"\)\s*\.update/);
  const start = migration.indexOf("function public.qiunai_apply_salary_order_payment");
  const end = migration.indexOf("function public.qiunai_pay_extension_with_wallet", start);
  const sql = migration.slice(start, end);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /order by id for update/);
  assert.match(sql, /insert into public\.qiunai_staff_bonus/);
  assert.match(sql, /update public\.play_orders set/);
  assert.match(sql, /salary_deduction_payment/);
  assert.match(sql, /organization_code = 'qiunai'/);
});

test("街口加時回沖限定秋奈且在 transaction 鎖住並拒絕已結算報單", () => {
  const start = migration.indexOf("function public.qiunai_reverse_jkopay_extension");
  const end = migration.indexOf("function public.qiunai_pay_service_group", start);
  const sql = migration.slice(start, end);
  assert.match(sql, /organization_code = 'qiunai'/);
  assert.match(sql, /lock table public\.qiunai_salary_orders in share row exclusive mode/);
  assert.match(sql, /wallet_settled_at is not null/);
  assert.match(sql, /paid_at is not null/);
  assert.doesNotMatch(sql, /and wallet_settled_at is null and coalesce\(is_deleted/);
});

test("秋奈街口 gateway 允許深夜服務退款轉送", () => {
  assert.match(
    jkopaySource,
    /"\/payments\/jkopay\/gateway\/service-refund"/,
  );
});
