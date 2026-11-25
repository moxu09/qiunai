// /app/tips: in-app 打賞 for 秋奈, paid from the customer's ASD wallet only.
// No new payment logic: the charge goes through index.js payTipAllocationsWithWalletAtomic
// (RPC pay_tip_with_wallet_atomic), then the same post-payment notifications as the Discord
// wallet confirm handler (VIP spend count, companion work reports, public broadcast).
// Not posted: anything the Discord flow sends into the customer's own tip ticket channel
// (completion embeds, close buttons, receipt) -- the customer sees the result in the APP.
const { createHash } = require("node:crypto");
const { buildTipAllocations, hasSelfTip } = require("./tips");

// Same value as events/dispatchSystem.js TIP_ORDER_PANEL_CHANNEL_ID (checked by a test).
// Used only as the RPC's p_channel_id source record; nothing is posted there.
const TIP_ORDER_PANEL_CHANNEL_ID = "1531515179559551047";
const UNAVAILABLE = "打賞暫時無法完成，請稍後再試";
const IN_PROGRESS = "這筆打賞正在處理中";
const SOURCES = ["order-form", "order", "standalone"];
const KNOWN_VALIDATION_ERRORS = ["不能打賞自己"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_ID = /^\d{17,20}$/;
const MAX_STAFF = 25;
const MAX_LINES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function staffName(staff) {
  // Same fallback chain as the Discord tip staff picker (sendTipStaffPicker).
  return String(staff.display_name || staff.real_name || staff.discord_name || staff.name || staff.discord_id).slice(0, 100);
}

function parseBalanceError(message) {
  const match = String(message).match(/目前餘額\s*([\d,]+(?:\.\d+)?)\s*ASD[，,]\s*需要\s*([\d,]+(?:\.\d+)?)\s*ASD/);
  const number = text => (text == null ? null : Number(text.replaceAll(",", "")));
  return { balance: number(match?.[1]), need: number(match?.[2]) };
}

function createAppTips({
  guildId,
  gifts = require("../config/tipGifts"),
  listActiveStaff,
  payTipAllocations,
  countOrderVipSpentOnce,
  sendTipWorkReports,
  sendTipBroadcast,
  channelId = TIP_ORDER_PANEL_CHANNEL_ID,
  maxEntries = 1000,
  ttlMs = DAY_MS,
  now = Date.now,
  logger = console,
} = {}) {
  const giftByKey = new Map(gifts.filter(gift => !gift.customPrice && gift.key !== "tip_custom").map(gift => [gift.key, gift]));
  // requestId -> { state: "pending"|"done", fingerprint, result, at }. In-memory, per process.
  const requests = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of requests) {
      if (entry.state === "done" && entry.at < cutoff) requests.delete(key);
    }
    for (const [key, entry] of requests) {
      if (requests.size <= maxEntries) break;
      if (entry.state === "done") requests.delete(key);
    }
  }

  async function activeStaff() {
    const list = (await listActiveStaff()) || [];
    const seen = new Map();
    for (const staff of list) {
      const id = String(staff?.discord_id || "").trim();
      if (!id || staff.is_active === false || seen.has(id)) continue;
      seen.set(id, staff);
    }
    return seen;
  }

  const wrongGuild = value => value != null && String(value) !== String(guildId);

  async function catalog(query = {}) {
    if (!guildId) return { status: 503, body: { error: UNAVAILABLE } };
    if (wrongGuild(query.guildId)) return { status: 400, body: { error: "不支援的伺服器" } };
    let staff = [];
    try {
      staff = [...(await activeStaff()).values()].map(row => ({ discordId: String(row.discord_id).trim(), name: staffName(row) }));
    } catch (error) {
      logger.error("[APP 打賞] 讀取陪陪清單失敗", error?.message || error);
      return { status: 503, body: { error: UNAVAILABLE } };
    }
    return {
      status: 200,
      body: {
        gifts: [...giftByKey.values()].map(({ key, name, price }) => ({ key, name, price })),
        staff,
        discordTipUrl: `https://discord.com/channels/${guildId}/${TIP_ORDER_PANEL_CHANNEL_ID}`,
      },
    };
  }

  // Shape/format validation only; staff membership is checked against the live list afterwards.
  function validate(body) {
    const bad = error => ({ error });
    if (!isPlainObject(body)) return bad("請求格式錯誤");
    if (wrongGuild(body.guildId)) return bad("不支援的伺服器");
    if (typeof body.userId !== "string" || !DISCORD_ID.test(body.userId)) return bad("會員資料錯誤，請重新登入");
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return bad("打賞請求編號錯誤，請重新操作");
    if (!SOURCES.includes(body.source)) return bad("打賞來源錯誤");
    if (body.orderRef != null && (typeof body.orderRef !== "string" || body.orderRef.length > 100)) return bad("訂單編號格式錯誤");
    const broadcast = body.broadcast;
    if (!isPlainObject(broadcast) || typeof broadcast.enabled !== "boolean" || typeof broadcast.anonymous !== "boolean") {
      return bad("請選擇是否公開播報");
    }
    if (!Array.isArray(body.allocations) || !body.allocations.length) return bad("請選擇受賞陪陪與禮物");
    if (body.allocations.length > MAX_STAFF) return bad(`一次最多打賞 ${MAX_STAFF} 位陪陪`);
    const staffIds = new Set();
    const allocations = [];
    for (const allocation of body.allocations) {
      if (!isPlainObject(allocation) || typeof allocation.staffId !== "string" || !DISCORD_ID.test(allocation.staffId)) {
        return bad("受賞陪陪資料錯誤");
      }
      if (staffIds.has(allocation.staffId)) return bad("同一位陪陪請合併在同一筆");
      staffIds.add(allocation.staffId);
      if (!Array.isArray(allocation.lines) || !allocation.lines.length) return bad("每位陪陪至少選擇一項禮物");
      if (allocation.lines.length > MAX_LINES) return bad(`每位陪陪最多 ${MAX_LINES} 項禮物`);
      const keys = new Set();
      const lines = [];
      for (const line of allocation.lines) {
        const gift = isPlainObject(line) && typeof line.key === "string" ? giftByKey.get(line.key) : null;
        if (!gift) return bad("禮物不存在或無法在 APP 打賞");
        if (keys.has(gift.key)) return bad("同一項禮物請合併數量");
        keys.add(gift.key);
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) return bad("禮物數量須為 1～999 的整數");
        lines.push({ key: gift.key, name: gift.name, price: gift.price, quantity: line.quantity });
      }
      allocations.push({ staffId: allocation.staffId, lines });
    }
    if (hasSelfTip(body.userId, [...staffIds])) return bad("不能打賞自己");
    return { allocations, broadcast: { enabled: broadcast.enabled, anonymous: broadcast.anonymous } };
  }

  async function notifyAfterPayment({ payment, tipperId, allocations, broadcast, operationKey }) {
    // Same order as confirm_tip_wallet_ in index.js. Payment already succeeded, so each step
    // only logs on failure; the customer still gets the success result.
    for (const order of payment.orders || []) {
      try {
        await countOrderVipSpentOnce(order, "APP 錢包打賞付款完成");
      } catch (error) {
        logger.error(`[APP 打賞] VIP 累積消費計算失敗 ${order?.id}`, error?.message || error);
      }
    }
    try {
      await sendTipWorkReports(payment.orders || [], { tipperId });
    } catch (error) {
      logger.error("[APP 打賞] 陪陪報單發送失敗", error?.message || error);
    }
    if (!broadcast.enabled) return;
    try {
      // No channelId: sendTipBroadcastSafely's receipt (which posts to tipData.channelId,
      // the Discord tip ticket) is skipped. flowId keeps the broadcast nonces stable.
      await sendTipBroadcast({
        flowId: operationKey,
        tipperId,
        broadcastEnabled: true,
        broadcastAnonymous: broadcast.anonymous,
        allocations,
      });
    } catch (error) {
      logger.error("[APP 打賞] 公開播報失敗", error?.message || error);
    }
  }

  function paymentError(error) {
    const message = String(error?.message || "");
    if (message.includes("餘額不足")) {
      const { balance, need } = parseBalanceError(message);
      return { status: 402, body: { error: /[一-鿿]/.test(message) ? message : "ASD 餘額不足", balance, need } };
    }
    const known = KNOWN_VALIDATION_ERRORS.find(text => message.includes(text));
    if (known) return { status: 400, body: { error: known } };
    logger.error("[APP 打賞] 錢包扣款失敗", message || error);
    return { status: 503, body: { error: UNAVAILABLE } };
  }

  async function tip(body) {
    if (!guildId) return { status: 503, body: { error: UNAVAILABLE } };
    const checked = validate(body);
    if (checked.error) return { status: 400, body: { error: checked.error } };
    const tipperId = body.userId;
    const operationKey = `${guildId}:app-tip:${body.requestId.toLowerCase()}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([tipperId, checked.allocations, checked.broadcast]))
      .digest("hex");

    prune();
    const existing = requests.get(operationKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { status: 409, body: { error: "此打賞請求編號已用於另一筆打賞" } };
      if (existing.state === "pending") return { status: 409, body: { error: IN_PROGRESS } };
      return existing.result;
    }
    // Claim synchronously, before any await, so a concurrent duplicate sees "pending".
    requests.set(operationKey, { state: "pending", fingerprint, at: now() });
    try {
      let staff;
      try {
        staff = await activeStaff();
      } catch (error) {
        logger.error("[APP 打賞] 讀取陪陪清單失敗", error?.message || error);
        requests.delete(operationKey);
        return { status: 503, body: { error: UNAVAILABLE } };
      }
      if (checked.allocations.some(allocation => !staff.has(allocation.staffId))) {
        requests.delete(operationKey);
        return { status: 400, body: { error: "選擇的陪陪目前無法接受打賞" } };
      }
      const allocations = buildTipAllocations({ allocations: checked.allocations });
      const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
      if (allocations.length !== checked.allocations.length || !(total > 0)) {
        requests.delete(operationKey);
        return { status: 400, body: { error: "打賞金額必須大於 0" } };
      }
      let payment;
      try {
        payment = await payTipAllocations({
          operationKey,
          heartFlowId: null,
          guildId,
          tipperId,
          allocations,
          channelId,
        });
      } catch (error) {
        requests.delete(operationKey);
        return paymentError(error);
      }
      await notifyAfterPayment({ payment: payment || {}, tipperId, allocations, broadcast: checked.broadcast, operationKey });
      const balance = payment?.balance == null ? null : Number(payment.balance);
      const result = {
        status: 200,
        body: {
          ok: true,
          total,
          balance,
          orders: (payment?.orders || []).map(order => ({
            id: order.id,
            staffId: String(order.assigned_player || order.discord_id || ""),
            amount: Number(order.final_price ?? order.price ?? 0),
          })),
        },
      };
      requests.set(operationKey, { state: "done", fingerprint, result, at: now() });
      prune();
      return result;
    } catch (error) {
      // Unexpected failure after the claim: keep pending entries from leaking.
      if (requests.get(operationKey)?.state === "pending") requests.delete(operationKey);
      logger.error("[APP 打賞] 處理失敗", error?.message || error);
      return { status: 503, body: { error: UNAVAILABLE } };
    }
  }

  return { catalog, tip, size: () => requests.size };
}

module.exports = { createAppTips, TIP_ORDER_PANEL_CHANNEL_ID, parseBalanceError };
