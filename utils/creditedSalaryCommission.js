const CREDITED_SALARY_ENTRY_TYPES = ["order_salary", "salary_correction"];

function getTaipeiMonthWindow(value, offset = 0) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("薪資檔位日期格式不正確");
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return {
    month: start.toISOString().slice(0, 7),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function getMonthlyCreditedSalary(supabase, discordId, at, offset = 0) {
  const window = getTaipeiMonthWindow(at, offset);
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("salary_wallet_entries")
      .select("amount").eq("app_key", "qiunai")
      .eq("discord_id", String(discordId))
      .in("entry_type", CREDITED_SALARY_ENTRY_TYPES)
      .gte("settlement_date", window.startDate)
      .lt("settlement_date", window.endDate)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    total += (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    if ((data || []).length < 1000) return total;
  }
}

async function getMonthlyOrderAmount(supabase, discordId, at, offset = 0) {
  const window = getTaipeiMonthWindow(at, offset);
  const start = new Date(window.startDate + "T00:00:00+08:00").toISOString();
  const end = new Date(window.endDate + "T00:00:00+08:00").toISOString();
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("qiunai_salary_orders")
      .select("order_amount,status,service_name").eq("discord_id", String(discordId))
      .or("is_deleted.eq.false,is_deleted.is.null")
      .gte("order_finished_at", start).lt("order_finished_at", end)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    for (const row of data || []) {
      // Completed service orders and tips count, including unpaid salary; unfinished reports do not.
      if (!["未入帳", "未發薪", "已入帳", "已發薪", "已完成", "completed"].includes(row.status)) continue;
      total += Number(row.order_amount || 0);
    }
    if ((data || []).length < 1000) return total;
  }
}

module.exports = { CREDITED_SALARY_ENTRY_TYPES, getTaipeiMonthWindow, getMonthlyCreditedSalary, getMonthlyOrderAmount };
