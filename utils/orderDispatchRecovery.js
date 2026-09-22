const DISPATCH_STATE = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  DISPATCHED: "dispatched",
  FAILED: "failed",
});

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function normalizeClaim(data) {
  const value = firstRpcRow(data);
  if (!value || typeof value !== "object") {
    throw new Error("派單鎖定未回傳有效資料");
  }
  return value;
}

/**
 * Discord 不是資料庫交易的一部分，因此派單採「持久狀態 + 訊息辨識」：
 * 1. DB 先 claim；2. 每送出一段便保存 message id；3. 重試先搜尋舊訊息。
 * 即使程序在 Discord 已送出、但尚未保存 id 時中止，也能靠 custom id 找回舊訊息。
 */
function createPaidOrderDispatcher({
  supabase,
  guildId,
  sendStaffOrder,
  sendControlPanel,
  findStaffOrder,
  findControlPanel,
}) {
  if (!supabase?.rpc) throw new Error("缺少 Supabase 派單服務");
  const tenantGuildId = String(guildId || "").trim();
  if (!tenantGuildId) throw new Error("缺少秋奈派單 guild_id");

  return async function dispatchPaidOrder(order, customerChannel) {
    const orderId = String(order?.id || "").trim();
    if (!orderId) throw new Error("缺少派單訂單 ID");
    if (String(order?.guild_id || "").trim() !== tenantGuildId) {
      throw new Error("訂單不屬於目前秋奈 guild，拒絕派單");
    }

    const { data, error } = await supabase.rpc("qiunai_claim_order_dispatch", {
      p_order_id: orderId,
      p_guild_id: tenantGuildId,
    });
    if (error) throw new Error(error.message || "鎖定派單失敗", { cause: error });
    const claim = normalizeClaim(data);

    if (claim.state === DISPATCH_STATE.DISPATCHED) {
      return { state: DISPATCH_STATE.DISPATCHED, alreadyDispatched: true };
    }
    if (!claim.claimed) {
      return { state: claim.state || DISPATCH_STATE.PROCESSING, inProgress: true };
    }

    const currentOrder = claim.order || order;
    const attempt = Number(claim.attempt || currentOrder.dispatch_attempts || 0);
    if (!Number.isInteger(attempt) || attempt <= 0) {
      throw new Error("派單鎖定未回傳有效的 attempt");
    }
    let staffMessageId = claim.staff_message_id || null;
    let controlMessageId = claim.control_message_id || null;
    try {
      if (!staffMessageId) {
        const existing = await findStaffOrder(currentOrder);
        const message = existing || (await sendStaffOrder(currentOrder));
        staffMessageId = message?.id || null;
        if (!staffMessageId) throw new Error("員工派單訊息未回傳 message id");
        const checkpoint = await supabase.rpc("qiunai_checkpoint_order_dispatch", {
          p_order_id: orderId,
          p_guild_id: tenantGuildId,
          p_stage: "staff",
          p_message_id: String(staffMessageId),
          p_attempt: attempt,
        });
        if (checkpoint.error) {
          throw new Error(checkpoint.error.message || "保存員工派單訊息失敗", {
            cause: checkpoint.error,
          });
        }
      }

      if (!controlMessageId) {
        const existing = await findControlPanel(customerChannel, currentOrder);
        const message = existing || (await sendControlPanel(customerChannel, currentOrder));
        controlMessageId = message?.id || null;
        if (!controlMessageId) throw new Error("客服操作面板未回傳 message id");
        const checkpoint = await supabase.rpc("qiunai_checkpoint_order_dispatch", {
          p_order_id: orderId,
          p_guild_id: tenantGuildId,
          p_stage: "control",
          p_message_id: String(controlMessageId),
          p_attempt: attempt,
        });
        if (checkpoint.error) {
          throw new Error(checkpoint.error.message || "保存客服操作面板失敗", {
            cause: checkpoint.error,
          });
        }
      }

      const completed = await supabase.rpc("qiunai_complete_order_dispatch", {
        p_order_id: orderId,
        p_guild_id: tenantGuildId,
        p_attempt: attempt,
      });
      if (completed.error) {
        throw new Error(completed.error.message || "完成派單標記失敗", {
          cause: completed.error,
        });
      }
      return {
        state: DISPATCH_STATE.DISPATCHED,
        staffMessageId,
        controlMessageId,
        alreadyDispatched: false,
      };
    } catch (dispatchError) {
      try {
        await supabase.rpc("qiunai_fail_order_dispatch", {
          p_order_id: orderId,
          p_guild_id: tenantGuildId,
          p_error: String(dispatchError?.message || dispatchError).slice(0, 1500),
          p_attempt: attempt,
        });
      } catch {
        // 原始派單錯誤優先回報；failed checkpoint 下次仍會由逾時 claim 接手。
      }
      throw dispatchError;
    }
  };
}

module.exports = {
  DISPATCH_STATE,
  createPaidOrderDispatcher,
  normalizeClaim,
};
