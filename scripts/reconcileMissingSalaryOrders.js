require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const {
  chooseHigherCommission,
  getManualCommissionRate,
  getOrderCommissionBase,
} = require("../utils/salaryCommission");
const {
  getSeptemberShiftCommissionRate,
} = require("../utils/customerServicePoints");

const APPLY = process.argv.includes("--apply");
const START_AT = process.env.RECONCILE_SALARY_START_AT || "2026-09-01T00:00:00Z";
const GUILD_ID = process.env.GUILD_ID || "1206138511535898654";
const PAGE_SIZE = 1000;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

async function readAll(table, columns, buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(
      supabase.from(table).select(columns),
    ).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

function taipeiMonthStart(value) {
  const shifted = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000);
  const month = shifted.toISOString().slice(0, 7);
  return new Date(`${month}-01T00:00:00+08:00`).toISOString();
}

async function getCommission(staff, discordId, finishedAt, historicalRows) {
  const { data: activity, error } = await supabase
    .from("salary_activity_commission_settings")
    .select("activity_rate")
    .eq("app_key", "qiunai")
    .not("activity_rate", "is", null)
    .lte("starts_at", finishedAt)
    .gt("ends_at", finishedAt)
    .maybeSingle();
  if (error) throw error;
  const activityRate = Number(activity?.activity_rate || 0);
  const activityCommission = activityRate
    ? { rate: activityRate, level: `活動抽成 ${activityRate}%` }
    : null;
  const withActivity = (base) => chooseHigherCommission(base, activityCommission);

  const manualRate = getManualCommissionRate(staff?.commission_tier);
  if (manualRate) {
    return withActivity({
      rate: manualRate,
      level: manualRate === 95 ? "主管津貼 95%" : `手動檔位 ${manualRate}%`,
    });
  }
  const shiftRate = getSeptemberShiftCommissionRate(discordId, finishedAt);
  if (shiftRate) return withActivity({ rate: shiftRate, level: "9 月輪班客服｜85%" });
  if (new Date(finishedAt) < new Date("2026-09-01T00:00:00+08:00")) {
    return withActivity({ rate: 90, level: "開幕期 90%" });
  }

  const year = Number(
    new Date(new Date(finishedAt).getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 4),
  );
  const priorYearStart = new Date(`${year - 1}-01-01T00:00:00+08:00`).getTime();
  const priorYearEnd = new Date(`${year}-01-01T00:00:00+08:00`).getTime();
  const priorYearSalary = historicalRows
    .filter((row) => {
      const at = new Date(row.order_finished_at).getTime();
      return row.discord_id === discordId && at >= priorYearStart && at < priorYearEnd;
    })
    .reduce((sum, row) => sum + Number(row.staff_salary || 0), 0);
  if (priorYearSalary >= 100000) {
    return withActivity({ rate: 90, level: "年度薪資達標｜隔年 90%" });
  }

  const monthStart = new Date(taipeiMonthStart(finishedAt)).getTime();
  const priorAmount = historicalRows
    .filter(
      (row) =>
        row.discord_id === discordId &&
        new Date(row.order_finished_at).getTime() < monthStart,
    )
    .reduce((sum, row) => sum + Number(row.order_amount || 0), 0);
  return withActivity(
    priorAmount >= 10000
      ? { rate: 85, level: "上月前累積接單滿 10,000｜85%" }
      : { rate: 80, level: "預設 80%" },
  );
}

async function main() {
  const [orders, salaryRows, staffRows] = await Promise.all([
    readAll(
      "play_orders",
      "id,order_no,assigned_player,discord_id,status,paid,price,final_price,order_amount,customer_name,customer_username,customer_id,service,order_item,created_at,completed_at,order_finished_at,is_deleted",
      (query) =>
        query
          .eq("guild_id", GUILD_ID)
          .eq("paid", true)
          .eq("status", "completed")
          .gte("created_at", START_AT)
          .or("is_deleted.eq.false,is_deleted.is.null")
          .order("created_at", { ascending: true }),
    ),
    readAll(
      "qiunai_salary_orders",
      "id,order_id,discord_id,order_amount,staff_salary,order_finished_at,is_deleted",
      (query) =>
        query
          .or("is_deleted.eq.false,is_deleted.is.null")
          .order("created_at", { ascending: true }),
    ),
    readAll("qiunai_staff", "*", (query) => query.eq("guild_id", GUILD_ID)),
  ]);
  const staffById = new Map(staffRows.map((row) => [String(row.discord_id), row]));
  const activeKeys = new Set(
    salaryRows.map((row) => `${String(row.order_id)}|${String(row.discord_id)}`),
  );
  const missing = [];

  for (const order of orders) {
    const players = String(order.assigned_player || order.discord_id || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const splitAmount = Math.floor(getOrderCommissionBase(order) / Math.max(players.length, 1));
    if (splitAmount <= 0) continue;
    for (const discordId of players) {
      const sourceKeys = [String(order.order_no || order.id), `WORK-${order.id}-${discordId}`];
      if (sourceKeys.some((key) => activeKeys.has(`${key}|${discordId}`))) continue;
      missing.push({ order, discordId, splitAmount, sourceKey: sourceKeys[0] });
    }
  }

  console.log(`[薪資漏單補建] 模式=${APPLY ? "正式寫入" : "僅預覽"}，缺少 ${missing.length} 筆`);
  let inserted = 0;
  for (const item of missing) {
    const { order, discordId, splitAmount, sourceKey } = item;
    if (!APPLY) {
      console.log(`${sourceKey} | ${discordId} | NT$${splitAmount}`);
      continue;
    }
    const { data: existing, error: existingError } = await supabase
      .from("qiunai_salary_orders")
      .select("id")
      .eq("discord_id", discordId)
      .in("order_id", [sourceKey, `WORK-${order.id}-${discordId}`])
      .or("is_deleted.eq.false,is_deleted.is.null")
      .limit(1);
    if (existingError) throw existingError;
    if (existing?.length) continue;

    const finishedAt = order.completed_at || order.order_finished_at || order.created_at;
    const staff = staffById.get(discordId);
    let commission = await getCommission(staff, discordId, finishedAt, salaryRows);
    const serviceName = order.service || order.order_item || "陪玩訂單";
    if (String(serviceName).includes("打賞") && commission.rate !== 95) {
      commission = { rate: 90, level: "打賞固定 90%" };
    }
    const staffSalary = Math.round(splitAmount * (commission.rate / 100));
    const { data, error } = await supabase
      .from("qiunai_salary_orders")
      .insert({
        order_id: sourceKey,
        discord_id: discordId,
        staff_name:
          staff?.display_name || staff?.real_name || staff?.discord_name || staff?.name || null,
        customer_name:
          order.customer_name || order.customer_username || `<@${order.customer_id}>`,
        service_name: serviceName,
        order_amount: splitAmount,
        staff_salary: staffSalary,
        bonus_amount: 0,
        salary_rate: commission.rate,
        salary_level: commission.level,
        platform_income: splitAmount,
        platform_expense: staffSalary,
        status: "未入帳",
        order_finished_at: finishedAt,
        is_deleted: false,
      })
      .select("id")
      .single();
    if (error) throw new Error(`${sourceKey}/${discordId}: ${error.message}`);
    if (data?.id) inserted += 1;
  }
  console.log(`[薪資漏單補建] 完成，新增 ${inserted} 筆`);
}

main().catch((error) => {
  console.error("[薪資漏單補建] 失敗", error);
  process.exitCode = 1;
});
