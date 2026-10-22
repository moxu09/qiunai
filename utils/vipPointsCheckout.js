const { isVipPointsActive } = require("../config/qiunaiVipPoints");

function createVipPointsCheckout(supabase) {
  async function balance(userId) {
    if (!isVipPointsActive()) return 0;
    const { data, error } = await supabase.from("qiunai_vip_point_accounts").select("balance").eq("user_id", String(userId)).maybeSingle();
    if (error) throw error;
    return Number(data?.balance || 0);
  }
  async function reserve(userId, key, couponAmount, enabled) {
    if (!isVipPointsActive()) return { points: 0, amount_due: couponAmount };
    const { data, error } = await supabase.rpc("qiunai_reserve_vip_points", {
      p_user_id: String(userId), p_key: key, p_coupon_amount: couponAmount, p_enabled: enabled !== false,
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }
  async function bind(userId, key, orders) {
    if (!key) return;
    const { error } = await supabase.rpc("qiunai_bind_vip_points", {
      p_user_id: String(userId), p_key: key, p_order_ids: orders.map(order => order.id),
    });
    if (error) throw error;
  }
  async function applyOrder(order) {
    if (!isVipPointsActive() || order.paid) return order;
    const original = Number(order.original_price ?? order.price ?? order.final_price);
    const couponAmount = Math.max(0, original - Number(order.discount_amount || 0));
    const reserved = await reserve(order.customer_id, `order:${order.id}`, couponAmount, !order.vip_points_disabled);
    const { data, error } = await supabase.from("play_orders")
      .update({ final_price: reserved.amount_due }).eq("id", order.id).eq("paid", false).select().single();
    if (error) throw error;
    await bind(order.customer_id, reserved.checkout_key, [data]);
    return { ...data, vip_points_used: reserved.points };
  }
  return { balance, reserve, bind, applyOrder };
}
module.exports = { createVipPointsCheckout };
