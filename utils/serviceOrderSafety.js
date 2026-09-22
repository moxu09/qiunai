const WAITING_STATUSES = ["quoted", "waiting_payment", "waiting_confirm"];

function isUnpaidWaitingOrder(order) {
  return Boolean(order && !order.paid && !order.is_deleted && WAITING_STATUSES.includes(order.status));
}

async function getOrCreateServiceOrder(supabase, payload, nextOrderNumber) {
  if (!payload.service_flow_key) throw new Error("缺少訂單流程編號，請重新開始下單。");
  const load = () => supabase.from("play_orders").select("*")
    .eq("guild_id", payload.guild_id).eq("service_flow_key", payload.service_flow_key).maybeSingle();
  let { data, error } = await load();
  if (error) throw error;
  if (!data) {
    const result = await supabase.from("play_orders").insert({ ...payload, order_no: await nextOrderNumber() }).select().single();
    if (result.error?.code === "23505") ({ data, error } = await load());
    else ({ data, error } = result);
    if (error || !data) throw new Error("建立訂單失敗，請稍後再試。", { cause: error });
  }
  if (!isUnpaidWaitingOrder(data)) throw new Error("這筆需求已有付款或已結束的訂單，請勿重複操作。");
  if (data.customer_id !== payload.customer_id || data.channel_id !== payload.channel_id ||
      Number(data.final_price) !== Number(payload.final_price) || data.payment_method !== payload.payment_method) {
    throw new Error("這筆需求已建立付款確認，請使用原付款訊息；如需改價或付款方式，請聯繫客服。");
  }
  return data;
}

async function transitionUnpaidOrders(supabase, { orderId = null, groupId = null, guildId, action }) {
  const { data, error } = await supabase.rpc("qiunai_transition_unpaid_orders", {
    p_order_id: orderId, p_group_id: groupId, p_guild_id: guildId, p_action: action,
  });
  if (error) throw new Error("訂單狀態更新失敗，請稍後再試。", { cause: error });
  return data || [];
}

function createOperationGuard() {
  const running = new Set();
  return async (key, run, busy) => {
    if (!key) return run();
    if (running.has(key)) return busy();
    running.add(key);
    try { return await run(); } finally { running.delete(key); }
  };
}
module.exports = { isUnpaidWaitingOrder, getOrCreateServiceOrder, transitionUnpaidOrders, createOperationGuard };
