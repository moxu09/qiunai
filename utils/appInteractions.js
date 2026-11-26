// POST /app/interactions（經 appBridge 簽章）：APP 訂單對話裡按小奈的按鈕／選單／表單，效果與在 Discord 按完全相同。
//
// 防偽造：APP 只能按「小奈真的在這位老闆自己的訂單頻道裡顯示過」且「在客人白名單裡」的元件。
//   1. customId 必須符合 CUSTOMER_INTERACTIONS（客人可按的明確白名單；客服／陪陪／管理員按鈕一律不在其中）。
//   2. 頻道必須是這位老闆自己的訂單頻道（play_orders.customer_id、頻道 topic owner:<id> 或下單流程 payload），
//      且老闆仍在伺服器、看得到這個頻道。
//   3. 頻道訊息：重新向 Discord 讀取訊息，必須是小奈本人發的，上面要真的有這個 customId 的元件、未停用；
//      選單的值必須是選單上真的有的選項、數量符合 min/max。
//   4. 只有自己看得到的回覆（ephemeral）與表單（modal）不在頻道裡，改由伺服器發一次性 token 記住小奈真的回了什麼，
//      15 分鐘內只有同一位老闆、同一個頻道能用，而且只能按 token 記住的元件／送 token 記住的表單欄位。
// 通過後組一個與 discord.js 相同介面的假 interaction（user／member 是 Discord 上真的這位老闆），交給與真實
// interactionCreate 完全相同的路由（index.js handleInteractionEvent），所以每個處理函式原本的擁有者、狀態、
// 金額、重複點擊與鎖定檢查都照常執行。回傳老闆在 Discord 會看到的內容（私人回覆、表單、訊息是否更新）。
const { randomBytes } = require("node:crypto");
const { PermissionFlagsBits } = require("discord.js");

const SNOWFLAKE = /^\d{16,22}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const CUSTOM_ID_MAX = 100;
const UNAVAILABLE = "暫時無法完成這個操作，請稍後再試或到 Discord 操作";
const TOKEN_TTL_MS = 15 * 60_000;
const HANDLER_TIMEOUT_MS = 20_000;
const MAX_TOKENS_PER_USER = 60;

// 客人可在自己的訂單頻道按的元件。每一項：比對方式、customId、可用的元件種類、做什麼、為什麼客人按是安全的。
// 處理函式本身都會再檢查「下單者本人」（多數為 canCustomerOrStaffSubmit 或 customer_id === user.id）。
const CUSTOMER_INTERACTIONS = Object.freeze([
  // ---- 人工報價／派單 ----
  ["prefix", "manual_quote_dispatch_", ["button"], "確認報價並正式派單", "下單者確認自己的報價；處理函式檢查下單者、未付款、quote_status=quoted"],
  ["prefix", "manual_quote_cancel_", ["button"], "取消人工報價訂單", "下單者取消自己尚未付款的報價單"],
  ["prefix", "quote_confirm_price_", ["button"], "確認報價金額", "下單者確認自己的報價（quoted→price_confirmed）"],
  // ---- 自助下單：報價、選人、延長、取消 ----
  ["prefix", "self_service_quote_yes_", ["button"], "確認自助報價並開始派單", "下單者確認自己的報價"],
  ["prefix", "self_service_quote_no_", ["button"], "報價頁按錯了取消訂單", "只取消未付款、仍在 quoted 的自己的單"],
  ["prefix", "self_service_cancel_refund_", ["button"], "選人階段取消（已扣 ASD 原路退回）", "下單者本人；退款走既有 RPC，金額由訂單決定"],
  ["prefix", "self_selection_extend_", ["button"], "延長派單時間（+5 分鐘，限一次）", "與 /app/orders/extend-dispatch 同一核心"],
  ["prefix", "self_customer_numbers_", ["select"], "用數字選擇要的陪陪", "下單者選自己的候選名單；數字需在名單內、人數需符合"],
  ["prefix", "self_players_confirm_", ["button"], "確定選擇陪陪", "下單者確認自己選的陪陪"],
  ["prefix", "self_players_reselect_", ["button"], "重新派單", "下單者重新開放自己的單"],
  // ---- 自助下單：付款（六種付款方式） ----
  ["prefix", "self_service_prepare_", ["button"], "選擇付款方式（街口、線上刷卡、匯款帳號、超商條碼、超商代碼、錢包扣款）", "只回覆確認畫面，不扣款；檢查 customer_id === user.id"],
  ["prefix", "self_service_payment_back_", ["button"], "返回付款方式", "只改私人回覆"],
  ["prefix", "self_service_cancel_order_", ["button"], "付款前按錯了取消訂單", "只取消未付款、且沒有付款單的自己的單"],
  ["prefix", "self_service_pay_wallet_", ["button"], "確認錢包（ASD）扣款", "只扣下單者本人的錢包；金額取自訂單，customer_id === user.id"],
  ["prefix", "self_service_pay_jkopay_", ["button"], "確認街口支付", "建立自己訂單的付款單；customer_id === user.id"],
  ["prefix", "self_service_pay_ecpay_", ["button"], "確認綠界付款（刷卡／ATM／超商）", "建立自己訂單的付款單；customer_id === user.id"],
  ["prefix", "self_service_pay_bank_", ["button"], "確認匯款帳號（綠界 ATM）", "建立自己訂單的付款單；customer_id === user.id"],
  ["prefix", "self_service_extend_", ["button"], "我要加時（開啟加時表單）", "下單者本人、已付款並安排陪陪才可開啟"],
  ["prefix", "self_service_extension_submit_", ["modal"], "送出加時表單", "只能送出小奈開給這位老闆的表單"],
  // ---- 一般訂單：優惠券、點數、付款 ----
  ["prefix", "quote_use_coupon_", ["button"], "使用優惠券（列出自己的優惠券）", "只讀下單者本人的 user_items"],
  ["prefix", "quote_no_coupon_", ["button"], "不使用優惠券", "下單者本人"],
  ["prefix", "quote_select_coupon_", ["select"], "選擇要使用的優惠券", "券必須屬於 user.id；套用走 qiunai_apply_quote_coupon RPC"],
  ["prefix", "quote_disable_points_", ["button"], "關閉點數折抵", "只能關閉自己未付款訂單的點數"],
  ["prefix", "quote_payment_method_", ["button", "select"], "選擇付款方式（一般訂單）", "customer_id === user.id；先回確認畫面再建立付款"],
  ["exact", "payment_review_back", ["button"], "返回付款方式", "只改私人回覆"],
  ["prefix", "service_confirm_quote_", ["button"], "確認報價（服務需求）", "下單者本人"],
  ["prefix", "service_use_coupon_", ["button"], "使用優惠券（服務需求）", "只讀下單者本人的優惠券"],
  ["prefix", "service_no_coupon_", ["button"], "不使用優惠券（服務需求）", "下單者本人"],
  ["prefix", "service_select_coupon_", ["select"], "選擇要使用的優惠券（服務需求）", "券必須屬於下單者"],
  ["prefix", "service_disable_points_", ["button"], "關閉點數折抵（服務需求）", "下單者本人、尚未進入付款"],
  ["prefix", "service_payment_method_", ["button", "select"], "選擇付款方式（服務需求）", "只有下單者本人（user.id === pending.customerId）"],
  ["prefix", "service_confirm_wallet_", ["button"], "確認錢包扣款", "下單者本人；金額取自訂單"],
  ["prefix", "service_confirm_monthly_", ["button"], "確認月結付款", "下單者本人的月結帳戶"],
  ["prefix", "service_cancel_wallet_", ["button"], "取消錢包付款", "只回覆提示，不改資料"],
  ["prefix", "service_cancel_monthly_", ["button"], "取消月結付款", "只回覆提示，不改資料"],
  ["prefix", "customer_confirm_order_", ["button"], "確認訂單內容", "下單者本人"],
  ["prefix", "customer_order_wrong_", ["button"], "回報訂單內容有誤", "下單者本人"],
  // ---- 加時付款 ----
  ["prefix", "extension_payment_method_", ["button", "select"], "選擇加時付款方式", "只有加時單的老闆本人（extension.customer_id === user.id）"],
  ["prefix", "confirm_extension_wallet_", ["button"], "確認加時錢包扣款", "下單者本人；金額取自加時單"],
  ["prefix", "cancel_extension_wallet_", ["button"], "取消加時錢包付款", "只回覆提示，不改資料"],
  // ---- 綠界 ----
  ["prefix", "ecpay_direct_", ["button"], "取得 ATM／超商繳費資訊", "付款單 user_id 與頻道都必須是本人"],
  ["prefix", "ecpay_inquiry_", ["button"], "查詢綠界付款結果", "付款單 user_id 與頻道都必須是本人"],
  ["prefix", "ecpay_cancel_unsubmitted_", ["button"], "取消未送出的刷卡付款並返還折抵", "RPC 以 user_id＋頻道限定本人"],
  // ---- 訂單頻道內建單（客服代建／原房加單） ----
  ["prefix", "new_order_game_", ["select"], "選擇遊戲", "下單者、客服或管理員"],
  ["prefix", "new_order_item_", ["select"], "選擇項目", "同上"],
  ["prefix", "new_order_rank_", ["select"], "選擇段位", "同上"],
  ["prefix", "new_order_count_", ["select"], "選擇人數", "同上"],
  ["prefix", "new_order_gender_", ["select"], "選擇性別", "同上"],
  ["prefix", "new_order_duration_", ["select"], "選擇時數", "同上"],
  ["prefix", "new_order_note_yes_", ["button"], "填寫備註（開啟表單）", "同上"],
  ["prefix", "new_order_note_no_", ["button"], "不填備註直接送出", "同上"],
  ["prefix", "new_order_back_", ["button"], "返回上一步", "同上"],
  ["prefix", "submit_new_order_note_", ["modal"], "送出備註表單", "只能送出小奈開給這位老闆的表單"],
  // ---- 服務需求單（官網面板開的私人頻道） ----
  ["prefix", "valorant_type_", ["button", "select"], "特戰英豪：選擇類型", "頻道擁有者本人的需求流程"],
  ["prefix", "valorant_mode_", ["button"], "特戰英豪：選擇模式", "同上"],
  ["prefix", "valorant_rank_", ["select"], "特戰英豪：選擇段位", "同上"],
  ["prefix", "apex_rank_", ["select"], "Apex：選擇段位", "同上"],
  ["prefix", "lol_rank_", ["select"], "英雄聯盟：選擇段位", "同上"],
  ["prefix", "lol_style_select_", ["select"], "英雄聯盟：選擇玩法", "同上"],
  ["prefix", "other_game_style_select_", ["select"], "其他遊戲：選擇玩法", "同上"],
  ["prefix", "service_player_count_", ["select"], "選擇陪陪人數", "同上"],
  ["prefix", "service_gender_", ["select"], "選擇陪陪性別", "同上"],
  ["prefix", "service_duration_", ["select"], "選擇時數", "同上"],
  ["prefix", "service_rounds_", ["select"], "選擇局數", "同上"],
  ["prefix", "steam_category_", ["select"], "Steam：選擇類別", "同上"],
  ["prefix", "delta_mode_", ["select"], "三角洲：選擇模式", "同上"],
  ["prefix", "order_add_note_", ["button"], "新增備註（開啟表單）", "同上"],
  ["prefix", "submit_service_order_note_", ["modal"], "送出備註表單", "只能送出小奈開給這位老闆的表單"],
  ["prefix", "steam_game_name_", ["button"], "填寫 Steam 遊戲名稱（開啟表單）", "同上"],
  ["prefix", "submit_steam_game_name_", ["modal"], "送出 Steam 遊戲名稱", "只能送出小奈開給這位老闆的表單"],
  ["prefix", "order_finish_need_", ["button"], "需求填寫完成送出", "下單者、客服或管理員"],
  // ---- 評價、按錯關閉 ----
  ["prefix", "order_review_", ["button"], "給訂單評價（開啟評價表單）", "只有下單者本人（order.customer_id === user.id）"],
  ["prefix", "review_privacy_order_", ["button"], "切換匿名／公開評價", "只改評價按鈕"],
  ["prefix", "self_service_review_skip_", ["button"], "略過評價", "下單者本人、訂單已完成"],
  ["prefix", "submit_order_review_", ["modal"], "送出訂單評價", "只能送出小奈開給這位老闆的表單；處理函式再檢查下單者"],
  ["exact", "owner_cancel_ticket", ["button"], "我按錯了，關閉頻道", "只有頻道 topic owner 或客服可關；原房加單頻道受保護"],
].map(([match, id, kinds, label, why]) => Object.freeze({ match, id, kinds: Object.freeze(kinds), label, why })));

function allowedEntry(customId, kind) {
  const id = String(customId || "");
  if (!id || id.length > CUSTOM_ID_MAX) return null;
  return CUSTOMER_INTERACTIONS.find((entry) =>
    entry.kinds.includes(kind) && (entry.match === "exact" ? id === entry.id : id.startsWith(entry.id) && id.length > entry.id.length)) || null;
}

// ---------- 元件 JSON ----------
const json = (value) => {
  if (value == null) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data) && value.components === undefined) return { ...value.data };
  return value;
};

function rawRows(components) {
  return (Array.isArray(components) ? components : []).map((row) => {
    const plain = json(row) || {};
    const children = Array.isArray(row?.components) ? row.components : plain.components;
    return { ...plain, components: Array.isArray(children) ? children.map((c) => normalizeComponent(json(c) || {})) : undefined };
  });
}

function normalizeComponent(c) {
  const out = { ...c };
  if (out.custom_id === undefined && out.customId !== undefined) out.custom_id = out.customId;
  if (out.min_values === undefined && out.minValues !== undefined) out.min_values = out.minValues;
  if (out.max_values === undefined && out.maxValues !== undefined) out.max_values = out.maxValues;
  delete out.customId; delete out.minValues; delete out.maxValues;
  if (Array.isArray(out.components)) out.components = out.components.map((child) => normalizeComponent(json(child) || {}));
  if (out.accessory) out.accessory = normalizeComponent(json(out.accessory) || {});
  if (out.component) out.component = normalizeComponent(json(out.component) || {});
  return out;
}

/** Every interactive component (buttons with a custom_id, any select) found anywhere in the rows. */
function interactiveComponents(rows) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if ([2, 3, 5, 6, 7, 8].includes(Number(node.type)) && node.custom_id) found.push(node);
    for (const key of ["components", "accessory", "component"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  };
  rows.forEach(walk);
  return found;
}

function kindOfComponent(component) {
  if (Number(component.type) === 2) return "button";
  if (Number(component.type) === 3) return "select";
  return "other";
}

// ---------- 回覆內容 ----------
function isEphemeral(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ephemeral === true) return true;
  const flags = payload.flags;
  if (flags == null) return false;
  if (typeof flags === "number" || typeof flags === "bigint") return (Number(flags) & 64) === 64;
  if (typeof flags === "string") return flags === "Ephemeral" || flags === "64";
  if (Array.isArray(flags)) return flags.some((flag) => flag === 64 || flag === "Ephemeral" || flag === 64n);
  if (typeof flags.has === "function") { try { return Boolean(flags.has(64)); } catch { return false; } }
  if (flags.bitfield != null) return (Number(flags.bitfield) & 64) === 64;
  return false;
}

function toPayload(payload) {
  return typeof payload === "string" ? { content: payload } : payload && typeof payload === "object" ? payload : {};
}

function stripResponseOnly(payload) {
  const { flags, ephemeral, fetchReply, withResponse, ...rest } = toPayload(payload);
  void flags; void ephemeral; void fetchReply; void withResponse;
  return rest;
}

/** Discord semantics for edits: only the keys present change. */
function applyEdit(view, payload) {
  const p = toPayload(payload);
  if (p.content !== undefined) view.content = p.content == null ? "" : String(p.content);
  if (p.embeds !== undefined) view.embeds = (p.embeds || []).map((embed) => ({ ...(json(embed) || {}) }));
  if (p.components !== undefined) view.components = rawRows(p.components || []);
  if (p.files !== undefined || p.attachments !== undefined) view.attachments = (p.files || p.attachments || []).length;
  return view;
}

function embedText(embed) {
  return {
    title: String(embed?.title || ""),
    description: String(embed?.description || ""),
    fields: (embed?.fields || []).map((field) => ({ name: String(field?.name || ""), value: String(field?.value || "") })),
  };
}

// ---------- 表單 ----------
function modalDefinition(modal) {
  const raw = normalizeComponent(json(modal) || {});
  const inputs = [];
  let unsupported = false;
  const walk = (node, label) => {
    if (!node || typeof node !== "object") return;
    const type = Number(node.type);
    if (type === 4) {
      inputs.push({
        id: String(node.custom_id || ""),
        label: String(node.label || label || ""),
        style: Number(node.style) === 2 ? "paragraph" : "short",
        required: node.required !== false,
        minLength: Number.isInteger(node.min_length) ? node.min_length : 0,
        maxLength: Number.isInteger(node.max_length) ? node.max_length : 4000,
        placeholder: node.placeholder ? String(node.placeholder) : "",
        value: node.value ? String(node.value) : "",
      });
      return;
    }
    if ([2, 3, 5, 6, 7, 8].includes(type)) unsupported = true;
    const nextLabel = type === 18 ? node.label : label;
    if (Array.isArray(node.components)) node.components.forEach((child) => walk(child, nextLabel));
    if (node.component) walk(node.component, nextLabel);
  };
  (raw.components || []).forEach((child) => walk(child));
  if (!inputs.length || inputs.some((input) => !input.id)) unsupported = true;
  return { customId: String(raw.custom_id || ""), title: String(raw.title || ""), inputs, unsupported };
}

class AppInteractionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => { throw new AppInteractionError(status, code, message); };

const ERRORS = Object.freeze({
  invalid_request: [400, "請求格式錯誤"],
  not_allowed: [403, "這個按鈕需要到 Discord 操作"],
  discord_only: [422, "這個按鈕需要到 Discord 操作"],
  not_owner: [403, "只有這張訂單的老闆可以操作"],
  not_member: [403, "請先加入秋奈 Discord 伺服器"],
  channel_not_found: [404, "找不到這段對話"],
  message_not_found: [404, "找不到這則訊息，請重新整理"],
  not_bot_message: [403, "只能操作小奈的訊息"],
  component_not_found: [409, "按鈕已更新，請重新整理後再操作"],
  component_disabled: [409, "這個按鈕已停用"],
  invalid_values: [400, "選擇的項目無效，請重新選擇"],
  invalid_fields: [400, "表單內容不完整，請檢查必填欄位與字數"],
  token_expired: [410, "這個畫面已過期，請重新操作"],
  in_progress: [409, "上一個操作還在處理中，請稍候"],
  unavailable: [503, UNAVAILABLE],
});
const fail = (code) => refuse(ERRORS[code][0], code, ERRORS[code][1]);

function validateBody(value) {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!body) fail("invalid_request");
  const userId = String(body.userId ?? "");
  const channelId = String(body.channelId ?? "");
  if (!SNOWFLAKE.test(userId) || !SNOWFLAKE.test(channelId)) fail("invalid_request");
  const messageId = body.messageId == null ? null : String(body.messageId);
  const replyToken = body.replyToken == null ? null : String(body.replyToken);
  const modalToken = body.modalToken == null ? null : String(body.modalToken);
  const sources = [messageId, replyToken, modalToken].filter((item) => item !== null);
  if (sources.length !== 1) fail("invalid_request");
  if (messageId !== null && !SNOWFLAKE.test(messageId)) fail("invalid_request");
  if (replyToken !== null && !TOKEN.test(replyToken)) fail("invalid_request");
  if (modalToken !== null && !TOKEN.test(modalToken)) fail("invalid_request");
  let customId = null;
  let values;
  let fields;
  if (modalToken !== null) {
    const raw = body.fields;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_request");
    const entries = Object.entries(raw);
    if (entries.length > 10 || entries.some(([key, item]) => key.length > 100 || typeof item !== "string" || item.length > 4000)) fail("invalid_request");
    fields = Object.fromEntries(entries);
  } else {
    customId = typeof body.customId === "string" ? body.customId : "";
    if (!customId || customId.length > CUSTOM_ID_MAX) fail("invalid_request");
    if (body.values !== undefined) {
      if (!Array.isArray(body.values) || body.values.length > 25 ||
        body.values.some((item) => typeof item !== "string" || !item || item.length > 100)) fail("invalid_request");
      values = [...body.values];
    }
  }
  return { userId, channelId, messageId, replyToken, modalToken, customId, values, fields };
}

const CHANNEL_FLOWS = [
  ["qiunai:website-orders", "userId"],
  ["qiunai", "customerId"],
  ["qiunai_general_orders", "userId"],
  ["qiunai_tip_orders", "tipperId"],
];

function createAppInteractions({
  getClient, db, guildId, route, now = Date.now, tokenTtlMs = TOKEN_TTL_MS, timeoutMs = HANDLER_TIMEOUT_MS,
  newToken = () => randomBytes(24).toString("base64url"),
} = {}) {
  /** token -> { kind: "reply"|"modal", userId, channelId, expiresAt, ... } */
  const tokens = new Map();
  const running = new Set();

  function sweep() {
    const t = now();
    for (const [key, entry] of tokens) if (entry.expiresAt <= t) tokens.delete(key);
  }

  function issue(entry) {
    sweep();
    const mine = [...tokens.entries()].filter(([, item]) => item.userId === entry.userId);
    if (mine.length >= MAX_TOKENS_PER_USER) {
      mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      tokens.delete(mine[0][0]);
    }
    const token = newToken();
    tokens.set(token, { ...entry, expiresAt: now() + tokenTtlMs });
    return token;
  }

  function claim(token, kind, userId, channelId) {
    sweep();
    const entry = tokens.get(token);
    if (!entry || entry.kind !== kind || entry.userId !== userId || entry.channelId !== channelId) fail("token_expired");
    return entry;
  }

  async function ownsChannel(userId, channel) {
    const owner = String(channel.topic || "").match(/(?:^|;)owner:(\d{16,22})(?:;|$)/)?.[1];
    if (owner === userId) return true;
    const orders = await db.from("play_orders").select("id")
      .eq("channel_id", channel.id).eq("customer_id", userId)
      .or("is_deleted.is.null,is_deleted.eq.false").limit(1);
    if (orders.error) throw orders.error;
    if (orders.data?.length) return true;
    for (const [org, key] of CHANNEL_FLOWS) {
      const flows = await db.from("bot_service_order_flows").select("organization_code")
        .eq("organization_code", org).eq("payload->>channelId", channel.id).eq(`payload->>${key}`, userId).limit(1);
      if (flows.error) throw flows.error;
      if (flows.data?.length) return true;
    }
    return false;
  }

  async function loadContext(userId, channelId) {
    const client = getClient();
    if (!client?.isReady?.() || !client.user) fail("unavailable");
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) fail("unavailable");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guild.id || !channel.isTextBased?.() || !channel.messages) fail("channel_not_found");
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) fail("not_member");
    if (!(await ownsChannel(userId, channel))) fail("not_owner");
    const permissions = channel.permissionsFor?.(member);
    if (!permissions?.has?.(PermissionFlagsBits.ViewChannel)) fail("not_owner");
    return { client, guild, channel, member, permissions };
  }

  function findComponent(rows, customId) {
    return interactiveComponents(rows).find((component) => component.custom_id === customId) || null;
  }

  function checkComponent(component, kind, values) {
    if (!component) fail("component_not_found");
    if (component.disabled) fail("component_disabled");
    const actual = kindOfComponent(component);
    if (actual === "other") fail("discord_only");
    if (actual !== kind) fail("invalid_request");
    if (kind === "button") {
      if (values !== undefined || Number(component.style) === 5 || component.url) fail("invalid_request");
      return;
    }
    const options = (component.options || []).map((option) => String(option.value));
    const min = Number.isInteger(component.min_values) ? component.min_values : 1;
    const max = Number.isInteger(component.max_values) ? component.max_values : 1;
    if (!values || values.length < min || values.length > max || new Set(values).size !== values.length ||
      values.some((value) => !options.includes(value))) fail("invalid_values");
  }

  /** A message the handler sees as interaction.message for an ephemeral reply (lives only in this bridge). */
  function virtualMessage(view, onEdit) {
    const message = {
      id: view.virtualId,
      flags: { has: (flag) => Number(flag) === 64 || flag === "Ephemeral", bitfield: 64 },
      author: view.author,
      get content() { return view.content; },
      get embeds() { return view.embeds.map((embed) => ({ ...embed, data: embed, toJSON: () => embed })); },
      get components() {
        return view.components.map((row) => ({
          ...row, data: row, toJSON: () => row,
          components: (row.components || []).map((c) => ({
            ...c, data: c, customId: c.custom_id, minValues: c.min_values, maxValues: c.max_values, toJSON: () => c,
          })),
        }));
      },
      async edit(payload) { applyEdit(view, payload); onEdit(); return message; },
      async delete() { view.deleted = true; onEdit(); },
      async fetch() { return message; },
    };
    return message;
  }

  function newView(client, payload) {
    const view = { virtualId: `app-ephemeral-${newToken().slice(0, 12)}`, author: client.user, content: "", embeds: [], components: [], attachments: 0, deleted: false };
    return applyEdit(view, payload);
  }

  /** Builds the discord.js-shaped interaction and records what the customer would see. */
  function buildInteraction(ctx, spec) {
    const { client, guild, channel, member, permissions } = ctx;
    const result = { replies: [], modal: null, messageUpdated: false, sourceReply: spec.sourceView || null };
    let replyView = null;
    let replyPublic = null;
    let replyKind = null; // "ephemeral" | "public" | "source"
    const source = spec.message;

    const ensureNotAnswered = (interaction) => {
      if (interaction.deferred || interaction.replied) {
        const error = new Error("The reply to this interaction has already been sent or deferred.");
        error.code = "InteractionAlreadyReplied";
        throw error;
      }
    };
    const pushEphemeral = (payload) => {
      const view = newView(client, payload);
      result.replies.push(view);
      return view;
    };
    const sendPublic = async (payload) => channel.send(stripResponseOnly(payload));
    const editSource = async (payload) => {
      if (spec.sourceView) {
        applyEdit(spec.sourceView, payload);
        return virtualMessage(spec.sourceView, () => {});
      }
      const edited = await source.edit(stripResponseOnly(payload));
      result.messageUpdated = true;
      return edited;
    };

    const fields = spec.fields || {};
    const interaction = {
      id: `app-${newToken().slice(0, 16)}`,
      applicationId: client.application?.id || client.user.id,
      type: spec.kind === "modal" ? 5 : 3,
      componentType: spec.kind === "button" ? 2 : spec.kind === "select" ? 3 : undefined,
      customId: spec.customId,
      values: spec.kind === "select" ? [...spec.values] : undefined,
      client, user: member.user, member, memberPermissions: permissions,
      guild, guildId: guild.id, channel, channelId: channel.id,
      message: source || null,
      component: spec.component ? { ...spec.component, customId: spec.component.custom_id, data: spec.component, toJSON: () => spec.component } : null,
      locale: "zh-TW", guildLocale: guild.preferredLocale || "zh-TW",
      deferred: false, replied: false, ephemeral: null,
      createdTimestamp: now(),
      fromApp: true,
      inGuild: () => true, inCachedGuild: () => true, inRawGuild: () => false,
      isRepliable: () => true,
      isButton: () => spec.kind === "button",
      isStringSelectMenu: () => spec.kind === "select",
      isSelectMenu: () => spec.kind === "select",
      isAnySelectMenu: () => spec.kind === "select",
      isMessageComponent: () => spec.kind !== "modal",
      isModalSubmit: () => spec.kind === "modal",
      isFromMessage: () => spec.kind === "modal" && Boolean(source),
      isChatInputCommand: () => false, isCommand: () => false, isAutocomplete: () => false,
      isContextMenuCommand: () => false, isUserSelectMenu: () => false, isRoleSelectMenu: () => false,
      isChannelSelectMenu: () => false, isMentionableSelectMenu: () => false,
      fields: spec.kind === "modal" ? {
        fields: new Map(Object.entries(fields).map(([key, value]) => [key, { customId: key, type: 4, value }])),
        getTextInputValue(key) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) {
            const error = new TypeError(`Field with custom id "${key}" not found.`);
            error.code = "ModalSubmitInteractionFieldNotFound";
            throw error;
          }
          return fields[key];
        },
        getField(key) { return { customId: key, type: 4, value: this.getTextInputValue(key) }; },
      } : undefined,

      async deferReply(options = {}) {
        ensureNotAnswered(this);
        this.deferred = true;
        this.ephemeral = isEphemeral(options);
        replyKind = this.ephemeral ? "ephemeral" : "public";
        if (this.ephemeral) replyView = pushEphemeral({});
        return undefined;
      },
      async deferUpdate() {
        ensureNotAnswered(this);
        if (spec.kind === "modal" && !source) throw new Error("deferUpdate needs a message");
        this.deferred = true;
        replyKind = "source";
        return undefined;
      },
      async reply(payload) {
        ensureNotAnswered(this);
        this.replied = true;
        this.ephemeral = isEphemeral(payload);
        replyKind = this.ephemeral ? "ephemeral" : "public";
        if (this.ephemeral) {
          replyView = pushEphemeral(payload);
          return virtualMessage(replyView, () => {});
        }
        replyPublic = await sendPublic(payload);
        return replyPublic;
      },
      async update(payload) {
        ensureNotAnswered(this);
        if (spec.kind === "modal" && !source) throw new Error("update needs a message");
        this.replied = true;
        replyKind = "source";
        return editSource(payload);
      },
      async editReply(payload) {
        if (!this.deferred && !this.replied) {
          const error = new Error("The reply to this interaction has not been sent or deferred.");
          error.code = "InteractionNotReplied";
          throw error;
        }
        this.replied = true;
        if (replyKind === "source") return editSource(payload);
        if (replyKind === "ephemeral") {
          applyEdit(replyView, payload);
          return virtualMessage(replyView, () => {});
        }
        if (replyPublic) {
          replyPublic = await replyPublic.edit(stripResponseOnly(payload));
          return replyPublic;
        }
        replyPublic = await sendPublic(payload);
        return replyPublic;
      },
      async fetchReply() {
        if (replyKind === "ephemeral") return virtualMessage(replyView, () => {});
        if (replyKind === "source") return source;
        return replyPublic;
      },
      async deleteReply() {
        if (replyKind === "ephemeral" && replyView) replyView.deleted = true;
        else if (replyPublic) await replyPublic.delete().catch(() => null);
      },
      async followUp(payload) {
        if (isEphemeral(payload)) {
          const view = pushEphemeral(payload);
          return virtualMessage(view, () => {});
        }
        return sendPublic(payload);
      },
      async showModal(modal) {
        ensureNotAnswered(this);
        if (spec.kind === "modal") throw new Error("A modal cannot open another modal");
        this.replied = true;
        result.modal = modalDefinition(modal);
        return undefined;
      },
    };
    return { interaction, result };
  }

  function renderView(view, userId, channelId, sourceMessageId) {
    const token = view.token || issue({ kind: "reply", userId, channelId, view, sourceMessageId });
    view.token = token;
    const entry = tokens.get(token);
    if (entry) entry.expiresAt = now() + tokenTtlMs;
    return {
      token,
      content: view.content,
      embeds: view.embeds.map(embedText),
      components: view.components,
      attachments: view.attachments,
    };
  }

  async function press(value) {
    const input = validateBody(value);
    const { userId, channelId } = input;
    // 1. 白名單：連 Discord 都還沒問之前就先擋。表單的 customId 取自伺服器記住的表單，不取用戶端送來的。
    let modalEntry = null;
    let kind;
    let customId;
    if (input.modalToken) {
      modalEntry = claim(input.modalToken, "modal", userId, channelId);
      kind = "modal";
      customId = modalEntry.modal.customId;
    } else {
      kind = input.values === undefined ? "button" : "select";
      customId = input.customId;
    }
    if (!allowedEntry(customId, kind)) fail("not_allowed");
    if (running.has(userId)) fail("in_progress");
    running.add(userId);
    try {
      // 2. 頻道擁有者＋看得到頻道。
      const ctx = await loadContext(userId, channelId);
      // 3. 元件必須真的在小奈的訊息（或小奈回給這位老闆的私人回覆）上。
      let message = null;
      let sourceView = null;
      let component = null;
      let sourceMessageId = null;
      if (input.messageId) {
        message = await ctx.channel.messages.fetch(input.messageId).catch(() => null);
        if (!message) fail("message_not_found");
        if (message.author?.id !== ctx.client.user.id) fail("not_bot_message");
        component = findComponent(rawRows(message.components), customId);
        checkComponent(component, kind, input.values);
        sourceMessageId = message.id;
      } else if (input.replyToken) {
        const entry = claim(input.replyToken, "reply", userId, channelId);
        sourceView = entry.view;
        if (sourceView.deleted) fail("token_expired");
        component = findComponent(sourceView.components, customId);
        checkComponent(component, kind, input.values);
        sourceMessageId = entry.sourceMessageId || null;
        message = virtualMessage(sourceView, () => {});
      } else {
        const fieldsDef = modalEntry.modal.inputs;
        const sent = input.fields;
        const known = new Set(fieldsDef.map((field) => field.id));
        if (Object.keys(sent).some((key) => !known.has(key))) fail("invalid_fields");
        for (const field of fieldsDef) {
          const text = sent[field.id] ?? "";
          if (field.required && !text.trim()) fail("invalid_fields");
          if (text && (text.length < field.minLength || text.length > field.maxLength)) fail("invalid_fields");
        }
        // Discord 送出的表單會帶所有欄位（未填為空字串）。
        input.fields = Object.fromEntries(fieldsDef.map((field) => [field.id, sent[field.id] ?? ""]));
        if (modalEntry.sourceMessageId) {
          message = await ctx.channel.messages.fetch(modalEntry.sourceMessageId).catch(() => null);
        } else if (modalEntry.sourceView && !modalEntry.sourceView.deleted) {
          sourceView = modalEntry.sourceView;
          message = virtualMessage(sourceView, () => {});
        }
        sourceMessageId = modalEntry.sourceMessageId || null;
        tokens.delete(input.modalToken);
      }

      const { interaction, result } = buildInteraction(ctx, {
        kind, customId, values: input.values, fields: input.fields, component, message, sourceView,
      });
      let timedOut = false;
      let timer;
      const run = Promise.resolve().then(() => route(interaction));
      const outcome = await Promise.race([
        run.then(() => "done", (error) => { console.error("[APP 按鈕] 處理失敗", { customId: customId.replace(/\d{6,}|[0-9a-f-]{20,}/gi, "…"), code: error?.code || "error" }); return "error"; }),
        new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve("timeout"); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (outcome === "error" && !result.replies.length && !result.modal && !result.messageUpdated) fail("unavailable");

      const body = { ok: true, pending: timedOut, messageUpdated: result.messageUpdated, replies: [], modal: null };
      if (sourceView && !sourceView.deleted) body.replies.push(renderView(sourceView, userId, channelId, sourceMessageId));
      for (const view of result.replies) {
        const empty = !view.content && !view.embeds.length && !view.components.length && !view.attachments;
        if (!view.deleted && !empty) body.replies.push(renderView(view, userId, channelId, sourceMessageId));
      }
      if (sourceView) body.sourceReplyToken = sourceView.token;
      if (result.modal) {
        if (result.modal.unsupported || !allowedEntry(result.modal.customId, "modal")) {
          body.discordOnly = true;
          body.error = ERRORS.discord_only[1];
        } else {
          const token = issue({
            kind: "modal", userId, channelId, modal: result.modal,
            // 表單一定是從頻道訊息或私人回覆上的按鈕打開的（表單不能再開表單）。
            sourceMessageId: input.messageId || null,
            sourceView: input.replyToken ? sourceView : null,
          });
          body.modal = { token, title: result.modal.title, inputs: result.modal.inputs };
        }
      }
      if (timedOut) body.notice = "已送出，小奈還在處理中，請稍後查看對話。";
      return { status: 200, body };
    } finally {
      running.delete(userId);
    }
  }

  async function handle(value) {
    try {
      return await press(value);
    } catch (error) {
      if (error instanceof AppInteractionError) {
        return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
      }
      console.error("[APP 按鈕] 失敗", { code: error?.code || "error" });
      return { status: 503, body: { ok: false, code: "unavailable", error: UNAVAILABLE } };
    }
  }

  function allowlist() {
    return { entries: CUSTOMER_INTERACTIONS.map(({ match, id, kinds }) => ({ match, id, kinds: [...kinds] })) };
  }

  return { handle, allowlist, _tokens: tokens };
}

module.exports = {
  createAppInteractions, CUSTOMER_INTERACTIONS, allowedEntry, modalDefinition, isEphemeral, rawRows, interactiveComponents,
  UNAVAILABLE, ERRORS,
};
