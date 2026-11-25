// /app/tips: in-app 打賞 for 秋奈, paid from the customer's ASD wallet only.
// No new payment logic: the charge goes through index.js payTipAllocationsWithWalletAtomic
// (one RPC pay_tip_with_wallet_atomic per item+amount group, keys `${operationKey}:${i}`),
// then the same post-payment notifications as the Discord wallet confirm handler (VIP spend
// count, companion work reports, public broadcast). Not posted: anything the Discord flow
// sends into the customer's own tip ticket channel (completion embeds, close buttons,
// receipt) -- the customer sees the result in the APP.
//
// Retry safety: the basket is canonicalised (staff and lines sorted) so the same requestId
// always yields the same group keys; the RPC returns its stored result for keys already
// paid and charges only the rest. Before each group RPC, tip_payment_operations is read by
// that group's key: rows that already existed are replays (no notifications) and must
// match this basket. Notifications run after the response, only for newly paid groups.
const { createHash } = require("node:crypto");
const { buildTipAllocations, hasSelfTip } = require("./tips");

// Same value as events/dispatchSystem.js TIP_ORDER_PANEL_CHANNEL_ID (checked by a test).
// Used only as the RPC's p_channel_id source record; nothing is posted there.
const TIP_ORDER_PANEL_CHANNEL_ID = "1531515179559551047";
const UNAVAILABLE = "打賞暫時無法完成，請稍後再試";
const IN_PROGRESS = "這筆打賞正在處理中";
const CHANGED = "這筆打賞內容已變更，請重新確認";
const PARTIAL = "部分打賞已完成，請重試以完成其餘部分（不會重複扣款）";
const UNCERTAIN = "打賞結果確認中，請到錢包確認後用同一筆重試（不會重複扣款）";
const SOURCES = ["order-form", "order", "standalone"];
const KNOWN_VALIDATION_ERRORS = ["不能打賞自己"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_ID = /^\d{17,20}$/;
const CJK = /[一-鿿]/;
const MAX_STAFF = 25;
const MAX_LINES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Public name only (qiunai_staff.display_name, as the APP companion list shows); never
// real_name. Staff without one are not offered in the APP.
function publicName(staff) {
  return String(staff?.display_name || "").trim().slice(0, 100);
}

function parseBalanceError(message) {
  const match = String(message).match(/目前餘額\s*([\d,]+(?:\.\d+)?)\s*ASD[，,]\s*需要\s*([\d,]+(?:\.\d+)?)\s*ASD/);
  const number = text => (text == null ? null : Number(text.replaceAll(",", "")));
  return { balance: number(match?.[1]), need: number(match?.[2]) };
}

// A stored tip_payment_operations row must be for this tipper and this group.
function storedMatchesGroup(row, tipperId, group) {
  if (String(row?.user_id || "") !== String(tipperId)) return false;
  const orders = Array.isArray(row?.result?.orders) ? row.result.orders : [];
  const paidStaff = orders.map(order => String(order?.assigned_player || "")).sort(byText);
  const wantStaff = group.staffIds.map(String).sort(byText);
  if (paidStaff.length !== wantStaff.length || paidStaff.some((id, i) => id !== wantStaff[i])) return false;
  return orders.every(order => Number(order.final_price ?? order.price) === Number(group.amount) &&
    (order.order_item == null || String(order.order_item) === String(group.item)));
}

class StopError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // "changed" | "lookup"
    this.cause = cause;
  }
}

function createAppTips({
  guildId,
  gifts = require("../config/tipGifts"),
  listActiveStaff,
  payTipAllocations,
  lookupTipOperation,
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
  // operationKey -> { state: "pending"|"failed"|"done", fingerprint, attempted, uncertainKeys, result, at }.
  // In-memory, per process; the durable replay check is lookupTipOperation.
  const requests = new Map();
  const background = new Set();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of requests) {
      if (entry.state !== "pending" && entry.at < cutoff) requests.delete(key);
    }
    for (const [key, entry] of requests) {
      if (requests.size <= maxEntries) break;
      if (entry.state !== "pending") requests.delete(key);
    }
  }

  async function activeStaff() {
    const list = (await listActiveStaff()) || [];
    const seen = new Map();
    for (const staff of list) {
      const id = String(staff?.discord_id || "").trim();
      if (!id || staff.is_active === false || !publicName(staff) || seen.has(id)) continue;
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
      staff = [...(await activeStaff()).values()].map(row => ({ discordId: String(row.discord_id).trim(), name: publicName(row) }));
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
  // Returns the canonical basket: staff sorted by id, lines sorted by gift key.
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
      lines.sort((a, b) => byText(a.key, b.key));
      allocations.push({ staffId: allocation.staffId, lines });
    }
    if (hasSelfTip(body.userId, [...staffIds])) return bad("不能打賞自己");
    allocations.sort((a, b) => byText(a.staffId, b.staffId));
    return { allocations, broadcast: { enabled: broadcast.enabled, anonymous: broadcast.anonymous } };
  }

  async function notifyAfterPayment({ groups, allocations, tipperId, broadcast, operationKey }) {
    // Same order as confirm_tip_wallet_ in index.js, for newly paid groups only.
    const orders = groups.flatMap(group => group.payment?.orders || []);
    for (const order of orders) {
      try {
        await countOrderVipSpentOnce(order, "APP 錢包打賞付款完成");
      } catch (error) {
        logger.error(`[APP 打賞] VIP 累積消費計算失敗 ${order?.id}`, error?.message || error);
      }
    }
    try {
      await sendTipWorkReports(orders, { tipperId });
    } catch (error) {
      logger.error("[APP 打賞] 陪陪報單發送失敗", error?.message || error);
    }
    if (!broadcast.enabled) return;
    const paidAllocations = allocations.filter(allocation => groups.some(group =>
      group.item === allocation.item && Number(group.amount) === Number(allocation.amount) &&
      group.staffIds.includes(allocation.staffId)));
    if (!paidAllocations.length) return;
    try {
      // No channelId: sendTipBroadcastSafely's receipt (which posts to tipData.channelId,
      // the Discord tip ticket) is skipped. flowId keeps the broadcast nonces stable.
      await sendTipBroadcast({
        flowId: operationKey,
        tipperId,
        broadcastEnabled: true,
        broadcastAnonymous: broadcast.anonymous,
        allocations: paidAllocations,
      });
    } catch (error) {
      logger.error("[APP 打賞] 公開播報失敗", error?.message || error);
    }
  }

  // Runs after the response; never awaited by it. Errors are logged only.
  function startNotifications(args) {
    if (!args.groups.length) return;
    const task = notifyAfterPayment(args)
      .catch(error => logger.error("[APP 打賞] 付款後通知失敗", error?.message || error))
      .finally(() => background.delete(task));
    background.add(task);
  }

  // The thrown error is known to have rolled back its group (RPC raise / validation / our own stop).
  function isDefinite(error) {
    if (error instanceof StopError) return true;
    return CJK.test(String(error?.message || ""));
  }

  function nothingChargedError(error) {
    if (error instanceof StopError) {
      if (error.kind === "changed") return { status: 409, body: { error: CHANGED } };
      logger.error("[APP 打賞] 讀取付款紀錄失敗", error.cause?.message || error.cause);
      return { status: 503, body: { error: UNAVAILABLE } };
    }
    const message = String(error?.message || "");
    if (message.includes("餘額不足")) {
      const { balance, need } = parseBalanceError(message);
      return { status: 402, body: { error: message, balance, need } };
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
    const fingerprint = createHash("sha256").update(JSON.stringify([tipperId, checked.allocations])).digest("hex");

    prune();
    let entry = requests.get(operationKey);
    if (entry) {
      if (entry.fingerprint !== fingerprint) return { status: 409, body: { error: CHANGED } };
      if (entry.state === "pending") return { status: 409, body: { error: IN_PROGRESS } };
      if (entry.state === "done") return entry.result;
      entry.state = "pending"; // "failed": retry the same basket
      entry.at = now();
    } else {
      // Claim synchronously, before any await, so a concurrent duplicate sees "pending".
      entry = { state: "pending", fingerprint, attempted: false, uncertainKeys: new Set(), at: now() };
      requests.set(operationKey, entry);
    }
    const settle = (state, result) => {
      // Never forget a request once a group RPC may have run; otherwise it may start over.
      if (state === "failed" && !entry.attempted) requests.delete(operationKey);
      else Object.assign(entry, { state, result, at: now() });
      prune();
      return result;
    };

    let staff;
    try {
      staff = await activeStaff();
    } catch (error) {
      logger.error("[APP 打賞] 讀取陪陪清單失敗", error?.message || error);
      return settle("failed", { status: 503, body: { error: UNAVAILABLE } });
    }
    if (checked.allocations.some(allocation => !staff.has(allocation.staffId))) {
      return settle("failed", { status: 400, body: { error: "選擇的陪陪目前無法接受打賞" } });
    }
    const allocations = buildTipAllocations({ allocations: checked.allocations });
    const total = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    if (allocations.length !== checked.allocations.length || !(total > 0)) {
      return settle("failed", { status: 400, body: { error: "打賞金額必須大於 0" } });
    }

    const paidGroups = []; // { index, operationKey, item, amount, staffIds, payment, fresh }
    const preExisting = new Set();
    let currentKey = null;
    let payment;
    try {
      payment = await payTipAllocations({
        operationKey,
        heartFlowId: null,
        guildId,
        tipperId,
        allocations,
        channelId,
        beforeGroup: async group => {
          let row;
          try {
            row = await lookupTipOperation(group.operationKey);
          } catch (error) {
            throw new StopError("lookup", error);
          }
          if (row) {
            if (!storedMatchesGroup(row, tipperId, group)) throw new StopError("changed");
            // Paid earlier. Still notify if this process saw that earlier attempt end uncertain.
            if (!entry.uncertainKeys.has(group.operationKey)) preExisting.add(group.operationKey);
          }
          currentKey = group.operationKey;
          entry.attempted = true;
        },
        afterGroup: async group => {
          paidGroups.push({ ...group, fresh: !preExisting.has(group.operationKey) });
          entry.uncertainKeys.delete(group.operationKey);
          currentKey = null;
        },
      });
    } catch (error) {
      const fresh = paidGroups.filter(group => group.fresh);
      startNotifications({ groups: fresh, allocations, tipperId, broadcast: checked.broadcast, operationKey });
      if (!isDefinite(error)) {
        if (currentKey) entry.uncertainKeys.add(currentKey);
        logger.error("[APP 打賞] 錢包扣款結果不明", error?.message || error);
        return settle("failed", { status: 503, body: { error: UNCERTAIN, uncertain: true } });
      }
      if (paidGroups.length) {
        if (!(error instanceof StopError)) logger.error("[APP 打賞] 部分打賞失敗", error?.message || error);
        const partial = { error: PARTIAL, partial: true, paidStaffIds: [...new Set(paidGroups.flatMap(group => group.staffIds.map(String)))] };
        if (String(error?.message || "").includes("餘額不足")) Object.assign(partial, parseBalanceError(error.message));
        return settle("failed", { status: 502, body: partial });
      }
      return settle("failed", nothingChargedError(error));
    }

    const fresh = paidGroups.filter(group => group.fresh);
    const result = {
      status: 200,
      body: {
        ok: true,
        total,
        balance: payment?.balance == null ? null : Number(payment.balance),
        orders: (payment?.orders || []).map(order => ({
          id: order.id,
          staffId: String(order.assigned_player || order.discord_id || ""),
          amount: Number(order.final_price ?? order.price ?? 0),
        })),
      },
    };
    settle("done", result);
    // Every group already existed before this request: a replay, so no notifications.
    startNotifications({ groups: fresh, allocations, tipperId, broadcast: checked.broadcast, operationKey });
    return result;
  }

  return {
    catalog,
    tip,
    size: () => requests.size,
    idle: async () => { while (background.size) await Promise.all([...background]); },
  };
}

module.exports = { createAppTips, TIP_ORDER_PANEL_CHANNEL_ID, parseBalanceError };
