#!/usr/bin/env node

const { createClient } = require("@supabase/supabase-js");

const QIUNAI_GUILD_ID = "1206138511535898654";
const MIGRATION_CUTOFF = new Date("2026-07-13T12:37:18Z").getTime();
const REPAIR_PREFIX = "cumulative-repair:2026-09-06";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function loadAll(table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await configure(
      supabase.from(table).select(columns),
    ).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

function activityKey(kind, id) {
  return `${REPAIR_PREFIX}:${kind}:${id}`;
}

async function buildRepairs() {
  const [ledger, orders, extensions, shopLogs] = await Promise.all([
    loadAll(
      "alliance_point_ledger",
      "discord_user_id,qualifying_amount,created_at,source_key,note,source_guild_id,point_kind,source_type",
      (query) => query.eq("source_type", "spend").eq("point_kind", "membership"),
    ),
    loadAll(
      "play_orders",
      "id,order_no,customer_id,price,final_price,paid,status,created_at,guild_id,vip_spent_counted",
    ),
    loadAll(
      "order_extensions",
      "id,order_id,customer_id,amount,paid,status,paid_at,created_at,guild_id",
    ),
    loadAll(
      "wallet_logs",
      "id,user_id,type,amount,note,created_at",
      (query) =>
        query
          .eq("type", "商店購買")
          .lt("amount", 0)
          .gte("created_at", new Date(MIGRATION_CUTOFF).toISOString()),
    ),
  ]);

  const existingKeys = new Set(ledger.map((row) => row.source_key));
  const paidExtensionsByOrder = new Map();
  for (const extension of extensions.filter((row) => row.paid)) {
    const list = paidExtensionsByOrder.get(extension.order_id) || [];
    list.push(extension);
    paidExtensionsByOrder.set(extension.order_id, list);
  }

  const repairs = [];
  const add = ({ kind, id, userId, guildId, amount, note }) => {
    const sourceKey = activityKey(kind, id);
    if (!existingKeys.has(sourceKey) && Number(amount) !== 0) {
      repairs.push({ sourceKey, userId, guildId, amount: Number(amount), note });
    }
  };

  for (const extension of extensions) {
    const paidAt = new Date(extension.paid_at || extension.created_at).getTime();
    if (!extension.paid || paidAt < MIGRATION_CUTOFF) continue;
    if (existingKeys.has(`order-extension:${extension.id}`)) continue;
    add({
      kind: "extension",
      id: extension.id,
      userId: extension.customer_id,
      guildId: extension.guild_id || QIUNAI_GUILD_ID,
      amount: Number(extension.amount || 0),
      note: `歷史補登加時消費 ${extension.id}`,
    });
  }

  for (const log of shopLogs) {
    add({
      kind: "shop",
      id: log.id,
      userId: log.user_id,
      guildId: QIUNAI_GUILD_ID,
      amount: -Number(log.amount || 0),
      note: `歷史補登${log.note || "商店購買"}`,
    });
  }

  for (const order of orders) {
    const createdAt = new Date(order.created_at).getTime();
    if (
      order.guild_id !== QIUNAI_GUILD_ID ||
      !order.paid ||
      order.vip_spent_counted ||
      createdAt < MIGRATION_CUTOFF ||
      ["pending", "cancelled"].includes(order.status) ||
      existingKeys.has(`order:${order.id}`)
    ) {
      continue;
    }
    const extensionTotal = (paidExtensionsByOrder.get(order.id) || []).reduce(
      (sum, extension) => sum + Number(extension.amount || 0),
      0,
    );
    const baseAmount = Number(order.final_price || order.price || 0) - extensionTotal;
    add({
      kind: "order",
      id: order.id,
      userId: order.customer_id,
      guildId: order.guild_id,
      amount: baseAmount,
      note: `歷史補登已付款訂單 ${order.order_no || order.id}`,
    });
  }

  const staffAdds = ledger.filter(
    (row) =>
      String(row.source_key || "").startsWith("staff-adjust:") &&
      Number(row.qualifying_amount) > 0,
  );
  const countedOrders = ledger.filter(
    (row) =>
      String(row.source_key || "").startsWith("order:") &&
      Number(row.qualifying_amount) > 0,
  );
  const usedStaffKeys = new Set();
  for (const orderActivity of countedOrders) {
    const orderTime = new Date(orderActivity.created_at).getTime();
    const duplicate = staffAdds
      .filter(
        (row) =>
          !usedStaffKeys.has(row.source_key) &&
          row.discord_user_id === orderActivity.discord_user_id &&
          Number(row.qualifying_amount) === Number(orderActivity.qualifying_amount) &&
          Math.abs(new Date(row.created_at).getTime() - orderTime) <= 15 * 60 * 1000,
      )
      .sort(
        (a, b) =>
          Math.abs(new Date(a.created_at).getTime() - orderTime) -
          Math.abs(new Date(b.created_at).getTime() - orderTime),
      )[0];
    if (!duplicate) continue;
    usedStaffKeys.add(duplicate.source_key);
    add({
      kind: "duplicate",
      id: duplicate.source_key.replace("staff-adjust:", ""),
      userId: duplicate.discord_user_id,
      guildId: duplicate.source_guild_id || QIUNAI_GUILD_ID,
      amount: -Number(duplicate.qualifying_amount),
      note: `回退重複人工補登 ${duplicate.source_key}`,
    });
  }

  add({
    kind: "double-refund",
    id: "ab4fcc0a-d499-44b0-a3bc-13096745693f",
    userId: "579700632160698395",
    guildId: QIUNAI_GUILD_ID,
    amount: 250,
    note: "修正 ORD-0000000338 重複回退累積消費",
  });

  return repairs;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const repairs = await buildRepairs();
  const summary = repairs.reduce(
    (result, repair) => {
      const kind = repair.sourceKey.split(":")[2];
      result[kind] = result[kind] || { count: 0, amount: 0 };
      result[kind].count += 1;
      result[kind].amount += repair.amount;
      result.total.count += 1;
      result.total.amount += repair.amount;
      return result;
    },
    { total: { count: 0, amount: 0 } },
  );
  console.log(JSON.stringify({ apply, summary }, null, 2));
  if (!apply) return;

  for (const repair of repairs) {
    const { error } = await supabase.rpc("alliance_apply_activity", {
      p_discord_user_id: String(repair.userId),
      p_guild_id: String(repair.guildId || ""),
      p_activity_type: "spend",
      p_amount: repair.amount,
      p_source_key: repair.sourceKey,
      p_note: repair.note,
    });
    if (error) throw new Error(`${repair.sourceKey}: ${error.message}`);
  }

  const repairedOrderIds = repairs
    .filter((repair) => repair.sourceKey.includes(":order:"))
    .map((repair) => repair.sourceKey.split(":").at(-1));
  if (repairedOrderIds.length) {
    const { error } = await supabase
      .from("play_orders")
      .update({ vip_spent_counted: true, vip_spent_counted_at: new Date().toISOString() })
      .in("id", repairedOrderIds);
    if (error) throw error;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
