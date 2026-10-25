function monthWindow(at = new Date(), offset = 0) {
  const taipei = new Date(new Date(at).getTime() + 8 * 3600000);
  const date = new Date(Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth() + offset, 1));
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { month: date.toISOString().slice(0, 7), start: new Date(date.getTime() - 8 * 3600000).toISOString(), end: new Date(next.getTime() - 8 * 3600000).toISOString() };
}
async function getMonthlyPaymentInquiry(db, guildId, userId, at = new Date(), offset = -1) {
  const window = monthWindow(at, offset);
  let orders = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("play_orders")
      .select("id,order_no,final_price,price,payment_method,paid_at,status,is_deleted")
      .eq("guild_id", String(guildId)).eq("customer_id", String(userId))
      .eq("paid", true).gte("paid_at", window.start).lt("paid_at", window.end)
      .order("paid_at", { ascending: false }).order("id").range(from, from + 999);
    if (error) throw error;
    orders.push(...(data || []).filter(row => !row.is_deleted && !["cancelled", "canceled", "refunded", "已退款", "已取消"].includes(row.status)));
    if ((data || []).length < 1000) break;
  }
  return { ...window, count: orders.length, amount: orders.reduce((sum, row) => sum + Math.max(0, Number(row.final_price ?? row.price ?? 0)), 0), orders: orders.slice(0, 10) };
}
module.exports = { monthWindow, getMonthlyPaymentInquiry };
