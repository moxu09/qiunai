const { memberHasRole, interactionHasPermission } = require("../utils/interactionPermissions");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const {
  createWorkReportSystem,
  isStaffInteraction,
} = require("./workReportSystem");
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");
const { scheduleChannelDeletion } = require("../utils/channelCleanup");
const {
  DEFAULT_CUSTOMER_SERVICE_ROLE_ID,
  hasCustomerServicePointRole,
} = require("../utils/customerServicePoints");
const {
  buildTopupTopic,
  getNextTopupNumber,
  getTopupNumberFromTopic,
} = require("../utils/topupNumbers");
const {
  DEFAULT_SALARY_ADVANCE_LIMIT,
  calculateSalaryDeductionState,
} = require("../utils/salaryDeduction");
const {
  DELTA_SERVICE_OPTIONS,
  GAME_OPTIONS: SELF_SERVICE_GAME_OPTIONS,
  calculateSelfServicePrice,
  getDeltaFixedPlayerCount,
  getValorantCompanionOptions,
  getValorantExpectedUnit,
  isOctoberValorantPricingActive,
} = require("../config/selfServicePricing");
const path = require("node:path");
const { buildEcpayPaymentRows, handleEcpayDirect, sendPreferredEcpayDirect } = require("../utils/ecpayDiscord");
const { isEcpayAtmAvailable } = require("../utils/ecpayAtmSchedule");
const { createServiceFlowStore } = require("../utils/serviceFlowStore");
const {
  buildPaymentMethodButtonRows,
  getCanonicalPaymentOptions,
  getGeneralOrderPaymentOptions,
  getPaymentMethodSelection,
  isGeneralEcpayAmountAllowed,
} = require("../utils/paymentMethodEmojis");
const { getOrCreateServiceOrder, transitionUnpaidOrders, createOperationGuard, isUnpaidWaitingOrder } = require("../utils/serviceOrderSafety");
const { createPaidOrderDispatcher } = require("../utils/orderDispatchRecovery");
const {
  getGeneralOrderAutoQuote,
  getValorantMappedCompanionRank,
} = require("../utils/generalOrderAutoQuote");
const guardOrderOperation = createOperationGuard();

let supabase;
let client;
let paymentHelpers = {};
let workReportSystem;
let paidOrderDispatcher;
let paidOrderDispatchRecoveryTimer = null;
let paidOrderDispatchRecoveryRunning = false;
const missingCustomerChannelWarnings = new Set();
let financialEffectsRecoveryTimer = null;
let financialEffectsRecoveryRunning = false;

let pendingNewOrders;
const pendingTopups = new Map();
const TOPUP_PRESET_AMOUNTS = Object.freeze([100, 250, 500, 1000, 3000, 5000, 10000, 15000]);
let pendingServiceOrders;
const processingSalaryPayments = new Set();
const JKOPAY_METHOD = "街口支付";
const JKOPAY_QR_CODE_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "payments",
  "jkopay-deepnight.png",
);
const BANK_TRANSFER_QR_CODE_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "payments",
  "bank-transfer-line-bank.png",
);
const pendingSelfServiceOrders = new Map();
const processingSelfServicePayments = new Set();
const processingSelfServiceClaims = new Set();
const processingSelfServiceCancellations = new Set();
const processingSelfServiceSelectionExtensions = new Set();
const processingOrderPriceAdjustments = new Set();
const selfServiceDispatchTimers = new Map();

const SELF_SERVICE_ORDER_CHANNEL_ID =
  process.env.SELF_SERVICE_ORDER_CHANNEL_ID || "1540650652215017533";
const SELF_SERVICE_DISPATCH_CHANNEL_ID =
  process.env.SELF_SERVICE_DISPATCH_CHANNEL_ID || "1540653111670997092";
const MANUAL_DISPATCH_CHANNEL_IDS = Object.freeze({
  valorant: "1223723419061850224",
  delta: "1336712064995037255",
  lol: "1546494242246103090",
  apex: "1546494309941903360",
  arena: "1548732212491587634",
  voice: "1548954895133053018",
  other: "1546519988901257246",
});
const JKOPAY_TOPUP_CHANNEL_ID =
  process.env.JKOPAY_TOPUP_CHANNEL_ID || "1546726352240115712";
const SELF_SERVICE_DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;
const SELF_SERVICE_SELECTION_EXTENSION_MS = 5 * 60 * 1000;
const QIUNAI_WATER_BLUE = "#7CC7FF";
const QIUNAI_FEMALE_PLAYER_ROLE_ID = "1206158440280621056";
const QIUNAI_MALE_PLAYER_ROLE_ID = "1210852757972459540";
const SELF_SERVICE_SUCCESS_IMAGE = path.join(
  __dirname,
  "..",
  "assets",
  "panels",
  "self-service-dispatch-success.png",
);
const SELF_SERVICE_FAILED_IMAGE = path.join(
  __dirname,
  "..",
  "assets",
  "panels",
  "self-service-dispatch-failed.png",
);

const QIUNAI_MANAGEMENT_ROLE_ID = "1525881173962788954";
const CUSTOMER_SERVICE_POINT_ROLE_ID =
  process.env.CUSTOMER_SERVICE_POINT_ROLE_ID || DEFAULT_CUSTOMER_SERVICE_ROLE_ID;

async function getNextPlayOrderNumber() {
  const { data, error } = await supabase.rpc("next_play_order_number");
  const orderNo = String(data || "").trim();

  if (error || !/^ORD-\d{10,}$/.test(orderNo)) {
    console.error("[訂單編號] 取得流水號失敗", error || data);
    throw new Error(error?.message || "無法取得訂單編號");
  }

  return orderNo;
}

function parseRoleIds(...values) {
  return new Set(
    values
      .flatMap((value) => String(value || "").match(/\d{16,22}/g) || [])
      .filter(Boolean),
  );
}

function canApproveSalaryDeduction(interaction) {
  if (interactionHasPermission(interaction, PermissionFlagsBits.Administrator)) {
    return true;
  }

  const allowedRoleIds = parseRoleIds(
    process.env.STAFF_ROLE,
    process.env.STAFF_ROLE_ID,
    process.env.CUSTOMER_SERVICE_ROLE_ID,
    process.env.CUSTOMER_SERVICE_ROLE_IDS,
    process.env.MANAGEMENT_ROLE_ID,
    process.env.MANAGEMENT_ROLE_IDS,
    QIUNAI_MANAGEMENT_ROLE_ID,
  );

  return [...allowedRoleIds].some((roleId) =>
    memberHasRole(interaction.member, roleId),
  );
}

async function deferReplyOnce(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
}

async function recordPaidExtensionConsumption(extension, note) {
  const amount = Number(extension?.amount || 0);
  const customerId = String(extension?.customer_id || "").trim();
  if (!customerId || !Number.isFinite(amount) || amount <= 0) return;

  await paymentHelpers.recordSpendActivity?.({
    userId: customerId,
    amount,
    sourceKey: `order-extension:${extension.id}`,
    note,
  });
  await paymentHelpers.checkAndUpgradeVip?.(
    customerId,
    "spend",
    amount,
    extension.guild_id || process.env.GUILD_ID,
    extension.channel_id || null,
  );
}

async function loadAllSalaryRows(buildQuery) {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(
      from,
      from + pageSize - 1,
    );
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function getSalaryDeductionEligibility(discordId, amount) {
  const normalizedDiscordId = String(discordId || "").trim();
  const { data: staff, error: staffError } = await supabase
    .from("qiunai_staff")
    .select("discord_id, discord_name, display_name, real_name")
    .eq("discord_id", normalizedDiscordId)
    .eq("is_active", true)
    .maybeSingle();

  if (staffError) throw staffError;
  if (!staff) throw new Error("扣薪付款僅限秋奈在職員工使用");

  const walletStartIso = new Date(
    `${process.env.SALARY_WALLET_START_DATE || "2026-07-17"}T00:00:00+08:00`,
  ).toISOString();
  const [walletEntries, withdrawRequests, pendingOrders, pendingAdjustments] =
    await Promise.all([
      loadAllSalaryRows(() =>
        supabase
          .from("salary_wallet_entries")
          .select("amount")
          .eq("app_key", "qiunai")
          .eq("discord_id", normalizedDiscordId),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("salary_withdraw_requests")
          .select("amount, status")
          .eq("app_key", "qiunai")
          .eq("discord_id", normalizedDiscordId)
          .in("status", ["pending", "approved"]),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("qiunai_salary_orders")
          .select("staff_salary, bonus_amount")
          .eq("discord_id", normalizedDiscordId)
          .gte("order_finished_at", walletStartIso)
          .is("wallet_settled_at", null)
          .or("is_deleted.eq.false,is_deleted.is.null")
          .or("status.neq.已入帳,status.is.null"),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("qiunai_staff_bonus")
          .select("amount")
          .eq("discord_id", normalizedDiscordId)
          .gte("created_at", walletStartIso)
          .is("wallet_settled_at", null),
      ),
    ]);

  return {
    staff,
    state: calculateSalaryDeductionState({
      walletEntries,
      withdrawRequests,
      pendingOrders,
      pendingAdjustments,
      amount,
      advanceLimit: DEFAULT_SALARY_ADVANCE_LIMIT,
    }),
  };
}

async function isActiveSalaryDeductionStaff(discordId) {
  const normalizedDiscordId = String(discordId || "").trim();
  if (!normalizedDiscordId) return false;
  const { data, error } = await supabase
    .from("qiunai_staff")
    .select("discord_id")
    .eq("discord_id", normalizedDiscordId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("[付款選單] 讀取員工身分失敗", error.message);
    return false;
  }
  return Boolean(data);
}

function buildSalaryDeductionOption(enabled) {
  return enabled
    ? [
        {
          label: "員工扣薪",
          description: "僅限秋奈在職員工，由抽成後薪資扣除",
          value: "扣薪",
        },
      ]
    : [];
}

function getSalaryStaffName(staff) {
  return (
    staff?.display_name ||
    staff?.real_name ||
    staff?.discord_name ||
    staff?.discord_id ||
    "員工"
  );
}

async function createSalaryDeductionPrompt({
  channel,
  customerId,
  amount,
  eligibility,
  confirmId,
  cancelId,
  transferId = null,
  purpose = "點單",
}) {
  const { state } = eligibility;
  const balanceText = Math.max(0, state.availableBefore).toLocaleString("zh-TW");
  const details = state.shortage
    ? `目前抽成後可用薪資：NT$${balanceText}\n` +
      `本筆金額：NT$${amount.toLocaleString("zh-TW")}\n` +
      `不足金額：NT$${state.shortage.toLocaleString("zh-TW")}\n` +
      `確認後預支總額：NT$${state.projectedAdvance.toLocaleString("zh-TW")} / NT$${state.advanceLimit.toLocaleString("zh-TW")}`
    : `目前抽成後可用薪資：NT$${state.availableBefore.toLocaleString("zh-TW")}\n` +
      `本筆扣薪：NT$${amount.toLocaleString("zh-TW")}\n` +
      `扣除後剩餘：NT$${state.projectedBalance.toLocaleString("zh-TW")}`;

  const buttons = [
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel(state.shortage ? "確認預支" : "確認使用扣薪")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!state.canUse),
  ];
  if (state.shortage && transferId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(transferId)
        .setLabel("轉帳補齊差額")
        .setStyle(ButtonStyle.Primary),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("不使用扣薪")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@&${process.env.STAFF_ROLE}> <@${customerId}> 選擇了員工扣薪付款。`,
    embeds: [
      new EmbedBuilder()
        .setColor(state.shortage ? "#f59e0b" : "#57F287")
        .setTitle(state.shortage ? "⚠️ 薪資不足，是否確認預支" : "💼 確認使用扣薪付款")
        .setDescription(
          `${details}\n\n` +
            `只有客服或管理員可以確認；確認後會在 EIP 新增「使用薪水${purpose}」扣項。` +
            (state.shortage && !state.canUse
              ? `\n目前預支額已超過 NT$${state.advanceLimit.toLocaleString("zh-TW")} 上限，請改用轉帳補齊差額。`
              : ""),
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(...buttons),
    ],
  });
}

async function createSalaryDeductionAdjustment(customerId, amount, note) {
  const eligibility = await getSalaryDeductionEligibility(customerId, amount);
  if (!eligibility.state.canUse) {
    throw new Error(
      `預支上限為 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}，本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}`,
    );
  }

  const { data: adjustment, error } = await supabase
    .from("qiunai_staff_bonus")
    .insert({
      discord_id: customerId,
      staff_name: getSalaryStaffName(eligibility.staff),
      title: "薪水扣除",
      amount: -Math.abs(amount),
      note,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !adjustment) {
    throw new Error(error?.message || "建立 EIP 扣項失敗");
  }

  return { eligibility, adjustmentId: adjustment.id };
}

async function applySalaryDeductionPayment({
  customerId,
  amount,
  purpose,
  commit,
}) {
  const paymentKey = `salary:${customerId}`;
  if (processingSalaryPayments.has(paymentKey)) {
    throw new Error("這位員工目前有另一筆扣薪付款正在處理，請稍後再試");
  }
  processingSalaryPayments.add(paymentKey);

  let adjustmentId = null;
  try {
    const adjustment = await createSalaryDeductionAdjustment(
      customerId,
      amount,
      purpose,
    );
    adjustmentId = adjustment.adjustmentId;
    const result = await commit();
    return { ...adjustment, result };
  } catch (error) {
    if (adjustmentId) {
      await supabase.from("qiunai_staff_bonus").delete().eq("id", adjustmentId);
    }
    throw error;
  } finally {
    processingSalaryPayments.delete(paymentKey);
  }
}

async function applySalaryDeductionToOrders({
  customerId,
  amount,
  orderIds,
  finalStatus,
  quoteStatus = null,
  paymentMethod = "扣薪",
}) {
  const paymentKey = `salary:${customerId}`;
  if (processingSalaryPayments.has(paymentKey)) {
    throw new Error("這位員工目前有另一筆扣薪付款正在處理，請稍後再試");
  }
  processingSalaryPayments.add(paymentKey);

  try {
    const eligibility = await getSalaryDeductionEligibility(customerId, amount);
    if (!eligibility.state.canUse) {
      throw new Error(
        `預支上限為 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}，本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}`,
      );
    }
    const rawOrderIds = Array.isArray(orderIds) ? orderIds : [];
    const normalizedOrderIds = [...new Set(rawOrderIds.map(String))].sort();
    if (!normalizedOrderIds.length || normalizedOrderIds.length !== rawOrderIds.length) {
      throw new Error("扣薪付款訂單資料不完整或重複");
    }
    const guildId = String(process.env.GUILD_ID || "1206138511535898654");
    const walletStartIso = new Date(
      `${process.env.SALARY_WALLET_START_DATE || "2026-07-17"}T00:00:00+08:00`,
    ).toISOString();
    const operationKey = `salary-order-payment:${guildId}:${normalizedOrderIds.join(":")}`;
    const { data, error } = await supabase.rpc(
      "qiunai_apply_salary_order_payment",
      {
        p_operation_key: operationKey,
        p_customer_id: String(customerId),
        p_amount: Number(amount),
        p_order_ids: normalizedOrderIds,
        p_guild_id: guildId,
        p_payment_method: paymentMethod,
        p_final_status: finalStatus,
        p_quote_status: quoteStatus,
        p_wallet_start: walletStartIso,
        p_advance_limit: DEFAULT_SALARY_ADVANCE_LIMIT,
      },
    );
    if (error || !data) {
      throw new Error(error?.message || "扣薪付款原子交易失敗");
    }
    const payment = Array.isArray(data) ? data[0] : data;
    const updatedOrders = Array.isArray(payment?.orders) ? payment.orders : [];
    if (updatedOrders.length !== normalizedOrderIds.length) {
      throw new Error("扣薪付款已提交，但未回傳完整訂單資料");
    }

    return {
      eligibility,
      orders: updatedOrders,
      adjustmentId: payment.adjustment_id,
      alreadyProcessed: Boolean(payment.already_processed),
    };
  } finally {
    processingSalaryPayments.delete(paymentKey);
  }
}

function canCustomerOrStaffSubmit(interaction, customerId) {
  return (
    interaction.user.id === String(customerId || "") ||
    isStaffInteraction(
      interaction,
      process.env.STAFF_ROLE,
      process.env.STAFF_ROLE_ID,
      process.env.STAFF_ROLE_IDS,
      process.env.CUSTOMER_SERVICE_ROLE_ID,
      process.env.CUSTOMER_SERVICE_ROLE_IDS,
      "1210642900355125288",
      "1513203868895412305",
      "1502010574781943989",
    )
  );
}

function createFlowId(userId) {
  return `${userId}_${Date.now()}`;
}

function getServiceName(serviceType) {
  if (serviceType === "valorant") return "特戰英豪";
  if (serviceType === "delta") return "三角洲行動";
  if (serviceType === "apex") return "Apex";
  if (serviceType === "lol") return "英雄聯盟";
  if (serviceType === "steam") return "Steam";
  if (serviceType === "other") return "其他項目";

  if (serviceType === "pubg") return "絕地求生";
  if (serviceType === "pubgm") return "PUBG M";
  if (serviceType === "naraka") return "NARAKA";
  if (serviceType === "minecraft") return "Minecraft";
  if (serviceType === "voice_chat") return "語音聊天";
  if (serviceType === "song") return "點歌服務";
  if (serviceType === "custom") return "自訂輸入";

  if (serviceType === "chat") return "陪聊";
  if (serviceType === "emotion") return "出氣包";

  return "訂單";
}

const CATEGORY_CHANNEL_LIMIT = 50;
const ORDER_TICKET_CATEGORY_ID = "1530875019851202851";
const TIP_ORDER_PANEL_CHANNEL_ID = "1531515179559551047";
function getCategoryIds(value) {
  return String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function getCategoryById(guild, categoryId) {
  if (!categoryId) return null;

  const cached = guild.channels.cache.get(categoryId);
  if (cached) return cached;

  return await guild.channels.fetch(categoryId).catch(() => null);
}

function getCategoryChildCount(guild, categoryId) {
  return guild.channels.cache.filter(
    (channel) => channel.parentId === categoryId
  ).size;
}

async function resolveTicketParentId(
  guild,
  categoryValue,
  fallbackName = "訂單區"
) {
  await guild.channels.fetch().catch(() => null);

  const categoryIds = getCategoryIds(categoryValue);
  const categories = [];

  for (const categoryId of categoryIds) {
    const category = await getCategoryById(guild, categoryId);

    if (!category || category.type !== ChannelType.GuildCategory) continue;

    categories.push(category);

    if (getCategoryChildCount(guild, category.id) < CATEGORY_CHANNEL_LIMIT) {
      return category.id;
    }
  }

  const baseCategory = categories[0];
  if (!baseCategory) return categoryIds[0] || null;

  const prefix = baseCategory.name || fallbackName;
  const siblingCategories = guild.channels.cache
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildCategory &&
        channel.name.startsWith(prefix)
    )
    .sort((a, b) => a.position - b.position);

  for (const category of siblingCategories.values()) {
    if (getCategoryChildCount(guild, category.id) < CATEGORY_CHANNEL_LIMIT) {
      return category.id;
    }
  }

  const nextIndex = siblingCategories.size + 1;
  const permissionOverwrites =
    baseCategory.permissionOverwrites?.cache?.map((overwrite) => ({
      id: overwrite.id,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
      type: overwrite.type,
    })) || [];

  const newCategory = await guild.channels.create({
    name: `${prefix}-${nextIndex}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
    reason: "訂單分類已滿，自動建立分流分類",
  });

  console.log(
    `[ORDER_CATEGORY] 分類 ${baseCategory.id} 已滿，自動建立分流分類 ${newCategory.name} (${newCategory.id})`
  );

  return newCategory.id;
}
let pendingPanelOrders;
const PANEL_ASSET_DIR = path.join(__dirname, "..", "assets", "panels");

const GAME_ORDER_PANELS = [
  {
    envKey: "VALORANT_ORDER_CHANNEL",
    panelName: "valorant",
    imageFile: "valorant-pricing.png",
    title: "🎯 特戰英豪下單區",
    description: "請選擇需求的陪陪段位。",
    customId: "game_order_select_valorant",
    options: [
      { label: "娛樂", value: "entertain", description: "需求的陪陪段位｜娛樂" },
      { label: "超凡", value: "ascendant", description: "需求的陪陪段位｜超凡" },
      { label: "神話", value: "immortal", description: "需求的陪陪段位｜神話" },
      { label: "輻能", value: "radiant", description: "需求的陪陪段位｜輻能" },
      { label: "頂輻", value: "top_radiant", description: "需求的陪陪段位｜頂輻" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "DELTA_ORDER_CHANNEL",
    panelName: "delta",
    imageFile: "delta-pricing.png",
    title: "🛡️ 三角洲行動下單區",
    description: "請選擇你要下單的三角洲行動項目。",
    customId: "game_order_select_delta",
    options: [
      { label: "電腦版", value: "pc", description: "三角洲行動｜電腦版" },
      { label: "手機版", value: "mobile", description: "三角洲行動｜手機版" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "APEX_ORDER_CHANNEL",
    panelName: "apex",
    imageFile: "apex-pricing.png",
    title: "🔺 Apex 下單區",
    description: "請選擇你要下單的 Apex 項目。",
    customId: "game_order_select_apex",
    options: [
      { label: "大神陪玩", value: "god", description: "Apex｜大神陪玩" },
      { label: "技術陪玩", value: "skill", description: "Apex｜技術陪玩" },
      { label: "娛樂陪玩", value: "entertain", description: "Apex｜娛樂陪玩" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "LOL_ORDER_CHANNEL",
    panelName: "lol",
    imageFiles: ["lol-pricing.png", "aram-pricing.png", "tft-pricing.png"],
    title: "🧙 英雄聯盟下單區",
    description: "請先選擇英雄聯盟項目，下一步再選大神 / 技術 / 娛樂。",
    customId: "game_order_select_lol",
    options: [
      { label: "英雄聯盟", value: "lol_main", description: "召喚峽谷" },
      { label: "ARAM", value: "aram", description: "咆哮深淵" },
      { label: "聯盟戰棋", value: "tft", description: "Teamfight Tactics" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "STEAM_ORDER_CHANNEL",
    panelName: "steam",
    imageFile: "steam-pricing.png",
    title: "🎮 Steam 下單區",
    description: "請選擇你要下單的 Steam 遊戲類型。",
    customId: "game_order_select_steam",
    options: [
      { label: "肉鴿遊戲", value: "roguelike", description: "Steam｜肉鴿遊戲" },
      { label: "生存遊戲", value: "survival", description: "Steam｜生存遊戲" },
      { label: "恐怖遊戲", value: "horror", description: "Steam｜恐怖遊戲" },
      { label: "派對遊戲", value: "party", description: "Steam｜派對遊戲" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "OTHER_ORDER_CHANNEL",
    panelName: "other",
    imageFile: "aov-pricing.png",
    title: "🌙 其他項目下單區",
    description: "請選擇你要下單的其他服務項目。",
    customId: "game_order_select_other",
    options: [
      { label: "PUBG M", value: "pubgm", description: "PUBG M" },
      { label: "NARAKA", value: "naraka", description: "NARAKA" },
      { label: "Minecraft", value: "minecraft", description: "Minecraft" },
      {
        label: "傳說對決",
        value: "arena_of_valor",
        description: "傳說對決｜娛樂／技術／大神",
      },
      {
        label: "王者榮耀",
        value: "honor_of_kings",
        description: "王者榮耀｜娛樂／技術",
      },
      {
        label: "第五人格",
        value: "identity_v",
        description: "第五人格｜娛樂／四階～七階",
      },
      { label: "語音聊天", value: "voice_chat", description: "語音聊天" },
      { label: "點歌服務", value: "song", description: "點歌服務" },
      { label: "自訂輸入", value: "custom", description: "其他項目｜自訂需求" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
];

function findOptionLabel(panelName, value) {
  const panel = GAME_ORDER_PANELS.find((item) => item.panelName === panelName);

  const option = panel?.options.find((item) => item.value === value);

  return option?.label || value;
}
async function resetSelectMenuMessage(interaction) {
  try {
    if (!interaction.message || !interaction.message.components?.length) {
      return;
    }

    // 私人選單不是可用一般頻道 API 編輯的訊息；後續步驟會更新私人回覆，
    // 不需要重置共用面板的預設選項，也不要因此發出必然失敗的 PATCH。
    if (interaction.message.flags?.has(64)) return;

    const rows = interaction.message.components
      .map((row) => {
        const newRow = new ActionRowBuilder();

        for (const component of row.components) {
          // String Select Menu
          if (component.type === 3) {
            const menu = StringSelectMenuBuilder.from(component);

            const options = component.options.map((option) => ({
              label: option.label,
              value: option.value,
              description: option.description || undefined,
              emoji: option.emoji || undefined,
              default: false,
            }));

            menu.setOptions(options);
            newRow.addComponents(menu);
          }

          // Button
          if (component.type === 2) {
            newRow.addComponents(ButtonBuilder.from(component));
          }
        }

        return newRow;
      })
      .filter((row) => row.components.length > 0);

    if (!rows.length) return;

    await interaction.message.edit({
      components: rows,
    });
  } catch (err) {
    // 面板可能剛被客服刪除。重置僅是外觀更新，不阻止已收到的下單互動。
    if (Number(err?.code) === 10008) return;
    console.error("[下拉選單重置失敗]", {
      code: err?.code,
      message: err?.message,
      channelId: interaction.channelId,
      messageId: interaction.message?.id,
    });
  }
}
function buildPanelInitialData(gameKey, value) {
  const label = findOptionLabel(gameKey, value);

  if (gameKey === "valorant") {
    const valorantSelection = getValorantTypeSelection(value);

    return {
      category: "valorant",
      gameLabel: "特戰英豪",
      itemLabel: valorantSelection?.label || label,
      serviceType: valorantSelection?.label || label,
      serviceTypes: valorantSelection?.serviceTypes || [],
      valorantCompanionRank: valorantSelection?.companionRank || null,
      playMode: valorantSelection?.label || label,
      playerCount: null,
      fromPanel: true,
    };
  }

  if (gameKey === "delta") {
    return {
      category: "delta",
      gameLabel: "三角洲行動",
      itemLabel: label, // 電腦版 / 手機版
      serviceType: `三角洲行動｜${label}`,
      deltaPlatform: label,
      deltaMode: null,
      fromPanel: true,
    };
  }

  if (gameKey === "apex") {
    return {
      category: "apex",
      gameLabel: "Apex",
      itemLabel: label,
      serviceType: `Apex｜${label}`,
      playMode: label,
      fromPanel: true,
    };
  }

  if (gameKey === "steam") {
    return {
      category: "steam",
      gameLabel: "Steam",
      itemLabel: label,
      serviceType: `Steam｜${label}`,
      steamCategory: label,
      fromPanel: true,
    };
  }

  if (gameKey === "other") {
    return {
      category: "other",
      gameLabel: "其他項目",
      itemLabel: label,
      serviceType: `其他項目｜${label}`,
      playMode: label,
      fromPanel: true,
    };
  }

  return {
    category: gameKey,
    gameLabel: getServiceName(gameKey),
    itemLabel: label,
    serviceType: `${getServiceName(gameKey)}｜${label}`,
    playMode: label,
    fromPanel: true,
  };
}

async function upsertGameOrderPanel(panel) {
  const channelId = process.env[panel.envKey];

  if (!channelId) {
    console.log(`[下單分區] 未設定 ${panel.envKey}`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    console.log(`[下單分區] 找不到頻道：${panel.envKey}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle(panel.title)
    .setDescription(
      `${panel.description}\n\n` +
        `選到「購買星雨幣」會建立購買訂單。\n` +
        `選到「打賞」會建立打賞頻道。\n` +
        `選其他項目會建立專屬臨時下單頻道。`
    )
    .setFooter({
      text: "深夜不關燈｜We Are Still Here",
    })
    .setTimestamp();
  const scheduledImageFile =
    panel.panelName === "valorant" && isOctoberValorantPricingActive()
      ? "valorant-pricing-2026-10.jpg"
      : panel.imageFile;
  const imageFiles = Array.isArray(panel.imageFiles)
    ? panel.imageFiles
    : scheduledImageFile
      ? [scheduledImageFile]
      : [];
  const files = imageFiles.map((imageFile) => ({
    attachment: path.join(PANEL_ASSET_DIR, imageFile),
    name: imageFile,
  }));

  if (imageFiles[0]) {
    embed.setImage(`attachment://${imageFiles[0]}`);
  }
  const imageEmbeds = imageFiles.slice(1).map((imageFile) =>
    new EmbedBuilder()
      .setColor(QIUNAI_WATER_BLUE)
      .setImage(`attachment://${imageFile}`)
  );
  const embeds = [embed, ...imageEmbeds];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(panel.customId)
    .setPlaceholder("請選擇下單項目")
    .addOptions(
      panel.options.map((option) => ({
        label: option.label.slice(0, 100),
        description: option.description.slice(0, 100),
        value: option.value,
      }))
    );

  const row = new ActionRowBuilder().addComponents(menu);

  const messages = await channel.messages
    .fetch({
      limit: 10,
    })
    .catch(() => null);

  const oldPanel = messages?.find(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === panel.title
  );

  if (oldPanel) {
    await oldPanel.edit({
      embeds,
      components: [row],
      ...(files.length ? { attachments: [], files } : {}),
    });
    console.log(`[下單分區] 已更新：${panel.title}`);
    return;
  }

  await channel.send({
    embeds,
    components: [row],
    ...(files.length ? { files } : {}),
  });

  console.log(`[下單分區] 已建立：${panel.title}`);
}

async function sendGameOrderPanels() {
  for (const panel of GAME_ORDER_PANELS) {
    await upsertGameOrderPanel(panel);
  }
}

let activePricingPanelVersion = null;
function startPricingPanelScheduler() {
  activePricingPanelVersion = isOctoberValorantPricingActive()
    ? "2026-10-01"
    : "current";
  const timer = setInterval(async () => {
    const version = isOctoberValorantPricingActive()
      ? "2026-10-01"
      : "current";
    if (version === activePricingPanelVersion) return;
    activePricingPanelVersion = version;
    try {
      await sendGameOrderPanels();
      console.log(`[價目表排程] 已切換特戰價目表：${version}`);
    } catch (error) {
      activePricingPanelVersion = null;
      console.error("[價目表排程] 更新面板失敗", error);
    }
  }, 60 * 1000);
  timer.unref?.();
  return timer;
}

function getSelfServiceGameLabel(game) {
  return SELF_SERVICE_GAME_OPTIONS.find((item) => item.value === game)?.label || game;
}

function getSelfServiceDispatchKey(game, input) {
  const type = String(
    game === "valorant" ? input.rankOrMap : input.serviceType || "",
  );
  if (game === "valorant") {
    return type.includes("娛樂") ? "特戰英豪娛樂陪玩" : "特戰英豪技術陪玩";
  }
  if (game === "delta") {
    return type.includes("娛樂") ? "三角洲行動娛樂陪玩" : `三角洲行動${type}`;
  }
  if (game === "apex") return `Apex${type.includes("陪玩") ? type : `${type}陪玩`}`;
  if (game === "lol") {
    const mode = String(input.platformOrMode || "");
    if (/ARAM|咆哮深淵/i.test(mode)) return `ARAM${type.includes("陪玩") ? type : `${type}陪玩`}`;
    if (/TFT|聯盟戰棋|戰棋/i.test(mode)) return "聯盟戰棋";
    return `英雄聯盟${type.includes("陪玩") ? type : `${type}陪玩`}`;
  }
  if (game === "steam") return "Steam";
  if (game === "voice_chat") return "語音聊天";
  return getSelfServiceGameLabel(game);
}

function getSelfServiceDispatchRoleIds(order) {
  const service = `${order.service || ""}｜${order.dispatch_service_key || ""}`;
  const genderRoleIds = order.gender_preference === "女陪"
    ? [QIUNAI_FEMALE_PLAYER_ROLE_ID]
    : order.gender_preference === "男陪"
      ? [QIUNAI_MALE_PLAYER_ROLE_ID]
      : [QIUNAI_FEMALE_PLAYER_ROLE_ID, QIUNAI_MALE_PLAYER_ROLE_ID];
  let serviceRoleIds = [];
  if (service.includes("特戰英豪")) {
    if (service.includes("娛樂")) serviceRoleIds = [...parseRoleIds(process.env.VALORANT_ENTERTAIN_ROLE_ID)];
    else if (service.includes("超凡")) serviceRoleIds = ["1513615452570390708"];
    else if (service.includes("神話")) serviceRoleIds = ["1210860675010666496"];
    else serviceRoleIds = ["1210860797341732914"];
  } else if (service.includes("Apex")) {
    serviceRoleIds = [
      service.includes("娛樂") ? "1210651796813512864" : service.includes("技術") ? "1210860572422185030" : "1210861028754333747",
    ];
  } else if (service.includes("英雄聯盟") || service.includes("ARAM") || service.includes("聯盟戰棋")) {
    serviceRoleIds = [
      service.includes("娛樂") ? "1210652274771361812" : service.includes("技術") ? "1216812087582396436" : "1284782543614378025",
    ];
  } else if (service.includes("Steam")) {
    serviceRoleIds = [...parseRoleIds(process.env.STEAM_ROLE_ID)];
  } else if (service.includes("三角洲")) {
    const mobile = service.includes("手機");
    if (service.includes("娛樂")) serviceRoleIds = [mobile ? "1536365672429518848" : "1212483869593567292"];
    else if (service.includes("保底") || service.includes("猛攻")) serviceRoleIds = [mobile ? "1536365686912458752" : "1253665064477786174"];
    else serviceRoleIds = [mobile ? "1536365687511978154" : "1229372574950100992"];
  } else if (service.includes("語音聊天") || service.includes("陪聊")) {
    serviceRoleIds = [...parseRoleIds(process.env.CHAT_ROLE_ID)];
  }
  return {
    genderRoleIds: [...new Set(genderRoleIds.filter(Boolean))],
    serviceRoleIds: [...new Set(serviceRoleIds.filter(Boolean))],
  };
}

function getSelfServiceDispatchAt(order) {
  const match = String(order?.note || "").match(/\[DISPATCH_AT:([^\]]+)\]/);
  const time = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(time) ? time : Date.parse(order?.updated_at || order?.created_at || "");
}

function getSelfServiceSelectionDeadline(order) {
  return getSelfServiceDispatchAt(order) + SELF_SERVICE_DISPATCH_TIMEOUT_MS;
}

function hasExtendedDispatchTime(order) {
  return String(order?.note || "").includes("[DISPATCH_EXTENDED:1]");
}

function extendSelfServiceSelectionDeadline(order) {
  if (hasExtendedDispatchTime(order)) {
    throw new Error("每筆訂單最多只能延長一次 5 分鐘");
  }
  const dispatchAt = getSelfServiceDispatchAt(order);
  if (!Number.isFinite(dispatchAt)) {
    throw new Error("找不到這張訂單的選人開始時間");
  }
  const nextDispatchAt = dispatchAt + SELF_SERVICE_SELECTION_EXTENSION_MS;
  const dispatchAtIso = new Date(nextDispatchAt).toISOString();
  return {
    dispatchAtIso,
    deadlineAt: nextDispatchAt + SELF_SERVICE_DISPATCH_TIMEOUT_MS,
    note: `${String(order?.note || "")
      .replace(/\s*\[DISPATCH_AT:[^\]]+\]/g, "")
      .trim()} [DISPATCH_AT:${dispatchAtIso}] [DISPATCH_EXTENDED:1]`.trim(),
  };
}

function resolveSelfServicePlayerNumbers(candidateIds, selectedValues, requiredCount) {
  const candidates = (candidateIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  const needCount = Number(requiredCount);
  const numbers = (selectedValues || []).map((value) => Number(value));
  if (
    !Number.isInteger(needCount) ||
    needCount < 1 ||
    numbers.length !== needCount ||
    new Set(numbers).size !== numbers.length ||
    numbers.some((number) => !Number.isInteger(number) || number < 1 || number > candidates.length)
  ) {
    throw new Error("選擇的數字無效或人數不符");
  }
  return numbers.map((number) => candidates[number - 1]);
}

function stripSelfServiceClaimNotes(note) {
  return String(note || "")
    .replace(/\s*\[SELF_CLAIM:\d{16,22}:[A-Za-z0-9_-]*\]/g, "")
    .replace(/\s*\[SELF_CLAIM_TYPE:\d{16,22}:(?:can|want)\]/g, "")
    .trim();
}

function getPublicOrderNote(note) {
  return stripSelfServiceClaimNotes(note)
    .replace(/\s*\[(?:SELF_SERVICE(?:_MANUAL)?|MANUAL_DISPATCH)\]/g, "")
    .replace(/\s*\[DISPATCH_AT:[^\]]+\]/g, "")
    .replace(/\s*\[SELECTION_EXTENSION_MINUTES:\d+\]/g, "")
    .trim() || "無";
}

function normalizeSelfServiceClaimType(claimType) {
  return claimType === "want" ? "want" : "can";
}

function getSelfServiceClaimTypeLabel(claimType) {
  return normalizeSelfServiceClaimType(claimType) === "want"
    ? "PM"
    : "1";
}

function appendSelfServiceClaimNote(note, discordId, claimNote, claimType = "can") {
  const cleanNote = stripSelfServiceClaimNotesForUser(note, discordId);
  const encoded = Buffer.from(String(claimNote || "").trim(), "utf8").toString(
    "base64url",
  );
  const normalizedType = normalizeSelfServiceClaimType(claimType);
  return `${cleanNote} [SELF_CLAIM:${discordId}:${encoded}] [SELF_CLAIM_TYPE:${discordId}:${normalizedType}]`.trim();
}

function stripSelfServiceClaimNotesForUser(note, discordId) {
  const escapedId = String(discordId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(note || "")
    .replace(new RegExp(`\\s*\\[SELF_CLAIM:${escapedId}:[A-Za-z0-9_-]*\\]`, "g"), "")
    .replace(new RegExp(`\\s*\\[SELF_CLAIM_TYPE:${escapedId}:(?:can|want)\\]`, "g"), "")
    .trim();
}

function getSelfServiceClaimNotes(note) {
  const notes = new Map();
  for (const match of String(note || "").matchAll(
    /\[SELF_CLAIM:(\d{16,22}):([A-Za-z0-9_-]*)\]/g,
  )) {
    try {
      notes.set(match[1], Buffer.from(match[2], "base64url").toString("utf8"));
    } catch {
      notes.set(match[1], "");
    }
  }
  return notes;
}

function getSelfServiceClaimTypes(note) {
  const types = new Map();
  for (const match of String(note || "").matchAll(
    /\[SELF_CLAIM_TYPE:(\d{16,22}):(can|want)\]/g,
  )) {
    types.set(match[1], normalizeSelfServiceClaimType(match[2]));
  }
  return types;
}

function parseSelfServiceClaimAction(customId, { submit = false } = {}) {
  const prefix = submit
    ? "self_service_claim_submit_"
    : "self_service_claim_";
  const value = String(customId || "");
  if (!value.startsWith(prefix)) return null;
  const remainder = value.slice(prefix.length);
  const match = /^(can|want)_(.+)$/.exec(remainder);
  if (!match?.[2]) return null;
  return {
    claimType: normalizeSelfServiceClaimType(match[1]),
    orderId: match[2],
  };
}

function getLegacySelfServiceClaimOrderId(customId) {
  const value = String(customId || "");
  const prefix = "self_service_claim_";
  if (
    !value.startsWith(prefix) ||
    value.startsWith(`${prefix}can_`) ||
    value.startsWith(`${prefix}want_`) ||
    value.startsWith(`${prefix}submit_`)
  ) {
    return null;
  }
  return value.slice(prefix.length) || null;
}

function buildSelfServiceClaimButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`self_service_claim_can_${orderId}`)
      .setLabel("1")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`self_service_claim_want_${orderId}`)
      .setLabel("PM")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildDispatchTimeExtensionButton(order) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`self_selection_extend_${order.id}`)
      .setLabel("延長派單時間（+5 分鐘，限一次）")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(hasExtendedDispatchTime(order)),
  );
}

function getSelfServiceThreadName(order) {
  const orderLabel = String(order?.order_no || "未編號").replace(/[^\p{L}\p{N}_-]+/gu, "-");
  return `派單中-${orderLabel}-${order.id}`.slice(0, 100);
}

async function createSelfServiceClaimThread(dispatchMessage, order) {
  if (!dispatchMessage?.startThread) throw new Error("派單訊息無法建立討論串");
  try {
    return await dispatchMessage.startThread({
      name: getSelfServiceThreadName(order),
      autoArchiveDuration: 60,
      reason: `${isManualDispatchOrder(order) ? "人工" : "自助"}訂單 ${order.order_no || order.id} 跳單討論串`,
    });
  } catch (error) {
    await dispatchMessage.delete().catch(() => null);
    throw new Error(`建立派單討論串失敗：${error.message || error}`, { cause: error });
  }
}

function getDispatchResultThreadName(order, succeeded) {
  const orderLabel = String(order?.order_no || order?.id || "未編號")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-");
  return `${succeeded ? "接單成功" : "訂單棄單"}-${orderLabel}`.slice(0, 100);
}

async function renameClaimThread(thread, expectedName, reason, orderId) {
  for (let attempt = 1; attempt <= 3 && thread.name !== expectedName; attempt++) {
    try {
      thread = await thread.setName(expectedName, reason) || thread;
    } catch (error) {
      console.error(`[派單討論串] 訂單 ${orderId} 第 ${attempt} 次更名失敗`, error);
    }
    if (thread.name !== expectedName && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  if (thread.name !== expectedName) {
    console.error(`[派單討論串] 訂單 ${orderId} 更名未完成，保留討論串供重新修復`);
    return null;
  }
  return thread;
}

async function finishClaimThread(order, { succeeded, reason }) {
  const claimMessage = await findSelfServiceClaimMessage(order.id, order);
  const thread = claimMessage?.channel?.isThread?.() ? claimMessage.channel : null;
  if (!thread) {
    console.error(`[派單討論串] 找不到訂單 ${order.id} 的討論串，無法更名`);
    return null;
  }
  await claimMessage.edit({ components: [] }).catch(() => null);
  return renameClaimThread(thread, getDispatchResultThreadName(order, succeeded), reason, order.id);
}

async function publishClaimSuccess(order, selectedIds) {
  const claimMessage = await findSelfServiceClaimMessage(order.id, order);
  const resultChannel = claimMessage?.channel?.isThread?.()
    ? claimMessage.channel
    : await client.channels.fetch(getClaimDispatchChannelId(order)).catch(() => null);
  await resultChannel?.send({
    content: `${selectedIds.map((id) => `<@${id}>`).join(" ")} 接單成功！`,
    files: [{ attachment: SELF_SERVICE_SUCCESS_IMAGE, name: "dispatch-success.png" }],
    allowedMentions: { users: selectedIds },
  }).catch(() => null);
  const thread = await finishClaimThread(order, {
    succeeded: true,
    reason: "老闆已確認接單陪陪",
  });
  await thread?.setArchived(true, "派單成功").catch(() => null);
  pendingSelfServiceOrders.delete(`claimMessage:${order.id}`);
}

async function rememberSelfServiceClaimMessage(orderId, message) {
  if (!message) return;
  pendingSelfServiceOrders.set(`claimMessage:${orderId}`, {
    channelId: message.channelId,
    messageId: message.id,
  });
}

async function archiveSelfServiceClaimThread(orderId, reason = "自助派單已結束") {
  const message = await findSelfServiceClaimMessage(orderId);
  const thread = message?.channel?.isThread?.() ? message.channel : null;
  if (!thread || thread.archived) return;
  await thread.setArchived(true, reason).catch((error) =>
    console.error("[自助派單] 關閉跳單討論串失敗", error),
  );
}

function safeSelfServiceClaimNote(note, maxLength = 30) {
  const text = String(note || "")
    .replace(/@/g, "＠")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function requiresManualTimeoutReview(order) {
  return Boolean(order?.paid &&
    (isManualDispatchOrder(order) || !isWalletPaymentMethod(order.payment_method)));
}

async function failSelfServiceDispatch(orderId, messageId = null) {
  selfServiceDispatchTimers.delete(String(orderId));
  const current = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (current.error || !current.data || !isClaimDispatchOrder(current.data)) return;
  const sourceOrder = current.data;
  if (Date.now() < getSelfServiceSelectionDeadline(sourceOrder)) {
    scheduleSelfServiceDispatchTimeout(sourceOrder, messageId);
    return;
  }
  const cancellingStatus = isManualDispatchOrder(sourceOrder)
    ? "manual_cancelling"
    : "self_cancelling";
  const { data: order, error } = await supabase
    .from("play_orders")
    .update({ quote_status: cancellingStatus, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("quote_status", getClaimTimeoutStatuses(sourceOrder))
    .eq("updated_at", sourceOrder.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!order) {
    const latest = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
    if (latest.data && getClaimTimeoutStatuses(latest.data).includes(latest.data.quote_status)) {
      scheduleSelfServiceDispatchTimeout(latest.data, messageId);
    }
    return;
  }
  const candidateIds = String(order.preferred_player || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const wasWaitingForCustomer =
    candidateIds.length >= Number(order.player_count || 1);
  const failureReason = wasWaitingForCustomer
    ? "選人期限內客人未完成陪陪選擇，已自動棄單。"
    : "派單期限內未湊足陪陪，已判定失敗。";
  const restoreQuoteStatus = wasWaitingForCustomer
    ? getClaimChoosingStatus(order)
    : getClaimDispatchingStatus(order);
  if (requiresManualTimeoutReview(order)) {
    // 非 ASD 已付款訂單不能走 ASD 退款 RPC，也不能當作未付款訂單關閉頻道。
    const { data: reviewOrder, error: reviewError } = await supabase
      .from("play_orders")
      .update({ quote_status: "self_manual_review", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("quote_status", cancellingStatus)
      .select()
      .maybeSingle();
    if (reviewError) throw reviewError;
    if (!reviewOrder) return;
    const reviewMessage =
      `訂單 ${order.order_no || order.id} 派單逾時；此單已使用「${order.payment_method || "非 ASD 方式"}」付款，` +
      "系統尚未退款，請客服核對付款並人工處理退款或續派。訂單頻道會保留。";
    const claimMessage = await findSelfServiceClaimMessage(order.id, order).catch((lookupError) => {
      console.error("[自助派單人工處理] 查詢討論串失敗", lookupError);
      return null;
    });
    const claimThread = claimMessage?.channel?.isThread?.() ? claimMessage.channel : null;
    await claimMessage?.edit({ components: [] }).catch(() => null);
    await claimThread?.send({
      content: reviewMessage,
      files: [{ attachment: SELF_SERVICE_FAILED_IMAGE, name: "dispatch-failed.png" }],
      allowedMentions: { parse: [] },
    }).catch((notificationError) => console.error("[自助派單人工處理] 討論串通知失敗", notificationError));
    await claimThread?.setName(
      `待人工處理-${String(order.order_no || order.id).replace(/[^\p{L}\p{N}_-]+/gu, "-")}`.slice(0, 100),
      "已付款訂單逾時，等待人工核帳",
    ).catch(() => null);
    const orderChannel = await client.channels.fetch(order.channel_id).catch(() => null);
    const staffRole = /^\d{16,22}$/.test(String(process.env.STAFF_ROLE || ""))
      ? `<@&${process.env.STAFF_ROLE}> ` : "";
    await orderChannel?.send({
      content: `${staffRole}<@${order.customer_id}> ${reviewMessage}`,
      allowedMentions: { roles: staffRole ? [process.env.STAFF_ROLE] : [], users: [order.customer_id] },
    }).catch((notificationError) => console.error("[自助派單人工處理] 訂單頻道通知失敗", notificationError));
    pendingSelfServiceOrders.delete(`candidatePrompt:${order.id}`);
    pendingSelfServiceOrders.delete(`selection:${order.id}`);
    pendingSelfServiceOrders.delete(`claimMessage:${order.id}`);
    console.warn(`[自助派單人工處理] 訂單 ${order.id} 已付款但不支援自動退款，已停止逾時重試`);
    return;
  }
  let refundAmount = 0;
  let refundedBalance = null;
  try {
    if (isManualDispatchOrder(order)) {
      const { error: manualCancelError } = await supabase
        .from("play_orders")
        .update({
          status: "cancelled",
          quote_status: "manual_dispatch_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id)
        .eq("paid", false)
        .eq("quote_status", "manual_cancelling");
      if (manualCancelError) throw manualCancelError;
    } else {
    const { data: cancellation, error: cancelError } = await supabase.rpc(
      "qiunai_cancel_self_service_order",
      {
        p_order_id: String(order.id),
        p_customer_id: String(order.customer_id),
        p_expected_quote_status: ["self_cancelling"],
        p_final_quote_status: "self_dispatch_failed",
        p_operation_key: `self-service-timeout-refund:${order.id}`,
        p_reason: "選人期限內未選擇陪陪，自動退款棄單",
      },
    );
    if (cancelError || !cancellation) {
      throw new Error(cancelError?.message || "逾時棄單原子退款失敗");
    }
    refundAmount = Number(cancellation.refund_amount || 0);
    refundedBalance = Number(cancellation.balance || 0);
    if (refundAmount > 0) {
      if (!cancellation.already_processed) {
        // wallet_logs 已由 RPC 寫入；這裡只發送通知。
        await paymentHelpers.sendWalletLog?.(
          order.customer_id,
          "訂單退款",
          refundAmount,
          refundedBalance,
          `自助訂單 ${order.order_no || order.id}｜選人期限內未選擇陪陪，自動退款棄單`,
          false,
        );
      }
    }
    await processFinancialEffect(`self-service-timeout-refund:${order.id}`).catch(
      (effectError) =>
        console.error("[自助派單逾時退款] VIP/會計已排入持久補償", effectError),
    );
    }
  } catch (refundError) {
    // RPC 失敗會整筆 rollback，只有此時才把「取消中」恢復成可繼續選人。
    await supabase
      .from("play_orders")
      .update({ quote_status: restoreQuoteStatus, updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("quote_status", cancellingStatus);
    throw refundError;
  }
  const dispatchChannel = await client.channels.fetch(getClaimDispatchChannelId(order)).catch(() => null);
  const claimMessage = await findSelfServiceClaimMessage(order.id, order);
  const resultChannel = claimMessage?.channel?.isThread?.()
    ? claimMessage.channel
    : dispatchChannel;
  await claimMessage?.edit({ components: [] }).catch(() => null);
  await resultChannel?.send({
    content: `訂單 ${order.order_no || order.id} ${failureReason}`,
    files: [{ attachment: SELF_SERVICE_FAILED_IMAGE, name: "dispatch-failed.png" }],
    allowedMentions: { parse: [] },
  }).catch(() => null);
  const orderChannel = await client.channels.fetch(order.channel_id).catch(() => null);
  const promptKey = `candidatePrompt:${order.id}`;
  const candidatePromptId = pendingSelfServiceOrders.get(promptKey)?.messageId;
  if (candidatePromptId && orderChannel?.isTextBased()) {
    const candidatePrompt = await orderChannel.messages
      .fetch(candidatePromptId)
      .catch(() => null);
    await candidatePrompt?.edit({ components: [] }).catch(() => null);
  }
  pendingSelfServiceOrders.delete(promptKey);
  pendingSelfServiceOrders.delete(`selection:${order.id}`);
  await orderChannel?.send({
    content: wasWaitingForCustomer
      ? `<@${order.customer_id}> 這筆訂單在選人期限內未選擇陪陪，已自動${refundAmount > 0 ? `退款 ${refundAmount.toLocaleString("zh-TW")} ASD 並` : ""}棄單。頻道將於 10 秒後關閉。`
      : `<@${order.customer_id}> 很抱歉，這筆訂單在派單期限內未湊足陪陪，已派單失敗且不會扣款。頻道將於 10 秒後關閉。`,
  }).catch(() => null);
  if (orderChannel) {
    setTimeout(() => orderChannel.delete().catch(() => null), 10_000).unref?.();
  }
  const resultThread = await finishClaimThread(order, {
    succeeded: false,
    reason: failureReason,
  });
  await resultThread?.setArchived(true, "訂單棄單").catch(() => null);
  pendingSelfServiceOrders.delete(`claimMessage:${order.id}`);
}

function scheduleSelfServiceDispatchTimeout(order, messageId = null) {
  const orderId = String(order.id);
  const oldTimer = selfServiceDispatchTimers.get(orderId);
  if (oldTimer) clearTimeout(oldTimer);
  const remaining = Math.max(0, getSelfServiceSelectionDeadline(order) - Date.now());
  const timer = setTimeout(
    () => failSelfServiceDispatch(order.id, messageId).catch((error) => console.error("[自助派單逾時]", error)),
    remaining,
  );
  timer.unref?.();
  selfServiceDispatchTimers.set(orderId, timer);
}

async function restoreSelfServiceDispatchTimers() {
  await migrateLegacySelfServiceClaimButtons();
  const { data: orders, error } = await supabase
    .from("play_orders")
    .select("*")
    .in("quote_status", [
      "self_dispatching",
      "self_choosing_open",
      "confirming_players",
      "manual_dispatching",
      "manual_choosing_open",
      "manual_confirming_players",
    ])
    .or("is_deleted.eq.false,is_deleted.is.null");
  if (error) throw error;
  for (const order of orders || []) scheduleSelfServiceDispatchTimeout(order);
  console.log(`[自助派單] 已恢復 ${(orders || []).length} 筆選人倒數`);
  setTimeout(() => repairSelfServiceClaimThreadNames().catch((error) =>
    console.error("[自助派單] 修復討論串名稱失敗", error)), 3_000).unref?.();
}

function getPendingClaimThreadOrderId(name) {
  if (!String(name || "").startsWith("派單中-")) return null;
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)?.[1] || null;
}

function getClaimThreadOutcome(order) {
  if (!order || !isSelfServiceOrder(order) || isManualDispatchOrder(order)) return null;
  if (["cancelled", "self_dispatch_failed"].includes(order.quote_status)) return false;
  if (["waiting_payment", "waiting_ecpay", "waiting_jkopay", "dispatched"].includes(order.quote_status)) return true;
  return null;
}

async function repairSelfServiceClaimThreadNames() {
  const dispatchChannel = await client.channels.fetch(SELF_SERVICE_DISPATCH_CHANNEL_ID).catch(() => null);
  if (!dispatchChannel?.threads) return;
  const active = await dispatchChannel.threads.fetchActive().catch(() => null);
  const archived = await dispatchChannel.threads.fetchArchived({ type: "public", limit: 100 }).catch(() => null);
  const threads = new Map([...active?.threads?.values?.() || [], ...archived?.threads?.values?.() || []]
    .map((thread) => [thread.id, thread]));
  let repaired = 0;
  let failed = 0;
  for (const thread of threads.values()) {
    const orderId = getPendingClaimThreadOrderId(thread.name);
    if (!orderId) continue;
    const { data: order, error } = await supabase.from("play_orders")
      .select("id,order_no,quote_status,note").eq("id", orderId).maybeSingle();
    if (error) { failed += 1; continue; }
    const succeeded = getClaimThreadOutcome(order);
    if (succeeded === null) continue;
    const wasArchived = thread.archived;
    let editableThread = thread;
    if (wasArchived) {
      editableThread = await thread.setArchived(false, "補正討論串名稱").catch((unarchiveError) => {
        console.error(`[自助派單] 訂單 ${orderId} 無法解除封存`, unarchiveError);
        return null;
      });
    }
    if (!editableThread) { failed += 1; continue; }
    const renamed = await renameClaimThread(editableThread, getDispatchResultThreadName(order, succeeded),
      "補正已結束派單的討論串名稱", orderId);
    if (renamed) {
      repaired += 1;
      if (!renamed.archived) await renamed.setArchived(true, "派單已結束").catch(() => null);
    } else {
      failed += 1;
      if (wasArchived && !editableThread.archived) {
        await editableThread.setArchived(true, "保留原封存狀態").catch(() => null);
      }
    }
  }
  console.log(`[自助派單] 討論串名稱補正：${repaired} 筆，失敗 ${failed} 筆`);
}

async function migrateLegacySelfServiceClaimButtons() {
  const dispatchChannel = await client.channels
    .fetch(SELF_SERVICE_DISPATCH_CHANNEL_ID)
    .catch(() => null);
  if (!dispatchChannel?.isTextBased()) return;
  const messages = await dispatchChannel.messages.fetch({ limit: 100 }).catch(() => null);
  let removedCount = 0;
  let refreshedCount = 0;
  for (const message of messages?.values?.() || []) {
    let claimOrderId = null;
    for (const row of message.components || []) {
      for (const component of row.components || []) {
        claimOrderId =
          parseSelfServiceClaimAction(component.customId)?.orderId ||
          getLegacySelfServiceClaimOrderId(component.customId);
        if (claimOrderId) break;
      }
      if (claimOrderId) break;
    }
    if (!claimOrderId) continue;
    const { data: order } = await supabase
      .from("play_orders")
      .select("id, quote_status")
      .eq("id", claimOrderId)
      .maybeSingle();
    const isActive = ["self_dispatching", "self_choosing_open"].includes(order?.quote_status);
    await message.edit({
      components: isActive ? [buildSelfServiceClaimButtons(claimOrderId)] : [],
    }).catch(() => null);
    if (isActive) refreshedCount += 1;
    else removedCount += 1;
  }
  if (removedCount || refreshedCount) {
    console.log(`[自助派單] 接單按鈕已同步：更新 ${refreshedCount} 則、移除 ${removedCount} 則`);
  }
}

function buildSelfServiceTopic(customerId, orderId = "pending") {
  return `owner:${customerId};self_service:1;order:${orderId}`;
}

function isSelfServiceOrder(order) {
  return /\[SELF_SERVICE(?:_MANUAL)?\]/.test(String(order?.note || ""));
}

function isManualDispatchOrder(order) {
  return String(order?.note || "").includes("[MANUAL_DISPATCH]");
}

function isClaimDispatchOrder(order) {
  return isSelfServiceOrder(order) || isManualDispatchOrder(order);
}

function getManualDispatchChannelId(order) {
  const game = String(order?.game || "").toLowerCase();
  const text = `${game} ${order?.service || ""} ${order?.order_item || ""}`;
  if (game === "valorant" || text.includes("特戰")) return MANUAL_DISPATCH_CHANNEL_IDS.valorant;
  if (game === "delta" || text.includes("三角洲")) return MANUAL_DISPATCH_CHANNEL_IDS.delta;
  if (game === "lol" || game === "tft" || text.includes("英雄聯盟") || text.includes("ARAM") || text.includes("聯盟戰棋")) {
    return MANUAL_DISPATCH_CHANNEL_IDS.lol;
  }
  if (/apex/i.test(text)) return MANUAL_DISPATCH_CHANNEL_IDS.apex;
  if (text.includes("傳說對決")) return MANUAL_DISPATCH_CHANNEL_IDS.arena;
  if (game === "voice_chat" || text.includes("語音聊天") || text.includes("陪聊")) return MANUAL_DISPATCH_CHANNEL_IDS.voice;
  return MANUAL_DISPATCH_CHANNEL_IDS.other;
}

function getClaimDispatchChannelId(order) {
  return isManualDispatchOrder(order)
    ? getManualDispatchChannelId(order)
    : SELF_SERVICE_DISPATCH_CHANNEL_ID;
}

function getClaimDispatchStatuses(order) {
  return isManualDispatchOrder(order)
    ? ["manual_dispatching", "manual_choosing_open"]
    : ["self_dispatching", "self_choosing_open"];
}

function getClaimTimeoutStatuses(order) {
  return [
    ...getClaimDispatchStatuses(order),
    isManualDispatchOrder(order) ? "manual_confirming_players" : "confirming_players",
  ];
}

function getClaimDispatchingStatus(order) {
  return isManualDispatchOrder(order) ? "manual_dispatching" : "self_dispatching";
}

function getClaimChoosingStatus(order) {
  return isManualDispatchOrder(order) ? "manual_choosing_open" : "self_choosing_open";
}

function isManualQuoteSelfServiceOrder(order) {
  return String(order?.note || "").includes("[SELF_SERVICE_MANUAL]");
}

function getSelfServiceRankFieldLabel(order) {
  const service = String(order?.game || order?.service || "");
  if (service.includes("特戰英豪")) return "需求的陪陪段位";
  if (service.includes("語音聊天") || service.includes("陪聊")) return "聊天需求";
  return "段位 / 地圖";
}

async function sendSelfServiceDispatch(order) {
  const dispatchChannel = await client.channels
    .fetch(getClaimDispatchChannelId(order))
    .catch(() => null);
  if (!dispatchChannel?.isTextBased()) {
    throw new Error(`找不到${isManualDispatchOrder(order) ? "遊戲對應" : "自助"}派單頻道，請聯繫管理員。`);
  }
  const { genderRoleIds, serviceRoleIds } =
    getSelfServiceDispatchRoleIds(order);
  const roleIds = [...new Set([...genderRoleIds, ...serviceRoleIds])];
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle(`🖨️ ${isManualDispatchOrder(order) ? "人工下單" : "自助派單"}需求`)
    .setDescription(
      `訂單：${order.order_no}\n服務：${order.service}\n性別：${order.gender_preference || "不指定"}\n${getSelfServiceRankFieldLabel(order)}：${order.rank_preference || "無"}\n需求：${order.player_count} 位\n目前：0 / ${order.player_count}\n訂單頻道：<#${order.channel_id}>\n\n請進入本單的討論串，並在派單開始後 15 分鐘內選擇「1」或「PM」；未選擇人員將自動棄單。`,
    )
    .setTimestamp();
  const dispatchMessage = await dispatchChannel.send({
    content: `${roleIds.map((id) => `<@&${id}>`).join(" ")} 新的${isManualDispatchOrder(order) ? "人工" : "自助"}訂單，請進入討論串跳單。`,
    embeds: [
      embed,
    ],
    allowedMentions: { roles: roleIds },
  });
  const claimThread = await createSelfServiceClaimThread(dispatchMessage, order);
  const claimMessage = claimThread
    ? await claimThread.send({
        content:
          `請在這個討論串內選擇「1」或「PM」並填寫接單備註。\n` +
          `截止時間：<t:${Math.floor(getSelfServiceSelectionDeadline(order) / 1000)}:F>（<t:${Math.floor(getSelfServiceSelectionDeadline(order) / 1000)}:R>）`,
        embeds: [EmbedBuilder.from(embed).setColor(QIUNAI_WATER_BLUE)],
        components: [buildSelfServiceClaimButtons(order.id)],
        allowedMentions: { parse: [] },
      })
    : await dispatchMessage.edit({ components: [buildSelfServiceClaimButtons(order.id)] });
  await rememberSelfServiceClaimMessage(order.id, claimMessage);
  scheduleSelfServiceDispatchTimeout(order, claimMessage.id);
  const orderChannel = await client.channels.fetch(order.channel_id).catch(() => null);
  const threadLink = claimThread ? `<#${claimThread.id}>` : dispatchMessage.url;
  await orderChannel?.send({
    content:
      `<@${order.customer_id}> ✅ 已開始派單：${threadLink}\n` +
      `陪陪可在討論串選擇「1」或「PM」。派單開始後 15 分鐘內未完成陪陪選擇，系統將自動棄單。\n` +
      `截止時間：<t:${Math.floor(getSelfServiceSelectionDeadline(order) / 1000)}:F>；每筆訂單最多可延長一次 5 分鐘。`,
    components: isSelfServiceOrder(order) && !isManualDispatchOrder(order)
      ? [buildDispatchTimeExtensionButton(order), new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`self_service_cancel_refund_${order.id}`).setLabel("按錯了，取消訂單").setStyle(ButtonStyle.Danger),
      )]
      : [buildDispatchTimeExtensionButton(order)],
    allowedMentions: { users: [String(order.customer_id)] },
  }).catch((error) => console.error("[派單] 通知老闆失敗", error));
  return claimMessage;
}

async function sendSelfServiceOrderPanel() {
  const channel = await client.channels
    .fetch(SELF_SERVICE_ORDER_CHANNEL_ID)
    .catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error(`找不到自助下單頻道：${SELF_SERVICE_ORDER_CHANNEL_ID}`);
  }

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("🖲️ 自助下單系統")
    .setDescription(
      `沒有客服在線時，也能依照標準流程完成下單。\n\n` +
      `1. 選擇遊戲或語音聊天並填寫需求\n` +
        `2. 系統依現行價目表自動報價\n` +
        `3. 系統標註性別與遊戲身分組，陪陪在 15 分鐘內選擇「1」或「PM」\n` +
        `4. 客人從候選名單選擇陪陪\n` +
        `5. 使用 ASD 錢包或街口支付，核帳後自動發送報單\n\n` +
        `⏰ 派單開始後 15 分鐘內未選擇陪陪，系統將自動棄單。\n\n` +
        `街口支付會同時提供串接付款按鈕與該筆交易 QR Code，付款完成後由系統自動查帳，不需要上傳付款截圖。`,
    )
    .setFooter({ text: "秋奈電競｜自助下單" })
    .setTimestamp();
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("self_service_start")
        .setLabel("開始自助下單")
        .setEmoji("🛒")
        .setStyle(ButtonStyle.Success),
    ),
  ];
  const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const oldPanel = messages?.find(
    (message) =>
      message.author.id === client.user.id &&
      message.embeds[0]?.title === "🖲️ 自助下單系統",
  );
  if (oldPanel) return oldPanel.edit({ embeds: [embed], components });
  return channel.send({ embeds: [embed], components });
}

async function startSelfServiceOrder(interaction) {
  const flowId = createFlowId(interaction.user.id);
  pendingSelfServiceOrders.set(flowId, {
    flowId,
    customerId: interaction.user.id,
    customerUsername: interaction.user.username,
    guildId: interaction.guildId,
    createdAt: Date.now(),
  });
  const timer = setTimeout(
    () => pendingSelfServiceOrders.delete(flowId),
    ORDER_FLOW_TTL_MS,
  );
  timer.unref?.();
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`self_service_game_${flowId}`)
    .setPlaceholder("選擇遊戲或服務")
    .addOptions(SELF_SERVICE_GAME_OPTIONS);
  return interaction.reply({
    content: "🎮 請選擇要下單的遊戲或服務：",
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: 64,
  });
}

async function openSelfServiceRequirementModal(interaction) {
  const flowId = interaction.customId.replace("self_service_gender_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id) {
    return interaction.reply({ content: "❌ 流程已過期，請重新開始。", flags: 64 });
  }
  const game = pending.game;
  pending.gender = interaction.values[0];
  pendingSelfServiceOrders.set(flowId, pending);
  if (game === "valorant") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`self_service_valorant_target_${flowId}`)
      .setPlaceholder("選擇要打的段位")
      .addOptions([
        {
          label: "娛樂／N/A／無段位",
          value: "娛樂",
          description: "包含 N/A、無或其他未列出的段位",
        },
        { label: "黃金含以下", value: "黃金以下" },
        { label: "白金", value: "白金" },
        { label: "鑽石", value: "鑽石" },
        { label: "超凡", value: "超凡" },
        { label: "神話 1～2", value: "神話1至2" },
        { label: "神話 3", value: "神話3" },
      ]);
    return interaction.update({
      content: "🎯 請先選擇要打的段位：",
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }
  const modal = new ModalBuilder()
    .setCustomId(`self_service_requirement_${flowId}`)
    .setTitle(`${getSelfServiceGameLabel(game)}自助下單`);
  const fields = game === "delta"
    ? [
        ["platform_mode", "平台（僅三角洲必填）", "電腦或手機"],
        [
          "service_type",
          "項目（請輸入完整名稱）",
          DELTA_SERVICE_OPTIONS.map(({ value }) => value).join("、"),
        ],
        ["rank_map", "地圖（僅三角洲必填）", "請輸入地圖"],
        ["quantity", "需求時數", "例如：1、1.5、2"],
      ]
    : game === "lol"
      ? [
          ["platform_mode", "模式", "召喚峽谷、ARAM 或聯盟戰棋"],
          ["service_type", "類型", "娛樂、技術或大神"],
          ["rank_map", "目前段位", "例如：白金、鑽石；ARAM 可填一般"],
          ["player_count", "需求陪陪人數", "1～8"],
          ["quantity", "時數 / 局數", "ARAM 按小時；峽谷、戰棋按局"],
        ]
      : game === "steam"
        ? [
            ["platform_mode", "遊戲名稱", "請輸入 Steam 遊戲名稱"],
            ["service_type", "模式 / 類型", "例如：娛樂"],
            ["rank_map", "其他需求", "沒有可填無"],
            ["player_count", "需求陪陪人數", "1～8"],
            ["quantity", "需求時數", "例如：1、1.5、2"],
          ]
        : game === "voice_chat"
          ? [
              ["platform_mode", "聊天平台 / 方式", "例如：Discord 語音"],
              ["service_type", "聊天類型", "例如：日常聊天、陪伴、傾聽"],
              ["rank_map", "聊天主題 / 其他需求", "沒有可填無"],
              ["player_count", "需求陪陪人數", "1～8"],
              ["quantity", "需求時數", "請以 0.5 小時為單位"],
            ]
        : [
            ["platform_mode", "模式", "例如：一般、排位"],
            ["service_type", "類型", "娛樂、技術或大神"],
            ["rank_map", "目前段位", "請依價目表填寫段位"],
            ["player_count", "需求陪陪人數", "1～8"],
            ["quantity", "時數 / 局數", "請依價目表單位填寫"],
          ];
  modal.addComponents(
    ...fields.map(([id, label, placeholder]) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label.slice(0, 45))
          .setPlaceholder(placeholder.slice(0, 100))
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    ),
  );
  return interaction.showModal(modal);
}

async function selectSelfServiceValorantTarget(interaction) {
  const flowId = interaction.customId.replace("self_service_valorant_target_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id) {
    return interaction.update({ content: "❌ 流程已過期，請重新開始。", components: [] });
  }
  pending.serviceType = interaction.values[0];
  pendingSelfServiceOrders.set(flowId, pending);
  const options = getValorantCompanionOptions(pending.serviceType);
  if (!options.length) {
    return interaction.update({ content: "❌ 此段位目前沒有可選擇的陪陪段位。", components: [] });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`self_service_valorant_companion_${flowId}`)
    .setPlaceholder("選擇需求的陪陪段位")
    .addOptions(options.map((option) => ({
      ...option,
      description: `${pending.serviceType}可選擇的陪陪段位`,
    })));
  return interaction.update({
    content: `🎯 要打的段位：${pending.serviceType}\n請選擇需求的陪陪段位：`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function selectSelfServiceValorantCompanion(interaction) {
  const flowId = interaction.customId.replace("self_service_valorant_companion_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id || !pending.serviceType) {
    return interaction.reply({ content: "❌ 流程已過期，請重新開始。", flags: 64 });
  }
  pending.rankOrMap = interaction.values[0];
  pendingSelfServiceOrders.set(flowId, pending);
  const modal = new ModalBuilder()
    .setCustomId(`self_service_requirement_${flowId}`)
    .setTitle("特戰英豪自助下單")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("platform_mode")
          .setLabel("模式")
          .setPlaceholder("例如：一般、排位")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("player_count")
          .setLabel("需求陪陪人數")
          .setPlaceholder("1～8")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

async function selectSelfServiceGame(interaction) {
  const flowId = interaction.customId.replace("self_service_game_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id) {
    return interaction.update({ content: "❌ 流程已過期，請重新開始。", components: [] });
  }
  pending.game = interaction.values[0];
  pendingSelfServiceOrders.set(flowId, pending);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`self_service_gender_${flowId}`)
    .setPlaceholder("選擇陪陪性別")
    .addOptions([
      { label: "女陪", value: "女陪", description: "派單時標註秋奈女陪" },
      { label: "男陪", value: "男陪", description: "派單時標註秋奈男陪" },
      { label: "不指定", value: "不指定", description: "男陪、女陪皆可登記接單" },
    ]);
  return interaction.update({
    content: `🎮 已選擇：${getSelfServiceGameLabel(pending.game)}\n請選擇陪陪性別：`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function submitSelfServiceRequirement(interaction) {
  await deferReplyOnce(interaction);
  const flowId = interaction.customId.replace("self_service_requirement_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id) {
    return interaction.editReply({ content: "❌ 流程已過期，請重新開始。" });
  }
  const input = {
    game: pending.game,
    platformOrMode: interaction.fields.getTextInputValue("platform_mode"),
    serviceType:
      pending.game === "valorant"
        ? pending.serviceType
        : interaction.fields.getTextInputValue("service_type"),
    rankOrMap:
      pending.game === "valorant"
        ? pending.rankOrMap
        : interaction.fields.getTextInputValue("rank_map"),
    playerCount:
      pending.game === "delta"
        ? null
        : interaction.fields.getTextInputValue("player_count"),
    quantity:
      pending.game === "valorant"
        ? null
        : interaction.fields.getTextInputValue("quantity"),
  };
  if (pending.game === "valorant") {
    const expectedUnit = getValorantExpectedUnit(input);
    pending.input = input;
    pending.expectedUnit = expectedUnit;
    pendingSelfServiceOrders.set(flowId, pending);
    return interaction.editReply({
      content:
        `✅ 已收到特戰需求。\n` +
        `要打的段位：${input.serviceType}\n` +
        `需求的陪陪段位：${input.rankOrMap}\n\n` +
        `此組合按「${expectedUnit}」計算，請繼續輸入${expectedUnit}。`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`self_service_quantity_${flowId}`)
            .setLabel(`輸入${expectedUnit}`)
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
  }
  if (pending.game === "delta") {
    const deltaService = DELTA_SERVICE_OPTIONS.find(
      ({ value }) => value === String(input.serviceType || "").trim(),
    );
    if (!deltaService) {
      return interaction.editReply({
        content:
          "❌ 三角洲項目必須輸入完整字符，請重新開始並輸入以下其中一項：\n" +
          DELTA_SERVICE_OPTIONS.map(({ value }) => `・${value}`).join("\n"),
      });
    }
    const fixedPlayerCount = getDeltaFixedPlayerCount(input.serviceType);
    if (fixedPlayerCount) {
      input.playerCount = String(fixedPlayerCount);
      return finalizeSelfServiceRequirement(interaction, flowId, pending, input);
    }
    pending.input = input;
    pendingSelfServiceOrders.set(flowId, pending);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`self_service_delta_players_${flowId}`)
      .setPlaceholder("選擇需求陪陪人數")
      .addOptions(
        Array.from({ length: 8 }, (_, index) => ({
          label: `${index + 1} 位`,
          value: String(index + 1),
        })),
      );
    return interaction.editReply({
      content:
        `✅ 已收到三角洲需求。\n` +
        `項目：${input.serviceType}\n\n` +
        "請選擇需求陪陪人數；雙護項目會由系統自動固定為 2 位。",
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }
  return finalizeSelfServiceRequirement(interaction, flowId, pending, input);
}

async function selectSelfServiceDeltaPlayers(interaction) {
  const flowId = interaction.customId.replace("self_service_delta_players_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id || !pending.input) {
    return interaction.update({ content: "❌ 流程已過期，請重新開始。", components: [] });
  }
  pending.input.playerCount = interaction.values[0];
  pendingSelfServiceOrders.set(flowId, pending);
  await interaction.deferUpdate();
  return finalizeSelfServiceRequirement(
    interaction,
    flowId,
    pending,
    pending.input,
  );
}

async function openSelfServiceQuantityModal(interaction) {
  const flowId = interaction.customId.replace("self_service_quantity_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id || !pending.input) {
    return interaction.reply({ content: "❌ 流程已過期，請重新開始。", flags: 64 });
  }
  const expectedUnit = pending.expectedUnit || getValorantExpectedUnit(pending.input);
  const modal = new ModalBuilder()
    .setCustomId(`self_service_quantity_submit_${flowId}`)
    .setTitle(`特戰英豪｜輸入${expectedUnit}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel(`需求${expectedUnit}`)
          .setPlaceholder(expectedUnit === "小時" ? "例如：1小時、1.5小時" : "例如：1局、2局、3局")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

async function submitSelfServiceQuantity(interaction) {
  await deferReplyOnce(interaction);
  const flowId = interaction.customId.replace("self_service_quantity_submit_", "");
  const pending = pendingSelfServiceOrders.get(flowId);
  if (!pending || pending.customerId !== interaction.user.id || !pending.input) {
    return interaction.editReply({ content: "❌ 流程已過期，請重新開始。" });
  }
  const rawQuantity = interaction.fields.getTextInputValue("quantity").trim();
  const expectedUnit = pending.expectedUnit || getValorantExpectedUnit(pending.input);
  const enteredHours = /(小時|鐘頭|hours?|hrs?)/i.test(rawQuantity);
  const enteredRounds = /局/.test(rawQuantity);
  const retryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`self_service_quantity_${flowId}`)
      .setLabel(`重新輸入${expectedUnit}`)
      .setStyle(ButtonStyle.Primary),
  );
  if (expectedUnit === "小時" && enteredRounds) {
    return interaction.editReply({
      content: "❌ 此組合只能輸入時數，請再輸入一次。",
      components: [retryRow],
    });
  }
  if (expectedUnit === "局" && enteredHours) {
    return interaction.editReply({
      content: "❌ 此組合只能輸入局數，請再輸入一次。",
      components: [retryRow],
    });
  }
  const input = { ...pending.input, quantity: rawQuantity };
  return finalizeSelfServiceRequirement(interaction, flowId, pending, input);
}

async function finalizeSelfServiceRequirement(interaction, flowId, pending, input) {
  let quote;
  try {
    quote = calculateSelfServicePrice(input);
  } catch (error) {
    const reason = String(error.message || error);
    const shouldEscalate =
      reason.includes("沒有這個") ||
      reason.includes("不在目前") ||
      reason.includes("尚缺自動報價");
    if (shouldEscalate) {
      const guild = interaction.guild;
      const parentId = await resolveTicketParentId(
        guild,
        ORDER_TICKET_CATEGORY_ID,
        "訂單區",
      );
      const safeName = interaction.user.username
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
        .slice(0, 20);
      const channel = await guild.channels.create({
        name: `待客服報價-${safeName}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: parentId,
        topic: `owner:${interaction.user.id};self_service_manual_quote:1`,
        permissionOverwrites: [
          { id: guild.id, deny: ["ViewChannel"] },
          { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles"] },
          { id: process.env.STAFF_ROLE, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "ManageMessages"] },
        ],
      });
      const playerCount = Number(String(input.playerCount || "").replace(/[^\d]/g, "")) || 1;
      const manualPending = {
        guildId: pending.guildId,
        userId: pending.customerId,
        username: pending.customerUsername,
        channelId: channel.id,
        game: getSelfServiceGameLabel(pending.game),
        item: `${input.platformOrMode}｜${input.serviceType}`,
        rank: input.rankOrMap,
        playerCount,
        gender: pending.gender || "不指定",
        duration: input.quantity,
        durationMinutes: 0,
        note:
          `[SELF_SERVICE_MANUAL] 自動報價無此組合：${reason}；` +
          `平台/模式：${input.platformOrMode}；` +
          `${pending.game === "valorant" ? "要打的段位" : pending.game === "voice_chat" ? "聊天類型" : "類型"}：${input.serviceType}；` +
          `${pending.game === "valorant" ? "需求的陪陪段位" : pending.game === "voice_chat" ? "聊天需求" : "段位/地圖"}：${input.rankOrMap}；數量：${input.quantity}`,
      };
      await channel.send({
        content: `<@${pending.customerId}> <@&${process.env.STAFF_ROLE}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(QIUNAI_WATER_BLUE)
            .setTitle("⚠️ 自助訂單無價格組合｜轉客服報價")
            .setDescription(
              `系統已保留客人填寫的資料，不需要重新填寫。\n\n` +
                `遊戲：${manualPending.game}\n` +
                `平台 / 模式：${input.platformOrMode}\n` +
                `${pending.game === "valorant" ? "要打的段位" : pending.game === "voice_chat" ? "聊天類型" : "類型"}：${input.serviceType}\n` +
                `${pending.game === "valorant" ? "需求的陪陪段位" : pending.game === "voice_chat" ? "聊天需求" : "段位 / 地圖"}：${input.rankOrMap}\n` +
                `性別：${manualPending.gender}\n` +
                `人數：${playerCount}\n` +
                `${pending.game === "voice_chat" ? "時數" : "時數 / 局數"}：${input.quantity}\n` +
                `轉人工原因：${reason}`,
            )
            .setTimestamp(),
        ],
      });
      pendingSelfServiceOrders.delete(flowId);
      await createWaitingQuoteOrder(interaction, flowId, manualPending);
      await interaction.followUp({
        content: `✅ 這個組合沒有自動價格，已建立 <#${channel.id}> 並標註客服協助報價。`,
        flags: 64,
      }).catch(() => null);
      return;
    }
    return interaction.editReply({
      content: `❌ 無法自動報價：${reason}\n請依頻道內現行價目表重新填寫。`,
    });
  }
  const guild = interaction.guild;
  const parentId = await resolveTicketParentId(guild, ORDER_TICKET_CATEGORY_ID, "訂單區");
  const safeName = interaction.user.username
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
    .slice(0, 20);
  const channel = await guild.channels.create({
    name: `自助訂單-${safeName}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: buildSelfServiceTopic(interaction.user.id),
    permissionOverwrites: [
      { id: guild.id, deny: ["ViewChannel"] },
      { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles"] },
      { id: process.env.STAFF_ROLE, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "ManageMessages"] },
    ],
  });
  const orderNo = await getNextPlayOrderNumber();
  const gameLabel = getSelfServiceGameLabel(pending.game);
  const service = `${gameLabel}｜${input.platformOrMode}｜${input.serviceType}`;
  const note = `[SELF_SERVICE] 平台/模式：${input.platformOrMode}；段位/地圖：${input.rankOrMap}；單價：${quote.unitPrice}/${quote.unit}；數量：${quote.quantity}`;
  const { data: order, error } = await supabase
    .from("play_orders")
    .insert({
      guild_id: pending.guildId || process.env.GUILD_ID,
      order_no: orderNo,
      customer_id: pending.customerId,
      customer_username: pending.customerUsername,
      channel_id: channel.id,
      source_channel_id: SELF_SERVICE_ORDER_CHANNEL_ID,
      game: gameLabel,
      service,
      dispatch_service_key: getSelfServiceDispatchKey(pending.game, input),
      order_type: "自助訂單",
      order_item: input.serviceType,
      rank_preference: input.rankOrMap,
      player_count: quote.playerCount,
      gender_preference: pending.gender || "不指定",
      duration_text: `${quote.quantity} ${quote.unit}`,
      note,
      price: quote.total,
      original_price: quote.total,
      final_price: quote.total,
      discount_rate: 1,
      discount_amount: 0,
      coupon_text: "未使用優惠券",
      payment_method: "未選擇",
      paid: false,
      status: "quoted",
      quote_status: "quoted",
      confirmed_by_customer: false,
    })
    .select()
    .single();
  if (error || !order) {
    await channel.delete().catch(() => null);
    console.error("[自助下單] 建立訂單失敗", error);
    return interaction.editReply({ content: `❌ 建立訂單失敗：${error?.message || "未知錯誤"}` });
  }
  pending.orderId = order.id;
  pending.channelId = channel.id;
  pending.input = input;
  pending.quote = quote;
  pendingSelfServiceOrders.set(flowId, pending);
  await channel.setTopic(buildSelfServiceTopic(pending.customerId, order.id)).catch(() => null);
  await channel.send({
    content: `<@${pending.customerId}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💰 自動報價確認")
        .setDescription(
          `訂單編號：${order.order_no}\n遊戲：${gameLabel}\n平台 / 模式：${input.platformOrMode}\n${pending.game === "valorant" ? "要打的段位" : "類型"}：${input.serviceType}\n${pending.game === "valorant" ? "需求的陪陪段位" : "段位 / 地圖"}：${input.rankOrMap}\n陪陪人數：${quote.playerCount} 位\n數量：${quote.quantity} ${quote.unit}\n單價：NT$${quote.unitPrice.toLocaleString("zh-TW")} / ${quote.unit} / 位\n\n應付總額：**NT$${quote.total.toLocaleString("zh-TW")}**\n\n⏰ 確認派單後，15 分鐘內未選擇陪陪將自動棄單。`,
        )
        .setFooter({ text: "確認後會送往自助派單廳" })
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`self_service_quote_yes_${order.id}`).setLabel("接受報價並派單").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`self_service_quote_no_${order.id}`).setLabel("按錯了，取消訂單").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`self_service_extend_${order.id}`).setLabel("我要加時").setStyle(ButtonStyle.Secondary).setDisabled(true),
      ),
    ],
  });
  return interaction.editReply({ content: `✅ 已建立臨時頻道：<#${channel.id}>` });
}

async function getSelfServiceOrder(interaction, prefix) {
  const orderId = interaction.customId.replace(prefix, "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order || !isClaimDispatchOrder(order)) return null;
  return order;
}

async function confirmSelfServiceQuote(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_service_quote_yes_");
  if (!order || !isSelfServiceOrder(order)) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以確認報價。" });
  if (order.quote_status === "self_dispatching" || order.preferred_player) {
    return interaction.editReply({ content: "⚠️ 這張訂單已送出派單，請勿重複操作。" });
  }
  const dispatchAtIso = new Date().toISOString();
  const dispatchNote = `${String(order.note || "").replace(/\[DISPATCH_AT:[^\]]+\]/g, "").trim()} [DISPATCH_AT:${dispatchAtIso}]`;
  const { data: dispatchOrder, error } = await supabase
    .from("play_orders")
    .update({ status: "pending", quote_status: "self_dispatching", confirmed_by_customer: true, preferred_player: null, note: dispatchNote, updated_at: dispatchAtIso })
    .eq("id", order.id)
    .eq("quote_status", "quoted")
    .select()
    .single();
  if (error || !dispatchOrder) return interaction.editReply({ content: "❌ 更新訂單狀態失敗。" });
  try {
    await sendSelfServiceDispatch(dispatchOrder);
  } catch (dispatchError) {
    console.error("[自助派單] 發送失敗", dispatchError);
    return interaction.editReply({ content: `❌ ${dispatchError.message || dispatchError}` });
  }
  await interaction.message.edit({ components: [] }).catch(() => null);
  return interaction.editReply({ content: "✅ 已確認報價並送出派單。" });
}

async function showSelfServiceCandidatePrompt(order, playerIds, messageId = null) {
  const orderChannel = await client.channels.fetch(order.channel_id).catch(() => null);
  if (!orderChannel?.isTextBased()) return;
  const needCount = Number(order.player_count || 1);
  const deadlineUnix = Math.floor(getSelfServiceSelectionDeadline(order) / 1000);
  const claimNotes = getSelfServiceClaimNotes(order.note);
  const claimTypes = getSelfServiceClaimTypes(order.note);
  const numberOptions = playerIds.slice(0, 25).map((id, index) => ({
    label: `${index + 1}. ${orderChannel.guild?.members?.cache?.get(id)?.displayName || `陪陪 ${index + 1}`}`.slice(0, 100),
    description: `${getSelfServiceClaimTypeLabel(claimTypes.get(id))}${claimNotes.get(id) ? `｜${safeSelfServiceClaimNote(claimNotes.get(id), 60)}` : ""}`.slice(0, 100),
    value: String(index + 1),
  }));
  const payload = {
    content:
      `<@${order.customer_id}> 已湊足人數，兩種接單仍會持續開放；請從目前候選名單選擇 ${needCount} 位陪陪：\n` +
      `${playerIds.map((id, index) => {
        const claimNote = safeSelfServiceClaimNote(claimNotes.get(id));
        const claimTypeLabel = getSelfServiceClaimTypeLabel(claimTypes.get(id));
        return `${index + 1}. <@${id}>｜${claimTypeLabel}${claimNote ? `｜備註：${claimNote}` : ""}`;
      }).join("\n")}\n\n` +
      `選完後，系統會依數字判斷對應人員並請你再次確認。\n` +
      `⏰ 請於 <t:${deadlineUnix}:F>（<t:${deadlineUnix}:R>）前完成選擇，逾時系統將自動棄單。`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`self_customer_numbers_${order.id}`)
          .setPlaceholder(`請依數字選擇 ${needCount} 位陪陪`)
          .setMinValues(needCount)
          .setMaxValues(needCount)
          .addOptions(numberOptions),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`self_selection_extend_${order.id}`)
          .setLabel("延長派單時間（+5 分鐘，限一次）")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(hasExtendedDispatchTime(order)),
        new ButtonBuilder()
          .setCustomId(`self_service_cancel_refund_${order.id}`)
          .setLabel("按錯了，取消訂單")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
  const promptKey = `candidatePrompt:${order.id}`;
  const cachedMessageId = messageId || pendingSelfServiceOrders.get(promptKey)?.messageId;
  const cachedMessage = cachedMessageId
    ? await orderChannel.messages.fetch(cachedMessageId).catch(() => null)
    : null;
  const message = cachedMessage
    ? await cachedMessage.edit(payload).catch(() => null)
    : await orderChannel.send(payload).catch(() => null);
  if (message) pendingSelfServiceOrders.set(promptKey, { messageId: message.id });
}

async function extendSelfServiceSelectionTime(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_selection_extend_");
  if (!order) {
    return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  }
  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({ content: "❌ 只有原下單者可以延長選人時間。" });
  }
  if (!getClaimDispatchStatuses(order).includes(order.quote_status)) {
    return interaction.editReply({ content: "❌ 這張訂單目前不在派單或選人階段。" });
  }
  if (hasExtendedDispatchTime(order)) {
    return interaction.editReply({ content: "❌ 每筆訂單最多只能延長一次 5 分鐘。" });
  }
  if (processingSelfServiceSelectionExtensions.has(order.id)) {
    return interaction.editReply({ content: "⚠️ 正在延長選人時間，請勿重複點擊。" });
  }

  processingSelfServiceSelectionExtensions.add(order.id);
  try {
    if (Date.now() >= getSelfServiceSelectionDeadline(order)) {
      const dispatchMessage = await findSelfServiceClaimMessage(order.id);
      await failSelfServiceDispatch(order.id, dispatchMessage?.id);
      return interaction.editReply({ content: "❌ 選人時間已結束，這張訂單已自動棄單。" });
    }

    const extension = extendSelfServiceSelectionDeadline(order);
    const { data: updatedOrder, error } = await supabase
      .from("play_orders")
      .update({
        note: extension.note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("customer_id", order.customer_id)
      .eq("quote_status", order.quote_status)
      .eq("updated_at", order.updated_at)
      .select()
      .maybeSingle();
    if (error || !updatedOrder) {
      return interaction.editReply({
        content: "⚠️ 訂單狀態已更新，請重新查看最新的選人訊息。",
      });
    }

    const dispatchMessage = await findSelfServiceClaimMessage(order.id);
    scheduleSelfServiceDispatchTimeout(updatedOrder, dispatchMessage?.id);
    const playerIds = String(updatedOrder.preferred_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (playerIds.length >= Number(updatedOrder.player_count || 1)) {
      await showSelfServiceCandidatePrompt(updatedOrder, playerIds);
    }
    if (interaction.message?.components?.length) {
      const components = interaction.message.components.map((row) =>
        ActionRowBuilder.from(row),
      );
      for (const row of components) {
        for (const component of row.components) {
          if (component.data?.custom_id === interaction.customId) component.setDisabled(true);
        }
      }
      await interaction.message.edit({ components }).catch(() => null);
    }

    const deadlineUnix = Math.floor(extension.deadlineAt / 1000);
    const notifyChannel = dispatchMessage?.channel?.isThread?.()
      ? dispatchMessage.channel
      : await client.channels.fetch(getClaimDispatchChannelId(updatedOrder)).catch(() => null);
    await notifyChannel?.send({
      content:
        `⏱️ 訂單 ${order.order_no || order.id}：老闆已將選人時間延長 5 分鐘。\n` +
        `新的截止時間：<t:${deadlineUnix}:F>（<t:${deadlineUnix}:R>）`,
      allowedMentions: { parse: [] },
    }).catch((notifyError) =>
      console.error("[自助派單延長選人] 派單區通知失敗", notifyError),
    );
    return interaction.editReply({
      content: `✅ 已延長 5 分鐘；新的選人截止時間為 <t:${deadlineUnix}:F>（<t:${deadlineUnix}:R>）。`,
    });
  } finally {
    processingSelfServiceSelectionExtensions.delete(order.id);
  }
}

async function closeSelfServiceClaimButton(orderId) {
  const dispatchMessage = await findSelfServiceClaimMessage(orderId);
  await dispatchMessage?.edit({ components: [] }).catch(() => null);
}

function isSelfServiceClaimMessage(message, orderId, orderNo) {
  if (message?.components?.some((row) => row.components?.some((component) =>
    parseSelfServiceClaimAction(component.customId)?.orderId === String(orderId)))) return true;
  // 選人後接單按鈕會被移除；重新啟動時仍須能以訂單編號找回原訊息。
  return Boolean(orderNo && message?.content?.startsWith("請在這個討論串內選擇") &&
    message.embeds?.some((embed) => String(embed.description || "").split("\n")
      .some((line) => line.trim() === `訂單：${orderNo}`)));
}

async function findSelfServiceClaimMessage(orderId, knownOrder = null) {
  const cacheKey = `claimMessage:${orderId}`;
  const cached = pendingSelfServiceOrders.get(cacheKey);
  if (cached?.channelId && cached?.messageId) {
    const cachedChannel = await client.channels.fetch(cached.channelId).catch(() => null);
    const cachedMessage = cachedChannel?.isTextBased()
      ? await cachedChannel.messages.fetch(cached.messageId).catch(() => null)
      : null;
    if (cachedMessage) return cachedMessage;
    pendingSelfServiceOrders.delete(cacheKey);
  }

  let sourceOrder = knownOrder;
  if (!sourceOrder) {
    const current = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
    sourceOrder = current.data || null;
  }
  // 切換為遊戲分流後，仍要能找回部署前位於舊自助派單廳的進行中訂單。
  const channelIds = [...new Set([getClaimDispatchChannelId(sourceOrder), SELF_SERVICE_DISPATCH_CHANNEL_ID])];
  for (const channelId of channelIds) {
    const dispatchChannel = await client.channels.fetch(channelId).catch(() => null);
    if (!dispatchChannel?.isTextBased()) continue;
    const messages = await dispatchChannel.messages.fetch({ limit: 100 }).catch(() => null);
    const legacyMessage = messages?.find((message) =>
      message.components.some((row) => row.components.some(
        (component) => parseSelfServiceClaimAction(component.customId)?.orderId === String(orderId),
      )),
    ) || null;
    if (legacyMessage) {
      await rememberSelfServiceClaimMessage(orderId, legacyMessage);
      return legacyMessage;
    }

    const activeThreads = dispatchChannel.threads?.fetchActive
      ? await dispatchChannel.threads.fetchActive().catch(() => null)
      : null;
    for (const source of ["active", "archived"]) {
      const threads = source === "active" ? activeThreads?.threads : (dispatchChannel.threads?.fetchArchived
        ? (await dispatchChannel.threads.fetchArchived({ type: "public", limit: 100 }).catch(() => null))?.threads
        : null);
      for (const thread of threads?.values?.() || []) {
        if (!thread.name.includes(String(orderId))) continue;
        const threadMessages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
        const claimMessage = threadMessages?.find((message) =>
          isSelfServiceClaimMessage(message, orderId, sourceOrder?.order_no),
        );
        if (claimMessage) {
          await rememberSelfServiceClaimMessage(orderId, claimMessage);
          return claimMessage;
        }
      }
    }
  }
  return null;
}

async function openSelfServiceClaimModal(interaction) {
  const action = parseSelfServiceClaimAction(interaction.customId);
  if (!action) return interaction.reply({ content: "❌ 無法辨識接單方式。", flags: 64 });
  const { orderId, claimType } = action;
  const claimTypeLabel = getSelfServiceClaimTypeLabel(claimType);
  const modal = new ModalBuilder()
    .setCustomId(`self_service_claim_submit_${claimType}_${orderId}`)
    .setTitle(`自助派單｜${claimTypeLabel}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("claim_note")
          .setLabel("接單備註（選填）")
          .setPlaceholder("例如：可立即開始、可配合指定需求")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(80)
          .setRequired(false),
      ),
    );
  return interaction.showModal(modal);
}

async function claimSelfServiceOrder(interaction) {
  await deferReplyOnce(interaction);
  const action = parseSelfServiceClaimAction(interaction.customId, { submit: true });
  if (!action) return interaction.editReply({ content: "❌ 無法辨識接單方式。" });
  const { orderId, claimType } = action;
  const claimTypeLabel = getSelfServiceClaimTypeLabel(claimType);
  const claimNote = interaction.fields.getTextInputValue("claim_note").trim();
  if (processingSelfServiceClaims.has(orderId)) {
    return interaction.editReply({ content: "⚠️ 另一位陪陪正在登記接單，請稍後再試。" });
  }
  processingSelfServiceClaims.add(orderId);
  try {
    const { data: order, error } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
    if (error || !order || !isClaimDispatchOrder(order)) return interaction.editReply({ content: "❌ 找不到這張派單。" });
    if (!getClaimDispatchStatuses(order).includes(order.quote_status)) return interaction.editReply({ content: "❌ 這張訂單已經結束派單。" });
    if (Date.now() >= getSelfServiceSelectionDeadline(order)) {
      const dispatchMessage = await findSelfServiceClaimMessage(order.id);
      await failSelfServiceDispatch(order.id, dispatchMessage?.id);
      return interaction.editReply({ content: "❌ 已超過 15 分鐘，這張訂單派單失敗。" });
    }
    if (interaction.user.id === order.customer_id) return interaction.editReply({ content: "❌ 不能接自己的訂單。" });
    const playerIds = String(order.preferred_player || "").split(",").map((id) => id.trim()).filter(Boolean);
    const alreadyClaimed = playerIds.includes(interaction.user.id);
    const oldClaimType = getSelfServiceClaimTypes(order.note).get(interaction.user.id);
    if (alreadyClaimed && oldClaimType === claimType) {
      return interaction.editReply({ content: `⚠️ 你目前已經是「${claimTypeLabel}」，如要更換請按另一個按鈕。` });
    }
    const needCount = Number(order.player_count || 1);
    if (!alreadyClaimed && playerIds.length >= 25) return interaction.editReply({ content: "❌ 候選名單已達 Discord 選單上限 25 位。" });
    if (!alreadyClaimed) playerIds.push(interaction.user.id);
    const success = playerIds.length >= needCount;
    const updatedNote = appendSelfServiceClaimNote(
      order.note,
      interaction.user.id,
      claimNote,
      claimType,
    );
    const { data: updated, error: updateError } = await supabase
      .from("play_orders")
      .update({
        preferred_player: playerIds.join(","),
        quote_status: success ? getClaimChoosingStatus(order) : getClaimDispatchingStatus(order),
        note: updatedNote,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("quote_status", order.quote_status)
      .eq("updated_at", order.updated_at)
      .select()
      .maybeSingle();
    if (updateError || !updated) return interaction.editReply({ content: "❌ 接單登記失敗，訂單狀態可能已更新。" });
    const changeText = alreadyClaimed
      ? `${interaction.user} 已將接單方式由「${getSelfServiceClaimTypeLabel(oldClaimType)}」改為「${claimTypeLabel}」`
      : `${interaction.user} ${claimTypeLabel}（${playerIds.length}/${needCount}）`;
    await interaction.channel.send({
      content:
        changeText +
        (claimNote ? `｜備註：${safeSelfServiceClaimNote(claimNote, 80)}` : ""),
      allowedMentions: { users: [interaction.user.id] },
    });
    if (alreadyClaimed) {
      const orderChannel = await client.channels.fetch(order.channel_id).catch(() => null);
      await orderChannel?.send({
        content:
          `🔄 候選陪陪 <@${interaction.user.id}> 已將接單方式由「${getSelfServiceClaimTypeLabel(oldClaimType)}」改為「${claimTypeLabel}」` +
          (claimNote ? `｜備註：${safeSelfServiceClaimNote(claimNote, 80)}` : ""),
        allowedMentions: { users: [String(order.customer_id)] },
      }).catch(() => null);
    }
    if (!success) {
      const dispatchMessage = await findSelfServiceClaimMessage(order.id);
      const embed = dispatchMessage?.embeds?.[0]
        ? EmbedBuilder.from(dispatchMessage.embeds[0]).setDescription(
        `訂單：${order.order_no}\n服務：${order.service}\n性別：${order.gender_preference || "不指定"}\n段位 / 地圖：${order.rank_preference || "無"}\n需求：${needCount} 位\n目前：${playerIds.length} / ${needCount}\n訂單頻道：<#${order.channel_id}>\n\n請在派單開始後 15 分鐘內完成陪陪選擇；未選擇人員將自動棄單。`,
      )
        : null;
      if (dispatchMessage && embed) {
        await dispatchMessage.edit({ embeds: [embed] }).catch(() => null);
      }
      return interaction.editReply({ content: `✅ ${alreadyClaimed ? `已改為 ${claimTypeLabel}` : `${claimTypeLabel} 已登記`}，正在等待其他陪陪。` });
    }
    await showSelfServiceCandidatePrompt(updated, playerIds);
    return interaction.editReply({ content: `✅ ${alreadyClaimed ? `已改為 ${claimTypeLabel}` : `${claimTypeLabel} 已登記並加入候選名單`}；老闆選定前兩種接單仍會持續開放。` });
  } finally {
    processingSelfServiceClaims.delete(orderId);
  }
}

async function selectSelfServicePlayerNumbers(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_customer_numbers_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以選擇陪陪。" });
  if (![getClaimChoosingStatus(order), "choosing_players", "manual_choosing_players"].includes(order.quote_status)) return interaction.editReply({ content: "❌ 這份數字名單已失效，請重新派單。" });
  if (Date.now() >= getSelfServiceSelectionDeadline(order)) {
    const dispatchMessage = await findSelfServiceClaimMessage(order.id);
    await failSelfServiceDispatch(order.id, dispatchMessage?.id);
    return interaction.editReply({ content: "❌ 選人時間已結束，這張訂單已自動棄單。" });
  }
  const candidates = String(order.preferred_player || "").split(",").map((id) => id.trim()).filter(Boolean);
  const needCount = Number(order.player_count || 1);
  let selectedIds;
  try {
    selectedIds = resolveSelfServicePlayerNumbers(candidates, interaction.values, needCount);
  } catch {
    return interaction.editReply({ content: "❌ 選擇的數字無效或人數不符，請重新選擇。" });
  }
  const selectedNumbers = interaction.values.map((value) => Number(value));
  const claimNotes = getSelfServiceClaimNotes(order.note);
  const claimTypes = getSelfServiceClaimTypes(order.note);
  const { data: selectedOrder, error } = await supabase
    .from("play_orders")
    .update({
      preferred_player: selectedIds.join(","),
      quote_status: isManualDispatchOrder(order) ? "manual_confirming_players" : "confirming_players",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .eq("quote_status", order.quote_status)
    .select("id")
    .maybeSingle();
  if (error || !selectedOrder) return interaction.editReply({ content: "❌ 儲存數字選擇失敗，名單可能已由其他操作更新。" });
  pendingSelfServiceOrders.set(`selection:${order.id}`, {
    customerId: order.customer_id,
    selectedIds,
  });
  pendingSelfServiceOrders.delete(`candidatePrompt:${order.id}`);
  await interaction.message.edit({ components: [] }).catch(() => null);
  const claimMessage = await findSelfServiceClaimMessage(order.id, order);
  await closeSelfServiceClaimButton(order.id);
  const includesPm = selectedIds.some((id) => claimTypes.get(id) === "want");
  await interaction.channel.send({
    content:
      `<@${order.customer_id}> 你選擇的編號：${selectedNumbers.join("、")}\n` +
      `對應陪陪：\n${selectedIds.map((id) => {
        const claimNote = safeSelfServiceClaimNote(claimNotes.get(id), 80);
        return `<@${id}>｜${getSelfServiceClaimTypeLabel(claimTypes.get(id))}${claimNote ? `｜備註：${claimNote}` : ""}`;
      }).join("\n")}\n\n` +
      (includesPm
        ? `你選到至少一位「PM」陪陪，請再次確認是否確定選擇。`
        : `請確認是否選擇以上陪陪。`),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`self_players_confirm_${order.id}`).setLabel(includesPm ? "確認選擇 PM 陪陪" : "確定選擇").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`self_players_reselect_${order.id}`).setLabel("重新派單").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`self_service_cancel_refund_${order.id}`).setLabel("按錯了，取消訂單").setStyle(ButtonStyle.Danger),
    )],
  });
  return interaction.editReply({ content: "✅ 已依數字找到對應陪陪，請再次確認。" });
}

async function cancelSelfServiceOrder(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_service_quote_no_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以取消。" });
  const { data: cancelled, error } = await supabase.from("play_orders")
    .update({ status: "cancelled", quote_status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", order.id).eq("paid", false).eq("quote_status", "quoted")
    .select("id").maybeSingle();
  if (error || !cancelled) return interaction.editReply({ content: "⚠️ 訂單狀態已更新，無法在報價頁取消；請使用目前訂單畫面的取消按鈕。" });
  await interaction.message.edit({ components: [] }).catch(() => null);
  await interaction.editReply({ content: "✅ 已取消訂單，頻道將在 10 秒後關閉。" });
  scheduleChannelDeletion(interaction, 10_000);
}

function getSelfServiceCancellationRefundAmount(order) {
  if (!order?.paid) return 0;
  if (!isWalletPaymentMethod(order.payment_method)) {
    throw new Error("這張訂單不是 ASD 付款，請聯繫客服人工退款");
  }
  const amount = Number(order.final_price ?? order.price ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("訂單退款金額不正確");
  }
  return amount;
}

async function cancelAndRefundSelfServiceOrder(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(
    interaction,
    "self_service_cancel_refund_",
  );
  if (!order) {
    return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  }
  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({ content: "❌ 只有原下單者可以退款並取消訂單。" });
  }
  if (processingSelfServiceCancellations.has(order.id)) {
    return interaction.editReply({ content: "⚠️ 退款取消正在處理，請勿重複點擊。" });
  }

  processingSelfServiceCancellations.add(order.id);
  const previousQuoteStatus = order.quote_status;
  let refundAmount = 0;
  let refundedBalance = null;
  try {
    const cancellableStatuses = isManualDispatchOrder(order)
      ? ["manual_choosing_open", "manual_choosing_players"]
      : ["self_dispatching", "self_choosing_open", "choosing_players", "confirming_players"];
    if (!cancellableStatuses.includes(previousQuoteStatus)) {
      return interaction.editReply({ content: "❌ 這張訂單已不在選擇陪陪階段，無法重複取消。" });
    }
    let cancellation = null;
    if (isManualDispatchOrder(order)) {
      const { data: cancelled, error: cancelError } = await supabase
        .from("play_orders")
        .update({ status: "cancelled", quote_status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", order.id)
        .eq("paid", false)
        .eq("quote_status", previousQuoteStatus)
        .select("id")
        .maybeSingle();
      if (cancelError || !cancelled) throw new Error(cancelError?.message || "取消訂單失敗");
    } else {
      const result = await supabase.rpc(
        "qiunai_cancel_self_service_order",
        {
          p_order_id: String(order.id),
          p_customer_id: String(order.customer_id),
          p_expected_quote_status: [previousQuoteStatus],
          p_final_quote_status: "cancelled",
          p_operation_key: `self-service-cancel-refund:${order.id}`,
          p_reason: "沒有心儀的陪陪，取消並退款",
        },
      );
      cancellation = result.data;
      if (result.error || !cancellation) {
        throw new Error(result.error?.message || "取消訂單原子退款失敗");
      }
      refundAmount = Number(cancellation.refund_amount || 0);
      refundedBalance = Number(cancellation.balance || 0);
    }

    if (refundAmount > 0 && cancellation) {
      if (!cancellation.already_processed) {
        // wallet_logs 已由 RPC 寫入；這裡只發送通知。
        await paymentHelpers.sendWalletLog?.(
          order.customer_id,
          "訂單退款",
          refundAmount,
          refundedBalance,
          `自助訂單 ${order.order_no || order.id}｜沒有心儀的陪陪，取消並退款`,
          false,
        );
      }
    }
    if (!isManualDispatchOrder(order)) await processFinancialEffect(`self-service-cancel-refund:${order.id}`).catch(
      (effectError) =>
        console.error("[自助下單取消退款] VIP/會計已排入持久補償", effectError),
    );

    const timer = selfServiceDispatchTimers.get(String(order.id));
    if (timer) clearTimeout(timer);
    selfServiceDispatchTimers.delete(String(order.id));
    pendingSelfServiceOrders.delete(`selection:${order.id}`);
    pendingSelfServiceOrders.delete(`candidatePrompt:${order.id}`);
    await closeSelfServiceClaimButton(order.id);
    const claimMessage = await findSelfServiceClaimMessage(order.id, order);
    const dispatchChannel = await client.channels.fetch(getClaimDispatchChannelId(order)).catch(() => null);
    const resultChannel = claimMessage?.channel?.isThread?.() ? claimMessage.channel : dispatchChannel;
    await resultChannel?.send({
      content: `訂單 ${order.order_no || order.id} 已由老闆手動棄單。`,
      files: [{ attachment: SELF_SERVICE_FAILED_IMAGE, name: "dispatch-failed.png" }],
      allowedMentions: { parse: [] },
    }).catch(() => null);
    const resultThread = await finishClaimThread(order, {
      succeeded: false,
      reason: "老闆已手動棄單",
    });
    await resultThread?.setArchived(true, "自動棄單").catch(() => null);
    pendingSelfServiceOrders.delete(`claimMessage:${order.id}`);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send(
      "感謝您使用自助下單系統，歡迎下次光臨，頻道將於十秒後關閉，再見",
    );
    await interaction.editReply({
      content:
        refundAmount > 0
          ? `✅ 已退款 ${refundAmount.toLocaleString("zh-TW")} ASD 並取消訂單。`
          : "✅ 此訂單尚未扣款，已取消訂單。",
    });
    scheduleChannelDeletion(interaction, 10_000);
  } catch (error) {
    console.error("[自助下單取消退款] 失敗", error);
    return interaction.editReply({
      content: `❌ 退款並取消訂單失敗：${error.message || error}`,
    });
  } finally {
    processingSelfServiceCancellations.delete(order.id);
  }
}

async function confirmSelfServicePlayers(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_players_confirm_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  const selection = pendingSelfServiceOrders.get(`selection:${order.id}`);
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以確認。" });
  const selectedIds = selection?.customerId === interaction.user.id
    ? selection.selectedIds
    : String(order.preferred_player || "").split(",").filter(Boolean);
  const expectedConfirmStatus = isManualDispatchOrder(order)
    ? "manual_confirming_players"
    : "confirming_players";
  if (!selectedIds.length || order.quote_status !== expectedConfirmStatus) return interaction.editReply({ content: "❌ 接單名單已過期，請重新派單。" });
  if (Date.now() >= getSelfServiceSelectionDeadline(order)) {
    await failSelfServiceDispatch(order.id);
    return interaction.editReply({ content: "❌ 派單時間已結束，這張訂單已自動棄單。" });
  }
  if (isManualDispatchOrder(order)) {
    const { data: quotedOrder, error } = await supabase
      .from("play_orders")
      .update({
        preferred_player: selectedIds.join(","),
        status: "quoted",
        quote_status: "price_confirmed",
        payment_method: "未選擇",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("paid", false)
      .eq("quote_status", "manual_confirming_players")
      .select()
      .maybeSingle();
    if (error || !quotedOrder) {
      return interaction.editReply({ content: "❌ 確認陪陪失敗，請稍後再試。" });
    }
    const selectionTimer = selfServiceDispatchTimers.get(String(order.id));
    if (selectionTimer) clearTimeout(selectionTimer);
    selfServiceDispatchTimers.delete(String(order.id));
    await interaction.message.edit({ components: [] }).catch(() => null);
    await publishClaimSuccess(quotedOrder, selectedIds);
    pendingSelfServiceOrders.delete(`selection:${order.id}`);
    pendingSelfServiceOrders.delete(`candidatePrompt:${order.id}`);
    await interaction.channel.send({
      content: `<@${order.customer_id}> 已確認接單陪陪，現在請選擇是否使用優惠券，接著完成付款。`,
      embeds: [
        new EmbedBuilder()
          .setColor(QIUNAI_WATER_BLUE)
          .setTitle("✅ 接單成功｜進入付款流程")
          .setDescription(
            `訂單：${order.order_no || order.id}\n` +
            `陪陪：${selectedIds.map((id) => `<@${id}>`).join("、")}\n` +
            `應付：NT$${Number(order.final_price || order.price || 0).toLocaleString("zh-TW")}\n\n` +
            `請先選擇是否使用優惠券。`,
          )
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`quote_use_coupon_${order.id}`)
            .setLabel("使用優惠券")
            .setEmoji("🎟️")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`quote_no_coupon_${order.id}`)
            .setLabel("不使用優惠券")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return interaction.editReply({ content: "✅ 已確認陪陪，現在進入付款流程。" });
  }
  if (order.paid) {
    const { data: acceptedOrder, error } = await supabase
      .from("play_orders")
      .update({
        assigned_player: selectedIds.join(","),
        preferred_player: selectedIds.join(","),
        status: "accepted",
        quote_status: "dispatched",
        accepted_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("paid", true)
      .eq("quote_status", "confirming_players")
      .select()
      .single();
    if (error || !acceptedOrder) {
      return interaction.editReply({ content: "❌ 確認陪陪失敗，請稍後再試。" });
    }
    const selectionTimer = selfServiceDispatchTimers.get(String(order.id));
    if (selectionTimer) clearTimeout(selectionTimer);
    selfServiceDispatchTimers.delete(String(order.id));
    for (const playerId of selectedIds) {
      await interaction.channel.permissionOverwrites.edit(playerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    }
    await workReportSystem.sendForAcceptedOrder(acceptedOrder, selectedIds);
    await sendStaffOrderControlPanel(interaction.channel, acceptedOrder);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await publishClaimSuccess(acceptedOrder, selectedIds);
    await interaction.channel.send({
      content: `<@${order.customer_id}> ${selectedIds.map((id) => `<@${id}>`).join(" ")}`,
      embeds: [
        new EmbedBuilder()
          .setColor(QIUNAI_WATER_BLUE)
          .setTitle("✅ 已確認陪陪，報單已發送")
          .setDescription(
            `訂單：${order.order_no}\n款項先前已完成核帳，不會重複扣款。\n陪陪：${selectedIds.map((id) => `<@${id}>`).join("、")}\n\n系統已將陪陪加入本頻道，並發送時間填寫報單。`,
          )
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`self_service_extend_${order.id}`)
            .setLabel("我要加時")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    pendingSelfServiceOrders.delete(`selection:${order.id}`);
    return interaction.editReply({ content: "✅ 已確認陪陪並發送報單，不會重複扣款。" });
  }
  const { data: waitingPaymentOrder, error: waitingPaymentError } = await supabase.from("play_orders")
    .update({ preferred_player: selectedIds.join(","), quote_status: "waiting_payment", payment_method: null })
    .eq("id", order.id)
    .eq("paid", false)
    .eq("quote_status", "confirming_players")
    .select()
    .maybeSingle();
  if (waitingPaymentError || !waitingPaymentOrder) {
    return interaction.editReply({ content: "❌ 確認陪陪失敗，請稍後再試。" });
  }
  const selectionTimer = selfServiceDispatchTimers.get(String(order.id));
  if (selectionTimer) clearTimeout(selectionTimer);
  selfServiceDispatchTimers.delete(String(order.id));
  await interaction.message.edit({ components: [] }).catch(() => null);
  await publishClaimSuccess(waitingPaymentOrder, selectedIds);
  await sendSelfServicePaymentSelection(interaction.channel, waitingPaymentOrder);
  return interaction.editReply({ content: "✅ 已確認陪陪，請先完成付款。" });
}

const SELF_SERVICE_PAYMENT_CHOICES = Object.freeze({
  jkopay: "街口支付",
  card: "線上刷卡",
  atm: "匯款帳號",
  barcode: "超商條碼",
  cvs: "超商代碼",
  wallet: "錢包扣款",
});

async function sendSelfServicePaymentSelection(channel, order) {
  const amount = Number(order.final_price ?? order.price ?? 0);
  const selectedIds = String(order.preferred_player || "").split(",").filter(Boolean);
  const enabled = (method) => {
    if (method === "jkopay") return Boolean(paymentHelpers.jkopayAvailable);
    if (method === "wallet") return true;
    if (!paymentHelpers.ecpayAvailable) return false;
    if (method === "atm") return amount >= 16 && amount <= 49_999;
    if (method === "cvs") return amount >= 34 && amount <= 20_000;
    if (method === "barcode") return amount >= 18 && amount <= 20_000;
    return amount >= 6 && amount <= 199_999;
  };
  const methods = ["jkopay", "card", "atm", "barcode", "cvs", "wallet"];
  const rows = [];
  for (let i = 0; i < methods.length; i += 3) {
    rows.push(new ActionRowBuilder().addComponents(methods.slice(i, i + 3).map((method) =>
      new ButtonBuilder()
        .setCustomId(`self_service_prepare_${method}_${order.id}`)
        .setLabel(SELF_SERVICE_PAYMENT_CHOICES[method])
        .setStyle(method === "wallet" ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(!enabled(method)),
    )));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`self_service_cancel_order_${order.id}`).setLabel("按錯了，取消訂單").setStyle(ButtonStyle.Danger),
  ));
  return channel.send({
    content: `<@${order.customer_id}> 請選擇付款方式：`,
    embeds: [new EmbedBuilder().setColor(QIUNAI_WATER_BLUE).setTitle("💳 付款與自動核帳")
      .setDescription(`應付：NT$${amount.toLocaleString("zh-TW")}\n陪陪：${selectedIds.map((id) => `<@${id}>`).join("、")}\n\n線上付款完成後自動核帳；ATM 與超商取號不等於付款，實際繳費後才會自動核帳。`)],
    components: rows,
  });
}

async function prepareSelfServicePayment(interaction) {
  await deferReplyOnce(interaction);
  const match = /^self_service_prepare_(jkopay|card|atm|barcode|cvs|wallet)_(.+)$/.exec(interaction.customId);
  if (!match) return interaction.editReply({ content: "❌ 付款方式無效。" });
  const [, method, orderId] = match;
  const { data: order } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (!order || !isSelfServiceOrder(order) || order.customer_id !== interaction.user.id)
    return interaction.editReply({ content: "❌ 找不到你的自助訂單。" });
  if (order.paid || order.quote_status !== "waiting_payment")
    return interaction.editReply({ content: "⚠️ 此訂單已進入付款流程或已付款，請使用原付款訊息。" });
  const gatewayMethod = method === "jkopay" ? "jkopay" : method === "wallet" ? "wallet" : `ecpay_${method}`;
  return interaction.editReply({
    content: `請確認使用「${SELF_SERVICE_PAYMENT_CHOICES[method]}」付款；選錯可按「返回付款方式」，不會扣款或建立付款單。`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`self_service_pay_${gatewayMethod}_${orderId}`).setLabel("確認此付款方式").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`self_service_payment_back_${orderId}`).setLabel("返回付款方式").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`self_service_cancel_order_${orderId}`).setLabel("按錯了，取消訂單").setStyle(ButtonStyle.Danger),
    )],
  });
}

async function backToSelfServicePayment(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const orderId = interaction.customId.replace("self_service_payment_back_", "");
  const { data: order } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (!order || order.customer_id !== interaction.user.id || order.paid || order.quote_status !== "waiting_payment")
    return interaction.editReply({ content: "⚠️ 訂單狀態已更新，無法返回。", components: [] });
  await interaction.editReply({ content: "已返回付款方式，請使用原本的六種付款選項。", components: [] });
}

async function cancelSelfServiceBeforePayment(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_service_cancel_order_");
  if (!order || !isSelfServiceOrder(order)) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以取消訂單。" });
  if (order.paid || order.quote_status !== "waiting_payment") {
    return interaction.editReply({ content: "⚠️ 此訂單已進入付款流程或已付款，不能直接取消；請聯繫客服核帳或辦理退款。" });
  }
  if (processingSelfServiceCancellations.has(order.id) || processingSelfServicePayments.has(order.id)) {
    return interaction.editReply({ content: "⚠️ 訂單正在處理，請勿重複點擊。" });
  }
  processingSelfServiceCancellations.add(order.id);
  try {
    // 曾產生金流付款單時，外部帳號或條碼可能仍可繳費，必須交由客服核帳。
    for (const table of ["ecpay_service_payments", "jkopay_service_payments"]) {
      const { data, error } = await supabase.from(table).select("id")
        .eq("organization_code", "qiunai").eq("payment_kind", "order")
        .eq("entity_key", String(order.id)).limit(1);
      if (error) throw error;
      if (data?.length) {
        return interaction.editReply({ content: "⚠️ 此訂單已有付款單，為避免取消後仍被繳費，請聯繫客服核帳或辦理退款。" });
      }
    }
    const { data, error } = await supabase.rpc("qiunai_cancel_self_service_order", {
      p_order_id: String(order.id),
      p_customer_id: String(order.customer_id),
      p_expected_quote_status: ["waiting_payment"],
      p_final_quote_status: "cancelled",
      p_operation_key: `self-service-cancel-before-payment:${order.id}`,
      p_reason: "顧客按錯了，付款前取消訂單",
    });
    if (error || !data) throw new Error(error?.message || "取消訂單失敗");
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send("已取消這張自助訂單，頻道將於十秒後關閉。").catch(() => null);
    await interaction.editReply({ content: "✅ 訂單尚未付款，已取消訂單。" });
    scheduleChannelDeletion(interaction, 10_000);
  } catch (error) {
    console.error("[自助訂單付款前取消] 失敗", error);
    return interaction.editReply({ content: "❌ 暫時無法取消訂單，請勿付款並聯繫客服確認。" });
  } finally {
    processingSelfServiceCancellations.delete(order.id);
  }
}

async function paySelfServiceOrderByGateway(interaction) {
  await deferReplyOnce(interaction);
  const ecpayMatch = /^self_service_pay_ecpay_(card|atm|barcode|cvs)_(.+)$/.exec(interaction.customId);
  const ecpay = Boolean(ecpayMatch) || interaction.customId.startsWith("self_service_pay_ecpay_");
  const selectedMethod = ecpayMatch?.[1] || "card";
  const paymentMethod = ecpay ? "綠界支付" : "街口支付";
  const waitingStatus = ecpay ? "waiting_ecpay" : "waiting_jkopay";
  const createPayment = ecpay ? paymentHelpers.createEcpayServicePayment : paymentHelpers.createJkopayServicePayment;
  const order = ecpayMatch
    ? (await supabase.from("play_orders").select("*").eq("id", ecpayMatch[2]).maybeSingle()).data
    : await getSelfServiceOrder(interaction, ecpay ? "self_service_pay_ecpay_" : "self_service_pay_jkopay_");
  if (!order || !isSelfServiceOrder(order)) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以付款。" });
  if (order.paid) return interaction.editReply({ content: "⚠️ 此訂單已完成付款，不會重複建立付款單。" });
  if (order.quote_status !== "waiting_payment") {
    return interaction.editReply({ content: "⚠️ 這張訂單已進入付款流程，請使用原本的付款訊息。" });
  }
  if (!(ecpay ? paymentHelpers.ecpayAvailable : paymentHelpers.jkopayAvailable)) {
    return interaction.editReply({ content: `❌ ${paymentMethod}目前無法使用，請稍後再試。` });
  }
  if (!createPayment) {
    return interaction.editReply({ content: `❌ ${paymentMethod}尚未完成設定。` });
  }
  if (processingSelfServicePayments.has(order.id)) {
    return interaction.editReply({ content: "⚠️ 系統正在建立付款單，請勿重複點擊。" });
  }
  const selectedIds = String(order.preferred_player || "").split(",").filter(Boolean);
  if (!selectedIds.length) return interaction.editReply({ content: "❌ 尚未確認陪陪。" });

  processingSelfServicePayments.add(order.id);
  try {
    const { data: lockedOrder, error: lockError } = await supabase
      .from("play_orders")
      .update({ payment_method: paymentMethod, quote_status: waitingStatus, updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("paid", false)
      .eq("quote_status", "waiting_payment")
      .select("id")
      .maybeSingle();
    if (lockError || !lockedOrder) {
      return interaction.editReply({ content: "⚠️ 付款狀態已更新，請使用原本的付款訊息。" });
    }

    let paymentCreated = false;
    try {
      const amount = Number(order.final_price ?? order.price ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("訂單金額不正確");
      const directLimits = { atm: [16, 49_999], cvs: [34, 20_000], barcode: [18, 20_000] };
      if (directLimits[selectedMethod] && (amount < directLimits[selectedMethod][0] || amount > directLimits[selectedMethod][1]))
        throw new Error("此金額不適用所選的綠界付款方式");
      const payment = await createPayment({
        kind: "order",
        entityKey: String(order.id),
        userId: order.customer_id,
        amount,
        ...(ecpay ? { requestedMethod: { card: "CARD", atm: "ATM", cvs: "CVS", barcode: "BARCODE" }[selectedMethod] } : {}),
        channelId: interaction.channel.id,
        description: `自助陪玩訂單 ${order.order_no || order.id}`,
        metadata: {
          flow: "self_service",
          orderIds: [order.id],
          orderNo: order.order_no || null,
          selectedPlayerIds: selectedIds,
        },
      });
      paymentCreated = true;
      if (ecpay) {
        payment.onlyMethod = { card: "CARD", atm: "ATM", cvs: "CVS", barcode: "BARCODE" }[selectedMethod];
        if (selectedMethod !== "card") payment.preferredMethod = payment.onlyMethod;
      }
      await (ecpay ? sendEcpayPaymentPrompt : sendJkopayPaymentPrompt)(interaction.channel, order.customer_id, amount, payment, "自助訂單");
      await interaction.message.edit({ components: [] }).catch(() => null);
      return interaction.editReply({ content: `✅ 已建立${ecpay ? SELF_SERVICE_PAYMENT_CHOICES[selectedMethod] : paymentMethod}付款資訊，實際付款完成後會自動核帳、加入陪陪並發送報單。`, components: [] });
    } catch (error) {
      if (!paymentCreated) {
        const paymentTable = ecpay ? "ecpay_service_payments" : "jkopay_service_payments";
        const { data: existingPayment, error: lookupError } = await supabase.from(paymentTable)
          .select("id").eq("organization_code", "qiunai")
          .eq("payment_kind", "order").eq("entity_key", String(order.id)).maybeSingle();
        if (lookupError) console.error("[自助付款] 查詢已建立付款單失敗，保留付款鎖定", lookupError);
        if (!existingPayment && !lookupError) {
          await supabase
            .from("play_orders")
            .update({ payment_method: null, quote_status: "waiting_payment", updated_at: new Date().toISOString() })
            .eq("id", order.id)
            .eq("paid", false)
            .eq("quote_status", waitingStatus);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error(`[自助下單${paymentMethod}] 失敗`, error);
    return interaction.editReply({ content: `❌ 建立${paymentMethod}付款失敗：${error.message || error}` });
  } finally {
    processingSelfServicePayments.delete(order.id);
  }
}

async function paySelfServiceOrder(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_service_pay_wallet_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以付款。" });
  if (order.paid) return interaction.editReply({ content: "⚠️ 此訂單已完成付款，不會重複扣款。" });
  if (order.quote_status !== "waiting_payment") return interaction.editReply({ content: "⚠️ 此訂單已進入其他付款流程，請使用最新付款訊息。" });
  if (processingSelfServicePayments.has(order.id)) return interaction.editReply({ content: "⚠️ 系統正在核帳，請勿重複點擊。" });
  const selectedIds = String(order.preferred_player || "").split(",").filter(Boolean);
  if (!selectedIds.length) return interaction.editReply({ content: "❌ 尚未確認陪陪。" });
  processingSelfServicePayments.add(order.id);
  try {
    const result = await paymentHelpers.payOrderByWallet(order);
    const { data: paidOrder, error } = await supabase
      .from("play_orders")
      .update({ assigned_player: selectedIds.join(","), preferred_player: selectedIds.join(","), payment_method: "儲值卡", status: "accepted", quote_status: "dispatched", accepted_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("paid", true)
      .select()
      .single();
    if (error || !paidOrder) throw new Error(error?.message || "付款成功但更新派單狀態失敗");
    for (const playerId of selectedIds) {
      await interaction.channel.permissionOverwrites.edit(playerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    }
    await workReportSystem.sendForAcceptedOrder(paidOrder, selectedIds);
    await sendStaffOrderControlPanel(interaction.channel, paidOrder);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      content: `<@${order.customer_id}> ${selectedIds.map((id) => `<@${id}>`).join(" ")}`,
      embeds: [new EmbedBuilder().setColor(QIUNAI_WATER_BLUE).setTitle("✅ 付款明細核對完成，報單已發送").setDescription(`訂單：${order.order_no}\n扣款：${Number(result.amount).toLocaleString("zh-TW")} ASD\n剩餘：${Number(result.finalCoins).toLocaleString("zh-TW")} ASD\n陪陪：${selectedIds.map((id) => `<@${id}>`).join("、")}\n\n系統已將陪陪加入本頻道，並發送時間填寫報單。`).setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`self_service_extend_${order.id}`).setLabel("我要加時").setStyle(ButtonStyle.Primary),
      )],
    });
    pendingSelfServiceOrders.delete(`selection:${order.id}`);
    return interaction.editReply({ content: "✅ ASD 扣款與訂單核帳完成，已發送報單。" });
  } catch (error) {
    console.error("[自助下單付款] 失敗", error);
    return interaction.editReply({ content: `❌ 付款或派單失敗：${error.message || error}` });
  } finally {
    processingSelfServicePayments.delete(order.id);
  }
}

async function reselectSelfServicePlayers(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_players_reselect_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以重新派單。" });
  if (Date.now() >= getSelfServiceSelectionDeadline(order)) {
    await failSelfServiceDispatch(order.id);
    return interaction.editReply({ content: "❌ 派單時間已結束，這張訂單已自動棄單。" });
  }
  const dispatchNote = stripSelfServiceClaimNotes(order.note);
  const { data: redispatchOrder, error } = await supabase
    .from("play_orders")
    .update({ preferred_player: null, status: "pending", quote_status: getClaimDispatchingStatus(order), note: dispatchNote, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("paid", false)
    .eq("quote_status", isManualDispatchOrder(order) ? "manual_confirming_players" : "confirming_players")
    .select()
    .single();
  if (error || !redispatchOrder) return interaction.editReply({ content: "❌ 重新派單失敗。" });
  pendingSelfServiceOrders.delete(`selection:${order.id}`);
  await interaction.message.edit({ components: [] }).catch(() => null);
  const oldClaimMessage = await findSelfServiceClaimMessage(order.id, order);
  await oldClaimMessage?.edit({ components: [] }).catch(() => null);
  const oldThread = oldClaimMessage?.channel?.isThread?.() ? oldClaimMessage.channel : null;
  if (oldThread) {
    await oldThread.send({
      content: `訂單 ${order.order_no || order.id} 已重新派單，本討論串不再受理接單。`,
      files: [{ attachment: SELF_SERVICE_FAILED_IMAGE, name: "dispatch-failed.png" }],
      allowedMentions: { parse: [] },
    }).catch(() => null);
    await oldThread.setName(getDispatchResultThreadName(order, false), "老闆重新派單").catch(() => null);
    await oldThread.setArchived(true, "老闆重新派單").catch(() => null);
  }
  pendingSelfServiceOrders.delete(`claimMessage:${order.id}`);
  await sendSelfServiceDispatch(redispatchOrder);
  return interaction.editReply({ content: "✅ 已要求重新派單。" });
}

async function openSelfServiceExtensionModal(interaction) {
  const order = await getSelfServiceOrder(interaction, "self_service_extend_");
  if (!order) return interaction.reply({ content: "❌ 找不到這張自助訂單。", flags: 64 });
  if (interaction.user.id !== order.customer_id) return interaction.reply({ content: "❌ 只有下單者可以加時。", flags: 64 });
  if (!order.paid || !["accepted", "pending"].includes(order.status)) {
    return interaction.reply({ content: "❌ 訂單完成付款並安排陪陪後才能加時。", flags: 64 });
  }
  const modal = new ModalBuilder()
    .setCustomId(`self_service_extension_submit_${order.id}`)
    .setTitle("自助加時 / 續單")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("quantity")
        .setLabel("要增加的時數 / 局數")
        .setPlaceholder("例如：0.5、1、2")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ));
  return interaction.showModal(modal);
}

async function submitSelfServiceExtension(interaction) {
  await deferReplyOnce(interaction);
  const order = await getSelfServiceOrder(interaction, "self_service_extension_submit_");
  if (!order) return interaction.editReply({ content: "❌ 找不到這張自助訂單。" });
  if (interaction.user.id !== order.customer_id) return interaction.editReply({ content: "❌ 只有下單者可以加時。" });
  const quantity = Number(String(interaction.fields.getTextInputValue("quantity") || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(quantity) || quantity <= 0) return interaction.editReply({ content: "❌ 請輸入大於 0 的數字。" });
  const unitMatch = String(order.note || "").match(/單價：(\d+(?:\.\d+)?)\/(小時|局)/);
  if (!unitMatch) return interaction.editReply({ content: "❌ 找不到原始自動報價單位，請聯繫客服處理。" });
  const unitPrice = Number(unitMatch[1]);
  const unit = unitMatch[2];
  const amount = unitPrice * quantity * Number(order.player_count || 1);
  if (!Number.isInteger(amount)) return interaction.editReply({ content: "❌ 加時金額不是整數，請改用可整除的數量。" });
  const staffId = String(order.assigned_player || "").split(",").filter(Boolean)[0] || null;
  const { data: extension, error } = await supabase.from("order_extensions").insert({
    order_id: order.id,
    order_no: order.order_no || null,
    customer_id: order.customer_id,
    channel_id: order.channel_id || interaction.channel.id,
    staff_id: staffId,
    extension_text: `${quantity} ${unit}`,
    amount,
    payment_method: "儲值卡",
    paid: false,
    status: "waiting_wallet_confirm",
    applied_to_salary: false,
    note: "自助下單自動計價加時",
  }).select().single();
  if (error || !extension) return interaction.editReply({ content: `❌ 建立加時失敗：${error?.message || "未知錯誤"}` });
  await interaction.channel.send({
    content: `<@${order.customer_id}>`,
    embeds: [new EmbedBuilder().setColor(QIUNAI_WATER_BLUE).setTitle("➕ 自助加時報價").setDescription(`增加：${quantity} ${unit}\n陪陪：${order.player_count} 位\n單價：NT$${unitPrice.toLocaleString("zh-TW")} / ${unit} / 位\n應付：**${amount.toLocaleString("zh-TW")} ASD**`).setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm_extension_wallet_${extension.id}`).setLabel("確認 ASD 付款").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cancel_extension_wallet_${extension.id}`).setLabel("取消").setStyle(ButtonStyle.Danger),
    )],
  });
  return interaction.editReply({ content: "✅ 已建立自助加時，請確認 ASD 付款。" });
}

async function sendTipOrderPanel() {
  const channel = await client.channels
    .fetch(TIP_ORDER_PANEL_CHANNEL_ID)
    .catch(() => null);

  if (!channel) {
    throw new Error(`找不到打賞下單頻道：${TIP_ORDER_PANEL_CHANNEL_ID}`);
  }

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("💝 打賞下單區")
    .setDescription(
      `想支持喜歡的陪陪嗎？請點擊下方按鈕建立專屬打賞頻道。\n\n` +
        `可建立一般打賞單或冠名單，完成後選擇陪陪及付款方式。\n\n` +
        `打賞與冠名商品介紹請查看：\n` +
        `<#1513312500832010400>\n` +
        `<#1528136121878446281>`,
    )
    .setFooter({ text: "秋奈電競｜打賞系統" })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("order_start_tip")
      .setLabel("建立打賞單")
      .setEmoji("💝")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("order_start_crown")
      .setLabel("建立冠名單")
      .setEmoji("👑")
      .setStyle(ButtonStyle.Primary),
  );
  const messages = await channel.messages.fetch({ limit: 20 });
  const oldPanel = messages.find(
    (message) =>
      message.author.id === client.user.id &&
      message.embeds[0]?.title === "💝 打賞下單區",
  );

  if (oldPanel) {
    await oldPanel.edit({ embeds: [embed], components: [row] });
    console.log("[TIP PANEL] 已更新");
    return oldPanel;
  }

  const message = await channel.send({ embeds: [embed], components: [row] });
  console.log("[TIP PANEL] 已建立");
  return message;
}

async function handleGameOrderSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const gameKey = interaction.customId.replace("game_order_select_", "");

  const value = interaction.values[0];

  await resetSelectMenuMessage(interaction);

  if (value === "topup") {
    return await createTopupTicket(interaction);
  }

  if (value === "tip") {
    return await createTipTicket(interaction);
  }

  if (gameKey === "lol") {
    const flowId = createFlowId(interaction.user.id);

    await pendingPanelOrders.set(flowId, {
      userId: interaction.user.id,
      gameKey,
      lolMode: value,
    });

    const modeLabel = findOptionLabel("lol", value);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`lol_style_select_${flowId}`)
      .setPlaceholder("請選擇陪玩類型")
      .addOptions([
        {
          label: "大神陪玩",
          value: "god",
          description: `${modeLabel}｜大神陪玩`,
        },
        {
          label: "技術陪玩",
          value: "skill",
          description: `${modeLabel}｜技術陪玩`,
        },
        {
          label: "娛樂陪玩",
          value: "entertain",
          description: `${modeLabel}｜娛樂陪玩`,
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return await interaction.editReply({
      content:
        `你選擇的是：${modeLabel}\n\n` +
        `請再選擇大神陪玩 / 技術陪玩 / 娛樂陪玩：`,
      components: [row],
    });
  }

  if (gameKey === "other" && ["arena_of_valor", "honor_of_kings", "identity_v"].includes(value)) {
    const flowId = createFlowId(interaction.user.id);
    const gameLabel = findOptionLabel("other", value);

    await pendingPanelOrders.set(flowId, {
      userId: interaction.user.id,
      gameKey,
      otherGame: value,
      gameLabel,
    });

    const options =
      value === "arena_of_valor"
        ? [
            { label: "娛樂", value: "entertain", description: "傳說對決｜娛樂" },
            { label: "技術", value: "skill", description: "傳說對決｜技術" },
            { label: "大神", value: "god", description: "傳說對決｜大神" },
          ]
        : value === "honor_of_kings"
        ? [
            {
              label: "娛樂",
              value: "entertain",
              description: "王者榮耀｜娛樂",
            },
            { label: "技術", value: "skill", description: "王者榮耀｜技術" },
          ]
        : [
            {
              label: "娛樂",
              value: "entertain",
              description: "第五人格｜娛樂",
            },
            { label: "四階", value: "rank_4", description: "第五人格｜四階" },
            { label: "五階", value: "rank_5", description: "第五人格｜五階" },
            { label: "六階", value: "rank_6", description: "第五人格｜六階" },
            { label: "七階", value: "rank_7", description: "第五人格｜七階" },
          ];

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`other_game_style_select_${flowId}`)
      .setPlaceholder(`請選擇${gameLabel}項目`)
      .addOptions(options);

    return interaction.editReply({
      content: `你選擇的是：${gameLabel}\n\n請選擇服務項目：`,
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }

  const initial = buildPanelInitialData(gameKey, value);

  return await createServiceTicket(interaction, initial.category, initial);
}

async function handleOtherGameStyleSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const flowId = interaction.customId.replace("other_game_style_select_", "");
  const pending = await pendingPanelOrders.get(flowId);
  await resetSelectMenuMessage(interaction);

  if (!pending || pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 這個選單已過期，請回其他項目下單區重新選擇。",
      components: [],
    });
  }

  const value = interaction.values[0];
  const labels = {
    entertain: "娛樂",
    skill: "技術",
    god: "大神",
    rank_4: "四階",
    rank_5: "五階",
    rank_6: "六階",
    rank_7: "七階",
  };
  const itemLabel = labels[value] || value;
  await pendingPanelOrders.delete(flowId);

  return createServiceTicket(interaction, "other", {
    category: "other",
    gameLabel: pending.gameLabel,
    itemLabel,
    serviceType: `${pending.gameLabel}｜${itemLabel}`,
    playMode: itemLabel,
    fromPanel: true,
  });
}

async function handleLolStyleSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(async () => {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({
          flags: 64,
        });
      }
    });
  }

  const flowId = interaction.customId.replace("lol_style_select_", "");

  await resetSelectMenuMessage(interaction);

  const pending = await pendingPanelOrders.get(flowId);

  if (!pending) {
    return await interaction.editReply({
      content: "❌ 這個選單已過期，請回英雄聯盟下單區重新選擇。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return await interaction.editReply({
      content: "❌ 只有剛剛選擇英雄聯盟項目的人可以操作。",
      components: [],
    });
  }

  const modeLabel = findOptionLabel("lol", pending.lolMode);

  const styleMap = {
    god: "大神陪玩",
    skill: "技術陪玩",
    entertain: "娛樂陪玩",
  };

  const styleLabel = styleMap[interaction.values[0]] || interaction.values[0];

  await pendingPanelOrders.delete(flowId);

  return await createServiceTicket(interaction, "lol", {
    category: "lol",
    gameLabel: "英雄聯盟",
    itemLabel: modeLabel,
    serviceType: `${modeLabel}｜${styleLabel}`,
    playMode: styleLabel,
    fromPanel: true,
  });
}

async function sendQuickServiceNeedPanel(channel, flowId, initial = {}) {
  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions([
      { label: "30 分鐘", value: "0.5" },
      { label: "1 小時", value: "1" },
      { label: "1.5 小時", value: "1.5" },
      { label: "2 小時", value: "2" },
      { label: "自訂", value: "custom" },
    ]);

  const roundsMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數")
    .addOptions([
      { label: "1 局", value: "1" },
      { label: "3 局", value: "3" },
      { label: "5 局", value: "5" },
      { label: "自訂", value: "custom" },
    ]);

  const valorantRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_rank_${flowId}`)
    .setPlaceholder("請選擇目前段位")
    .addOptions([
      { label: "鐵牌", value: "鐵牌" },
      { label: "銅牌", value: "銅牌" },
      { label: "銀牌", value: "銀牌" },
      { label: "金牌", value: "金牌" },
      { label: "白金", value: "白金" },
      { label: "鑽石", value: "鑽石" },
      { label: "超凡", value: "超凡" },
      { label: "神話", value: "神話" },
      { label: "輻能", value: "輻能" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const apexRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`apex_rank_${flowId}`)
    .setPlaceholder("請選擇 Apex 目前段位")
    .addOptions([
      { label: "菜鳥", value: "菜鳥" },
      { label: "青銅", value: "青銅" },
      { label: "白銀", value: "白銀" },
      { label: "黃金", value: "黃金" },
      { label: "白金", value: "白金" },
      { label: "鑽石", value: "鑽石" },
      { label: "大師", value: "大師" },
      { label: "頂尖獵殺者", value: "頂尖獵殺者" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const lolRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`lol_rank_${flowId}`)
    .setPlaceholder("請選擇英雄聯盟段位 / 娛樂")
    .addOptions([
      { label: "娛樂", value: "娛樂", description: "不看段位，娛樂陪玩" },
      { label: "黑鐵", value: "黑鐵" },
      { label: "銅牌", value: "銅牌" },
      { label: "銀牌", value: "銀牌" },
      { label: "金牌", value: "金牌" },
      { label: "白金", value: "白金" },
      { label: "翡翠", value: "翡翠" },
      { label: "鑽石", value: "鑽石" },
      { label: "大師", value: "大師" },
      { label: "宗師", value: "宗師" },
      { label: "菁英", value: "菁英" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const deltaModeMenu = new StringSelectMenuBuilder()
    .setCustomId(`delta_mode_${flowId}`)
    .setPlaceholder("請選擇三角洲服務內容")
    .addOptions([
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "一般娛樂陪玩",
      },
      {
        label: "基本單護",
        value: "基本單護",
        description: "基本單人護航",
      },
      {
        label: "機密雙護",
        value: "機密雙護",
        description: "機密雙人護航",
      },
      {
        label: "機密雙護（有保底）",
        value: "機密雙護（有保底）",
        description: "機密雙護含保底",
      },
      {
        label: "猛攻護航",
        value: "猛攻護航",
        description: "猛攻模式護航",
      },
      {
        label: "猛攻護航（有保底）",
        value: "猛攻護航（有保底）",
        description: "猛攻護航含保底",
      },
    ]);

  const isDeltaOrder = initial.category === "delta";
  const isLolRoundOrder =
    initial.category === "lol" && initial.itemLabel !== "ARAM";
  const isApexOrder = initial.category === "apex";
  const isLolOrder = initial.category === "lol";
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註 / 自訂需求")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`order_finish_need_${flowId}`)
      .setLabel("送出訂單")
      .setEmoji("📨")
      .setStyle(ButtonStyle.Success)
  );

  if (initial.category === "steam") {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`steam_game_name_${flowId}`)
        .setLabel("輸入 Steam 遊戲名稱")
        .setStyle(ButtonStyle.Primary)
    );
  }

  const needRows = [
    ...(initial.category === "valorant"
      ? [new ActionRowBuilder().addComponents(valorantRankMenu)]
      : []),

    ...(isApexOrder
      ? [new ActionRowBuilder().addComponents(apexRankMenu)]
      : []),

    ...(isLolOrder ? [new ActionRowBuilder().addComponents(lolRankMenu)] : []),

    ...(isDeltaOrder
      ? [new ActionRowBuilder().addComponents(deltaModeMenu)]
      : []),

    new ActionRowBuilder().addComponents(countMenu),
    new ActionRowBuilder().addComponents(genderMenu),
    ...(initial.category === "valorant"
      ? []
      : isLolRoundOrder
      ? [new ActionRowBuilder().addComponents(roundsMenu)]
      : [new ActionRowBuilder().addComponents(durationMenu)]),
  ];

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("📋 下單需求填寫")
        .setDescription(
          `已選擇：${
            initial.serviceType || initial.itemLabel || "未填寫"
          }\n\n` +
            `請依序選擇${isDeltaOrder ? "服務內容、" : ""}${
              isApexOrder ? "段位、" : ""
            }${isLolOrder ? "段位 / 娛樂、" : ""}人數、性別偏好與${
              isLolRoundOrder ? "局數" : "時間"
            }。\n` +
            `有特殊需求可以按「填寫備註 / 自訂需求」。\n\n` +
            `填寫完成後請按「送出訂單」，系統會先依現行價目表自動報價；無法計算時才會轉交客服。`
        )
        .setTimestamp(),
    ],
    components: needRows.slice(0, 5),
  });

  await channel.send({
    components: [buttonRow],
  });
}
function setup(supabaseInstance, clientInstance, helpers = {}) {
  supabase = supabaseInstance;
  pendingServiceOrders = createServiceFlowStore(supabase);
  pendingNewOrders = createServiceFlowStore(supabase, { organization: "qiunai_general_orders" });
  pendingPanelOrders = createServiceFlowStore(supabase, { organization: "qiunai_order_panels" });
  client = clientInstance;
  paymentHelpers = helpers;
  workReportSystem = createWorkReportSystem({
    supabase,
    client,
    appKey: "qiunai",
    guildId: process.env.GUILD_ID || "1206138511535898654",
    staffGuildId:
      process.env.STAFF_GUILD_ID || "1513174069087047731",
    manualChannelId: "1525872402003923075",
    staffTable: "qiunai_staff",
    staffRoleId:
      process.env.STAFF_ROLE ||
      process.env.STAFF_ROLE_ID ||
      "1210642900355125288",
    customerServiceRoleId:
      [
        process.env.CUSTOMER_SERVICE_ROLE_ID,
        process.env.CUSTOMER_SERVICE_ROLE_IDS,
        "1210642900355125288",
        "1513203868895412305",
        "1502010574781943989",
      ]
        .filter(Boolean)
        .join(","),
    salaryTable: "qiunai_salary_orders",
    finalizeBotWorkReport: paymentHelpers.buildQiunaiWorkReportSalaryPayload,
  });
  paidOrderDispatcher = createPaidOrderDispatcher({
    supabase,
    guildId: process.env.GUILD_ID || "1206138511535898654",
    sendStaffOrder: sendOrderToStaffChannel,
    sendControlPanel: sendStaffOrderControlPanel,
    findStaffOrder: findExistingStaffOrderMessage,
    findControlPanel: findExistingStaffControlMessage,
  });
}
function getStaffGuildId() {
  return process.env.STAFF_GUILD_ID || process.env.GUILD_ID;
}
function applyStaffGuildFilter(query) {
  return query;
}

function getStaffDisplayName(staff) {
  return String(
    staff?.display_name ||
      staff?.real_name ||
      staff?.discord_name ||
      staff?.name ||
      staff?.discord_id ||
      "未知員工"
  );
}
function getBillingMonth(date = new Date()) {
  const taiwanDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return taiwanDate.toISOString().slice(0, 7);
}
function isCardPayment(text = "") {
  return (
    text === JKOPAY_METHOD ||
    text.includes("街口掃碼") ||
    text.includes("刷卡") ||
    text.includes("信用卡") ||
    text.includes("信用卡付款") ||
    text.includes("card")
  );
}
function isNoCardPayment(text = "") {
  return text.includes("無卡") || text.includes("無卡存款");
}
function isBankTransfer(text = "") {
  return text.includes("匯款") || text.includes("轉帳");
}

async function sendJkopayPaymentPrompt(channel, userId, amount, payment, label) {
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle(`📱 ${label}街口支付`)
    .setDescription(
      `應付金額：NT$${Number(amount).toLocaleString("zh-TW")}\n` +
        `街口訂單編號：${payment.platformOrderId}\n\n` +
        "可按下方按鈕開啟街口正式付款頁，或直接掃描本訊息顯示的該筆交易 QR Code。兩種方式都會由串接系統自動核帳，請勿重複付款。",
    )
    .setTimestamp();
  if (payment.qrImg) embed.setImage(payment.qrImg);
  const message = await channel.send({
    content: `<@${userId}>`,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("使用街口支付")
          .setEmoji("📱")
          .setStyle(ButtonStyle.Link)
          .setURL(payment.paymentUrl),
      ),
    ],
  });
  await paymentHelpers.attachJkopayPaymentMessage?.(payment.platformOrderId, message.id);
  return message;
}
async function sendEcpayPaymentPrompt(channel, userId, amount, payment, label) {
  const autoIssueMethod = ["ATM", "CVS", "BARCODE"].includes(payment.preferredMethod)
    ? payment.preferredMethod : null;
  const methodDescription = payment.onlyMethod === "CARD"
    ? "請按下方按鈕，在官網站內輸入卡號；綠界確認刷卡成功後會自動核帳。"
    : payment.onlyMethod === "ATM"
      ? "系統會在本頻道顯示綠界虛擬 ATM 帳號；實際轉帳完成後才會自動核帳。"
      : ["CVS", "BARCODE"].includes(payment.onlyMethod)
        ? "系統會在本頻道顯示超商繳費資訊；實際繳費完成後才會自動核帳。"
        : `刷卡會在官網站內直接輸入卡號；${isEcpayAtmAvailable() ? "匯款虛擬帳號與" : "虛擬 ATM 於 9 月 28 日開放，"}超商繳費資訊會直接顯示在本頻道。實際付款成功後才會自動核帳。`;
  const paymentRows = buildEcpayPaymentRows(payment, Number(amount), {
    topup: label.includes("儲值"),
    onlyMethod: payment.onlyMethod || null,
    selfService: label === "自助訂單",
  });
  const message = await channel.send({
    content: `<@${userId}>`,
    embeds: [new EmbedBuilder().setColor(QIUNAI_WATER_BLUE).setTitle(`💳 ${label}綠界支付`).setDescription(
      `應付金額：NT$${Number(amount).toLocaleString("zh-TW")}\n` +
      `綠界訂單編號：${payment.platformOrderId}\n\n` +
      methodDescription,
    ).setTimestamp()],
    components: autoIssueMethod ? [] : paymentRows,
  });
  await paymentHelpers.attachEcpayPaymentMessage?.(payment.platformOrderId, message.id);
  if (autoIssueMethod) {
    const issued = await sendPreferredEcpayDirect(channel, userId, payment.platformOrderId, supabase, process.env.ECPAY_PUBLIC_BASE_URL, autoIssueMethod);
    if (!issued) {
      await message.edit({ components: paymentRows }).catch(() => null);
      throw new Error("綠界取號資訊未成功送出，請查看頻道中的錯誤訊息；尚未取得可付款的帳號或代碼");
    }
  }
  return message;
}

async function sendBankTransferInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("🏦 匯款資訊")
    .setDescription(
      `請依照以下資訊完成匯款：\n\n` +
        `銀行：824連線銀行\n` +
        `分行：6880總行（非必填）\n` +
        `帳號：312000002665\n` +
        `戶名：深夜不關燈工作室\n` +
        `備註：（麻煩空白即可）\n\n` +
        `也可以掃描下方 QR Code 付款。\n\n` +
        `匯款完成後，請在此頻道上傳匯款截圖，等待客服確認。\n\n` +
        `若有其他銀行之需求，請在下方告訴客服。`
    )
    .setImage("attachment://bank-transfer-line-bank.png")
    .setFooter({
      text: "請確認金額正確後再匯款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    files: [
      {
        attachment: BANK_TRANSFER_QR_CODE_PATH,
        name: "bank-transfer-line-bank.png",
      },
    ],
  });
}
async function sendNoCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("🏧 無卡付款資訊")
    .setDescription(
      `請依照以下資訊完成無卡付款：\n\n` +
        `銀行：中國信託\n` +
        `銀行代碼：822\n` +
        `帳號：901565426642\n` +
        `戶名：許O星\n\n` +
        `或是\n\n` +
        `銀行：國泰世華\n` +
        `銀行代碼：013\n` +
        `帳號：134500100962\n` +
        `戶名：許O星\n\n` +
        `付款完成後，請在此頻道上傳存款明細，等待客服確認。`
    )
    .setFooter({
      text: "請確認金額正確後再付款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed],
  });
}
async function sendCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("📱 街口支付｜收款 QR Code")
    .setDescription(
      `請使用街口支付掃描下方收款碼完成付款；也可在街口付款頁面選擇信用卡。\n\n` +
        `付款完成後，請在此頻道上傳付款成功截圖，等待客服確認。\n\n` +
        `截圖請包含：\n` +
        `1. 付款成功畫面\n` +
        `2. 付款金額\n` +
        `3. 交易時間或交易編號`
    )
    .setFooter({
      text: "請確認金額正確後再付款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed.setImage("attachment://jkopay-deepnight.png")],
    files: [
      {
        attachment: JKOPAY_QR_CODE_PATH,
        name: "jkopay-deepnight.png",
      },
    ],
  });
}
async function applyExtensionToPlayOrder(extension) {
  const amount = Number(extension.amount || 0);

  if (!amount || amount <= 0) {
    throw new Error("加時金額錯誤");
  }

  const { data: lockedExtension, error: lockError } = await supabase
    .from("order_extensions")
    .update({
      applied_to_salary: true,
      applied_at: new Date().toISOString(),
    })
    .eq("id", extension.id)
    .eq("applied_to_salary", false)
    .select()
    .maybeSingle();

  if (lockError) {
    console.error("[加時進薪資網] 鎖定加時失敗", lockError);
    throw lockError;
  }

  if (!lockedExtension) {
    throw new Error("這筆加時已經寫入過薪資網，已阻止重複加錢");
  }

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", extension.order_id)
    .maybeSingle();

  if (orderError || !order) {
    console.error("[加時進薪資網] 找不到原訂單", orderError);
    throw new Error("找不到原訂單");
  }

  const oldPrice = Number(order.final_price || order.price || 0);

  const newPrice = oldPrice + amount;

  const oldService = order.service || order.order_item || "陪玩訂單";

  const oldNote = order.note || "";

  const extensionText = extension.extension_text || "加時";

  const newNote = `${oldNote}\n[加時] ${extensionText}｜+NT$${amount}`.trim();

  const { data: updatedOrder, error: updateOrderError } = await supabase
    .from("play_orders")
    .update({
      final_price: newPrice,
      price: newPrice,
      service: `${oldService}｜加時：${extensionText}`,
      note: newNote,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .select()
    .single();

  if (updateOrderError || !updatedOrder) {
    console.error("[加時進薪資網] 更新原訂單失敗", updateOrderError);
    await supabase
      .from("order_extensions")
      .update({ applied_to_salary: false, applied_at: null })
      .eq("id", extension.id);
    throw updateOrderError || new Error("更新原訂單失敗");
  }

  // 加時是獨立的一段服務：原訂單更新總價，同時在每位陪陪的填單區
  // 建立一張可報時的新單。createReports 以 extension id 去重，不會重複建立。
  const extensionReports = await workReportSystem.sendForPaidExtension(
    lockedExtension,
    updatedOrder
  );

  return {
    order: updatedOrder,
    oldPrice,
    newPrice,
    amount,
    extensionReportCount: extensionReports.length,
  };
}
function formatAvailableTime(player) {
  const time = player.available_time || {};

  if (!time || Object.keys(time).length === 0) {
    return "未填寫可接時間";
  }

  if (time.mode === "daily") {
    return `每天 ${time.daily || "未填寫"}`;
  }

  if (time.mode === "weekday_holiday") {
    return `平日 ${time.weekday || "未填寫"}｜假日 ${time.holiday || "未填寫"}`;
  }

  if (time.mode === "weekly") {
    const parts = [
      ["一", time.monday],
      ["二", time.tuesday],
      ["三", time.wednesday],
      ["四", time.thursday],
      ["五", time.friday],
      ["六", time.saturday],
      ["日", time.sunday],
    ]
      .filter(([, value]) => value)
      .map(([day, value]) => `週${day} ${value}`);

    return parts.length ? parts.join("｜") : "未填寫可接時間";
  }

  return "未填寫可接時間";
}
function normalizeAllowedServices(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {}

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function matchPlayerService(player, keyword) {
  const allowedServices = normalizeAllowedServices(player.allowed_services);

  // 沒設定服務，就先不讓他出現在選單，避免誤接技術單
  if (!allowedServices.length) return false;

  const target = String(keyword || "")
    .replace(/\s+/g, "")
    .trim();

  return allowedServices.some((service) => {
    const serviceText = String(service || "")
      .replace(/\s+/g, "")
      .trim();

    return serviceText === target;
  });
}

function matchPlayerGender(player, genderPreference) {
  if (
    !genderPreference ||
    genderPreference === "不指定" ||
    genderPreference === "男女皆可"
  ) {
    return true;
  }

  const gender = String(player.gender || "").trim();

  if (genderPreference === "男陪") {
    return gender === "男" || gender.includes("男");
  }

  if (genderPreference === "女陪") {
    return gender === "女" || gender.includes("女");
  }

  return true;
}
function cleanServiceKey(text = "") {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[｜|]/g, "")
    .replace(/　/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function getRequiredServiceRoleIdsFromPending(pending = {}) {
  const game = cleanServiceKey(pending.game || pending.category || "");

  const item = cleanServiceKey(
    pending.item ||
      pending.serviceType ||
      pending.service ||
      pending.playMode ||
      pending.deltaMode ||
      pending.steamCategory ||
      ""
  );

  const combined = `${game}${item}`;

  // ===== 特戰英豪 =====
  if (
    game.includes("特戰英豪") ||
    game.includes("valorant") ||
    pending.category === "valorant"
  ) {
    if (item.includes("娛樂") || combined.includes("娛樂")) {
      return [process.env.VALORANT_ENTERTAIN_ROLE_ID].filter(Boolean);
    }

    if (item.includes("技術") || combined.includes("技術")) {
      return [process.env.VALORANT_SKILL_ROLE_ID].filter(Boolean);
    }

    return [process.env.VALORANT_ENTERTAIN_ROLE_ID].filter(Boolean);
  }

  // ===== 三角洲 =====
  if (
    game.includes("三角洲") ||
    game.includes("delta") ||
    pending.category === "delta"
  ) {
    if (
      item.includes("娛樂") ||
      item.includes("一般") ||
      combined.includes("娛樂") ||
      combined.includes("一般")
    ) {
      return [process.env.DELTA_ENTERTAIN_ROLE_ID].filter(Boolean);
    }

    if (
      item.includes("雙護") ||
      item.includes("猛攻") ||
      item.includes("護航") ||
      item.includes("單護")
    ) {
      return [process.env.DELTA_SKILL_ROLE_ID].filter(Boolean);
    }

    return [process.env.DELTA_ENTERTAIN_ROLE_ID].filter(Boolean);
  }

  // ===== Steam =====
  if (
    game.includes("Steam") ||
    game.includes("steam") ||
    pending.category === "steam"
  ) {
    return [process.env.STEAM_ROLE_ID].filter(Boolean);
  }

  // ===== 絕地求生 PUBG =====
  if (
    game.includes("絕地求生") ||
    game.includes("PUBG") ||
    game.includes("pubg") ||
    pending.category === "pubg"
  ) {
    return [process.env.PUBG_ROLE_ID].filter(Boolean);
  }

  // ===== 陪聊 =====
  if (
    game.includes("陪聊") ||
    item.includes("陪聊") ||
    pending.category === "chat"
  ) {
    return [process.env.CHAT_ROLE_ID].filter(Boolean);
  }

  // ===== 出氣包 =====
  if (
    game.includes("出氣") ||
    item.includes("出氣") ||
    pending.category === "emotion"
  ) {
    return [process.env.EMOTION_ROLE_ID].filter(Boolean);
  }

  return [];
}
function getAllServiceRoleIds() {
  return [
    process.env.VALORANT_ENTERTAIN_ROLE_ID,
    process.env.VALORANT_SKILL_ROLE_ID,

    process.env.DELTA_ENTERTAIN_ROLE_ID,
    process.env.DELTA_SKILL_ROLE_ID,

    process.env.STEAM_ROLE_ID,
    process.env.PUBG_ROLE_ID,

    process.env.CHAT_ROLE_ID,
    process.env.EMOTION_ROLE_ID,
  ].filter(Boolean);
}

function memberHasAnyServiceRole(member) {
  const serviceRoleIds = getAllServiceRoleIds();

  if (!serviceRoleIds.length) {
    return false;
  }

  return serviceRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function memberHasRequiredServiceRole(
  guild,
  userId,
  requiredRoleIds = []
) {
  if (!requiredRoleIds.length) {
    return false;
  }

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return false;

  return requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
async function getQualifiedPlayerOptions(pending) {
  let playerQuery = supabase
    .from("qiunai_staff")
    .select("*")
    .not("discord_id", "is", null)
    .order("status", { ascending: true });

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[新下單] 讀取陪陪失敗", error);
    return [];
  }

  const serviceKeyword = getServiceKeywordFromPending(pending);

  const seenPlayerIds = new Set();

  const filtered = (players || []).filter((player) => {
    const id = String(player.discord_id || "").trim();

    if (!id) return false;

    if (seenPlayerIds.has(id)) {
      return false;
    }

    seenPlayerIds.add(id);

    if (
      !matchPlayerGender(player, pending.gender || pending.genderPreference)
    ) {
      return false;
    }

    const allowedServices = normalizeAllowedServices(player.allowed_services);

    // 沒有設定可接服務，不顯示
    if (!allowedServices.length) return false;

    return matchAllowedServiceName(allowedServices, serviceKeyword);
  });

  const onlinePlayers = filtered.filter(
    (player) => player.status === "available"
  );

  const offlinePlayers = filtered.filter(
    (player) => player.status !== "available"
  );

  const options = [
    {
      label: "不指定陪陪",
      description: "由客服協助安排適合的陪陪",
      value: "none",
    },

    ...onlinePlayers.map((player) => ({
      label: `🟢 ${getStaffDisplayName(player)}`.slice(0, 100),
      description: "目前在線，可直接安排".slice(0, 100),
      value: `online_${player.discord_id}`,
    })),

    ...offlinePlayers.map((player) => ({
      label: `⚪ ${getStaffDisplayName(player)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`,
    })),
  ];

  return options.slice(0, 25);
}
async function getAvailablePlayerOptions(service) {
  let playerQuery = supabase
    .from("qiunai_staff")
    .select("*")
    .eq("status", "available")
    .not("discord_id", "is", null);

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[指定陪陪] 讀取可接單陪陪失敗", error);
    return [];
  }

  const targetService = cleanServiceKey(service || "");

  const seenPlayerIds = new Set();

  return (players || [])
    .filter((player) => {
      const id = String(player.discord_id || "").trim();

      if (!id) return false;

      if (seenPlayerIds.has(id)) {
        return false;
      }

      seenPlayerIds.add(id);

      if (!targetService) return true;

      const allowedServices = normalizeAllowedServices(player.allowed_services);

      if (!allowedServices.length) return false;

      return matchAllowedServiceName(allowedServices, targetService);
    })
    .slice(0, 24)
    .map((player) => ({
      label: getStaffDisplayName(player).slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: player.discord_id,
    }));
}
// ===== 派單紀錄 =====
async function sendPlayLog({ title, description, color = "#00ff99" }) {
  try {
    const channelId = String(process.env.PLAYER_LOG_CHANNEL || "").trim();
    if (!/^\d{16,22}$/.test(channelId)) return;
    const channel = await client.channels.fetch(channelId);

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    await channel.send({
      embeds: [embed],
    });
  } catch (err) {
    console.log("[派單紀錄失敗]", err);
  }
}
async function playerOnline(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  let playerQuery = supabase
    .from("qiunai_staff")
    .select("*")
    .eq("discord_id", interaction.user.id)
    .limit(1);

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[開始接單] 讀取 qiunai_staff 失敗:", error);

    return interaction.editReply({
      content: "❌ 讀取陪陪資料失敗，請稍後再試。",
    });
  }

  const player = players?.[0];

  if (!player) {
    return interaction.editReply({
      content: "❌ 你尚未登記陪玩，請先請管理員在後台新增你的陪玩資料。",
    });
  }

  let updateQuery = supabase
    .from("qiunai_staff")
    .update({
      status: "available",
      online_started_at: new Date().toISOString(),
    })
    .eq("discord_id", interaction.user.id);

  updateQuery = applyStaffGuildFilter(updateQuery);

  const { error: updateError } = await updateQuery;

  if (updateError) {
    console.error("[開始接單] 更新 qiunai_staff 狀態失敗:", updateError);

    return interaction.editReply({
      content: "❌ 開始接單失敗，請稍後再試。",
    });
  }

  return interaction.editReply({
    content: "🟢 你已開始接單。",
  });
}
function hasAllowedServicesFromDb(player) {
  if (!player) return false;

  const services = player.allowed_services;

  if (Array.isArray(services)) {
    return services.length > 0;
  }

  if (typeof services === "string") {
    return services.trim().length > 0;
  }

  return false;
}
// 陪玩下班
async function playerOffline(interaction) {
  let updateQuery = supabase
    .from("qiunai_staff")
    .update({
      status: "offline",
    })
    .eq("discord_id", interaction.user.id);

  updateQuery = applyStaffGuildFilter(updateQuery);

  await updateQuery;

  return interaction.editReply({
    content: "🔴 你已停止接單",
  });
}
function getTodayRangeTW() {
  const now = new Date();

  const taiwanNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const dateText = taiwanNow.toISOString().slice(0, 10);

  const start = new Date(`${dateText}T00:00:00+08:00`);

  const end = new Date(`${dateText}T23:59:59+08:00`);

  return {
    dateText,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

async function sendDailyPlayerSummary() {
  const { dateText, start, end } = getTodayRangeTW();

  const guildId = getStaffGuildId();
  let playerQuery = supabase.from("qiunai_staff").select("*");
  playerQuery = applyStaffGuildFilter(playerQuery);
  const { data: players, error: playerError } = await playerQuery;

  if (playerError) {
    console.log("[每日陪玩總結] 讀取陪玩失敗", playerError);
    return;
  }

  if (!players?.length) {
    return;
  }

  let orderQuery = supabase
    .from("play_orders")
    .select("*")
    .eq("status", "completed")
    .gte("completed_at", start)
    .lte("completed_at", end);
  if (guildId) {
    orderQuery = orderQuery.eq("guild_id", guildId);
  }
  const { data: orders, error: orderError } = await orderQuery;

  if (orderError) {
    console.log("[每日陪玩總結] 讀取訂單失敗", orderError);
    return;
  }

  for (const player of players) {
    const playerOrders = (orders || []).filter((order) => {
      const assignedPlayers = String(order.assigned_player || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      return assignedPlayers.includes(player.discord_id);
    });

    const totalOrders = playerOrders.length;

    const totalPrice = playerOrders.reduce(
      (sum, order) => sum + Number(order.final_price || order.price || 0),
      0
    );

    const orderList = playerOrders.length
      ? playerOrders
          .map((order, index) => {
            return (
              `${index + 1}. ${order.service || "未填寫"}\n` +
              `訂單編號：${order.order_no || order.id}\n` +
              `金額：NT$${order.final_price || order.price || 0}\n` +
              `內容：${order.note || "無"}`
            );
          })
          .join("\n\n")
      : "今日尚無完成訂單";

    const embed = new EmbedBuilder()
      .setColor("#66ccff")
      .setTitle("📊 陪玩每日總結")
      .setDescription(
        `日期：${dateText}\n` +
          `陪玩：<@${player.discord_id}>\n\n` +
          `完成訂單：${totalOrders}\n` +
          `總金額：NT$${totalPrice}\n\n` +
          `━━━━━━━━━━\n\n` +
          `${orderList}`
      )
      .setTimestamp();

    if (player.report_channel_id) {
      const reportChannel = await client.channels
        .fetch(player.report_channel_id)
        .catch(() => null);

      if (reportChannel) {
        await reportChannel.send({
          embeds: [embed],
        });
      }
    }
  }

  console.log(`[每日陪玩總結] 已送出 ${dateText}`);
}
// 查看狀態
async function playerStatus(interaction) {
  let playerQuery = supabase
    .from("qiunai_staff")
    .select("*")
    .eq("discord_id", interaction.user.id)
    .limit(1);
  playerQuery = applyStaffGuildFilter(playerQuery);
  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[我的狀態] 讀取 players 失敗:", error);

    return interaction.editReply({
      content: "❌ 讀取陪玩狀態失敗，請稍後再試。",
    });
  }

  const data = players?.[0];

  if (!data) {
    return interaction.editReply({
      content: "你尚未登記陪玩，請先請管理員在後台新增你的陪玩資料。",
    });
  }

  return interaction.editReply({
    content:
      `📋 你的狀態：${data.status || "未設定"}\n` +
      `📦 完成單數：${data.total_orders || 0}\n` +
      `🎮 可接服務：不限制身分組`,
  });
}
function buildPreferredPlayerText(preferredPlayerIds) {
  if (!preferredPlayerIds) return "不指定";

  const ids = String(preferredPlayerIds)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!ids.length) return "不指定";

  return ids.map((id) => `<@${id}>`).join("、");
}

function messageHasButtonCustomId(message, customId) {
  return (message?.components || []).some((row) =>
    (row?.components || []).some(
      (component) =>
        component?.customId === customId ||
        component?.data?.custom_id === customId,
    ),
  );
}

async function findMessageByButton(channel, customId) {
  if (!channel?.messages?.fetch) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;
  if (typeof messages.find === "function") {
    return messages.find((message) => messageHasButtonCustomId(message, customId)) || null;
  }
  return [...(messages.values?.() || messages || [])].find((message) =>
    messageHasButtonCustomId(message, customId),
  ) || null;
}

async function findExistingStaffOrderMessage(order) {
  const channel = await client.channels
    .fetch(isManualDispatchOrder(order) ? getManualDispatchChannelId(order) : process.env.PLAYER_ORDER_CHANNEL)
    .catch(() => null);
  return findMessageByButton(
    channel,
    isManualDispatchOrder(order)
      ? `manual_preselected_order_${order.id}`
      : `accept_play_order_${order.id}`,
  );
}

async function findExistingStaffControlMessage(channel, order) {
  return findMessageByButton(channel, `complete_order_${order.id}`);
}

async function markPaidOrderDispatchPending(orderId) {
  const { data, error } = await supabase
    .from("play_orders")
    .update({
      dispatch_status: "pending",
      dispatch_last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("paid", true)
    .in("dispatch_status", ["not_ready", "pending", "failed"])
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message || "建立待派單狀態失敗", { cause: error });
  if (data) return data;
  const current = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (current.error || !current.data) {
    throw new Error(current.error?.message || "讀取待派單訂單失敗", { cause: current.error });
  }
  return current.data;
}

async function deliverPaidOrder(order, customerChannel) {
  if (!paidOrderDispatcher) throw new Error("派單恢復服務尚未初始化");
  const result = await paidOrderDispatcher(order, customerChannel);
  if (result.inProgress) {
    const error = new Error("付款已完成，派單正由另一個程序處理；請稍後用原按鈕重試。");
    error.code = "DISPATCH_IN_PROGRESS";
    throw error;
  }
  return result;
}

async function retryPendingPaidOrderDispatches() {
  if (paidOrderDispatchRecoveryRunning || !paidOrderDispatcher) return;
  const recoveryGuildId = String(process.env.GUILD_ID || "").trim();
  if (!recoveryGuildId) {
    console.error("[派單恢復] 缺少 GUILD_ID，已停止未分租戶的全表掃描");
    return;
  }
  paidOrderDispatchRecoveryRunning = true;
  try {
    const { data: orders, error } = await supabase
      .from("play_orders")
      .select("*")
      .eq("guild_id", recoveryGuildId)
      .eq("paid", true)
      .in("dispatch_status", ["pending", "failed", "processing"])
      .order("updated_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const order of orders || []) {
      // 已刪除的臨時下單頻道無法重建原訊息，保留失敗狀態供人工處理，
      // 不要每輪再嘗試對 null 頻道發送客服面板。
      if (String(order.dispatch_last_error || "").startsWith("customer_channel_deleted:")) continue;
      let customerChannel = null;
      let missingChannel = !order.channel_id;
      if (order.channel_id) {
        try {
          customerChannel = await client.channels.fetch(order.channel_id, { force: true });
        } catch (fetchError) {
          if (Number(fetchError?.code) === 10003) missingChannel = true;
          else {
            console.error(`[派單恢復] ${order.order_no || order.id} 讀取客戶頻道失敗`, fetchError);
            continue;
          }
        }
      }
      if (missingChannel || !customerChannel?.isTextBased?.()) {
        const reason = `customer_channel_deleted: ${order.channel_id || "missing"}; requires manual recovery`;
        const staleClaimBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        let markQuery = supabase.from("play_orders")
          .update({ dispatch_status: "failed", dispatch_last_error: reason, updated_at: new Date().toISOString() })
          .eq("id", order.id)
          .eq("guild_id", recoveryGuildId)
          .eq("paid", true);
        markQuery = order.dispatch_status === "processing"
          ? markQuery.eq("dispatch_status", "processing").lt("dispatch_claimed_at", staleClaimBefore)
          : markQuery.in("dispatch_status", ["pending", "failed"]);
        const { data: marked, error: markError } = await markQuery.select("id").maybeSingle();
        if (markError) console.error(`[派單恢復] ${order.order_no || order.id} 記錄失聯頻道失敗`, markError);
        else if (marked) console.warn(`[派單恢復] ${order.order_no || order.id} 客戶頻道已刪除，保留待人工處理`);
        else if (!missingCustomerChannelWarnings.has(order.id)) {
          missingCustomerChannelWarnings.add(order.id);
          console.warn(`[派單恢復] ${order.order_no || order.id} 客戶頻道已刪除，等待進行中的派單鎖逾時`);
        }
        continue;
      }
      try {
        await deliverPaidOrder(order, customerChannel);
      } catch (dispatchError) {
        if (dispatchError?.code !== "DISPATCH_IN_PROGRESS") {
          console.error(
            `[派單恢復] ${order.order_no || order.id} 補派失敗`,
            dispatchError,
          );
        }
      }
    }
  } finally {
    paidOrderDispatchRecoveryRunning = false;
  }
}

function startPaidOrderDispatchRecovery() {
  if (paidOrderDispatchRecoveryTimer) return paidOrderDispatchRecoveryTimer;
  const firstRun = setTimeout(() => {
    void retryPendingPaidOrderDispatches().catch((error) =>
      console.error("[派單恢復] 初次掃描失敗", error),
    );
  }, 10_000);
  firstRun.unref?.();
  paidOrderDispatchRecoveryTimer = setInterval(() => {
    void retryPendingPaidOrderDispatches().catch((error) =>
      console.error("[派單恢復] 定期掃描失敗", error),
    );
  }, 30_000);
  paidOrderDispatchRecoveryTimer.unref?.();
  return paidOrderDispatchRecoveryTimer;
}

function firstRpcObject(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
}

async function applyPersistentVipEffect({
  operationKey,
  userId,
  guildId,
  triggerType,
  amount,
  notificationChannelId = null,
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) throw new Error("VIP 補償缺少 guild_id");
  const { data, error } = await supabase.rpc("qiunai_apply_vip_effect", {
    p_operation_key: String(operationKey),
    p_user_id: String(userId),
    p_guild_id: normalizedGuildId,
    p_trigger_type: triggerType,
    p_amount: Number(amount),
  });
  if (error) throw new Error(error.message || "VIP 累積原子補償失敗");
  const vip = firstRpcObject(data);
  if (!vip) throw new Error("VIP 累積原子補償未回傳結果");

  // RPC 已在同一 transaction 以 operationKey 更新店別專屬累積；這裡只依
  // 絕對值同步等級/獎勵。背景重試不會再加一次累積。
  await paymentHelpers.checkAndUpgradeVip?.(
    String(userId),
    triggerType,
    Number(amount),
    normalizedGuildId,
    notificationChannelId,
    triggerType === "topup"
      ? Number(vip.total_topup || 0)
      : Number(vip.total_spent || 0),
    triggerType === "topup"
      ? Number(vip.highest_single_topup || 0)
      : null,
    true,
  );
  return vip;
}

async function processFinancialEffect(operationKey) {
  const { data, error } = await supabase.rpc("qiunai_claim_financial_effect", {
    p_operation_key: String(operationKey),
  });
  if (error) throw new Error(error.message || "鎖定財務補償失敗");
  const claim = firstRpcObject(data);
  if (!claim?.claimed) return { state: claim?.state || "processing" };

  const operation = claim.operation || {};
  const result = operation.result || {};
  const attempt = Number(claim.attempt || operation.effects_attempts || 0);
  try {
    if (operation.operation_type === "manual_topup_effects") {
      const userId = String(result.user_id || "");
      const amount = Number(operation.amount || result.amount || 0);
      if (!userId || amount <= 0) throw new Error("儲值 VIP 補償資料不完整");
      await paymentHelpers.recordMembershipActivity?.({
        userId,
        amount,
        sourceKey: `dispatch-topup:${result.topup_no}:${userId}`,
        note: `${result.topup_no}｜客服確認儲值`,
      });
      await applyPersistentVipEffect({
        operationKey: operation.operation_key,
        userId,
        guildId: result.guild_id || process.env.GUILD_ID,
        triggerType: "topup",
        amount,
      });
      const ledger = await paymentHelpers.recordAccountingLedger?.({
        entry_type: "customer_topup",
        entry_label: "客人儲值",
        amount,
        cash_amount: amount,
        liability_amount: amount,
        payment_method: "客服確認儲值",
        customer_id: userId,
        source_table: "wallet_logs",
        source_id: result.topup_no,
        dedupe_key: `topup:${result.topup_no}:${userId}:${amount}`,
        note: `${result.topup_no}｜客服 <@${operation.actor_id || ""}> 確認儲值`,
        created_by: operation.actor_id || null,
      });
      if (ledger?.saved === false && !ledger.skipped) {
        throw ledger.error || new Error("儲值會計流水補寫失敗");
      }
    } else if (operation.operation_type === "self_service_refund") {
      const order = result.order || {};
      const amount = Number(operation.amount || result.refund_amount || 0);
      const userId = String(order.customer_id || operation.actor_id || "");
      if (!userId || amount < 0) throw new Error("自助退款補償資料不完整");
      if (amount > 0) {
        const ledger = await paymentHelpers.recordAccountingLedger?.({
          entry_type: "customer_order_refund",
          entry_label: "客人退款",
          amount: -amount,
          revenue_amount: -amount,
          liability_amount: amount,
          payment_method: "儲值卡 / 錢包",
          customer_id: userId,
          order_id: String(order.id || operation.entity_id),
          order_no: order.order_no || null,
          source_table: "play_orders",
          source_id: String(order.id || operation.entity_id),
          dedupe_key: operation.operation_key,
          note: "自助下單取消退款",
        });
        if (ledger?.saved === false && !ledger.skipped) {
          throw ledger.error || new Error("退款會計流水補寫失敗");
        }
        if (result.was_vip_spent_counted) {
          await paymentHelpers.recordSpendActivity?.({
            userId,
            amount: -amount,
            sourceKey: operation.operation_key,
            note: `自助訂單 ${order.order_no || order.id || operation.entity_id} 退款`,
          });
          await applyPersistentVipEffect({
            operationKey: operation.operation_key,
            userId,
            guildId: order.guild_id || process.env.GUILD_ID,
            triggerType: "spend",
            amount: -amount,
            notificationChannelId: order.channel_id || null,
          });
        }
      }
    } else {
      throw new Error(`不支援的財務補償：${operation.operation_type || "unknown"}`);
    }

    const completed = await supabase.rpc("qiunai_complete_financial_effect", {
      p_operation_key: String(operationKey),
      p_attempt: attempt,
    });
    if (completed.error) throw new Error(completed.error.message || "完成財務補償標記失敗");
    return { state: "completed" };
  } catch (effectError) {
    await supabase.rpc("qiunai_fail_financial_effect", {
      p_operation_key: String(operationKey),
      p_attempt: attempt,
      p_error: String(effectError.message || effectError).slice(0, 1500),
    });
    throw effectError;
  }
}

async function retryPendingFinancialEffects() {
  if (financialEffectsRecoveryRunning) return;
  financialEffectsRecoveryRunning = true;
  try {
    const { data: operations, error } = await supabase
      .from("bot_financial_operations")
      .select("operation_key")
      .eq("organization_code", "qiunai")
      .in("operation_type", ["manual_topup_effects", "self_service_refund"])
      .in("effects_status", ["pending", "processing", "failed"])
      .order("updated_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const operation of operations || []) {
      await processFinancialEffect(operation.operation_key).catch((effectError) =>
        console.error(`[財務補償] ${operation.operation_key} 失敗`, effectError),
      );
    }
    await paymentHelpers.retryPendingVipRewards?.();
  } finally {
    financialEffectsRecoveryRunning = false;
  }
}

function startFinancialEffectsRecovery() {
  if (financialEffectsRecoveryTimer) return financialEffectsRecoveryTimer;
  const firstRun = setTimeout(() => {
    void retryPendingFinancialEffects().catch((error) =>
      console.error("[財務補償] 初次掃描失敗", error),
    );
  }, 15_000);
  firstRun.unref?.();
  financialEffectsRecoveryTimer = setInterval(() => {
    void retryPendingFinancialEffects().catch((error) =>
      console.error("[財務補償] 定期掃描失敗", error),
    );
  }, 30_000);
  financialEffectsRecoveryTimer.unref?.();
  return financialEffectsRecoveryTimer;
}

async function sendOrderToStaffChannel(order) {
  const channel = await client.channels.fetch(
    isManualDispatchOrder(order)
      ? getManualDispatchChannelId(order)
      : process.env.PLAYER_ORDER_CHANNEL,
  );

  const preferredText = buildPreferredPlayerText(order.preferred_player);

  const embed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("📦 已建立新陪玩訂單")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "🌟 指定陪陪",
        value: preferredText,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: isManualQuoteSelfServiceOrder(order)
          ? `🏅 ${getSelfServiceRankFieldLabel(order)}`
          : "🏅 段位",
        value: order.rank_preference || "不指定",
        inline: true,
      },
      {
        name: "👥 需要人數",
        value: `${Number(order.player_count || 1) || 1} 位`,
        inline: true,
      },
      {
        name: "🕒 預約時間",
        value: order.reserved_time || order.duration_text || "未填寫",
        inline: true,
      },
      {
        name: "💰 商品金額",
        value: `NT$${order.final_price || order.price || 0}`,
        inline: true,
      },
      {
        name: "📝 備註需求",
        value: getPublicOrderNote(order.note),
        inline: false,
      }
    )
    .setFooter({
      text: "星雨派單系統",
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    isManualDispatchOrder(order)
      ? new ButtonBuilder()
          .setCustomId(`manual_preselected_order_${order.id}`)
          .setLabel("老闆已選定陪陪")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true)
      : new ButtonBuilder()
          .setCustomId(`accept_play_order_${order.id}`)
          .setLabel("接單")
          .setStyle(ButtonStyle.Success)
  );

  const playerRoleMention = process.env.PLAYER_ROLE_ID
    ? `<@&${process.env.PLAYER_ROLE_ID}>`
    : "";
  return channel.send({
    content:
      isManualDispatchOrder(order)
        ? `${preferredText} ✅ 老闆已選定陪陪並完成付款，不再開放其他人接單。`
        : order.dispatch_type === "reserve"
        ? `${playerRoleMention} 🕒 預約派單：<@${order.reserved_player}>｜時間：${order.reserved_time}`
        : order.preferred_player
        ? `${playerRoleMention} 🌟 指定陪陪派單：${preferredText}`
        : `${playerRoleMention} 📢 開放接單`,
    embeds: [embed],
    components: [row],
  });
}
async function sendStaffOrderControlPanel(channel, order) {
  if (!channel?.isTextBased?.()) {
    throw new Error(`訂單 ${order.order_no || order.id} 的客戶頻道不存在，無法發送客服面板`);
  }
  if (isManualDispatchOrder(order) && order.paid) {
    const selectedIds = String(order.preferred_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!selectedIds.length) throw new Error("人工派單已付款，但缺少老闆選定的陪陪");
    for (const playerId of selectedIds) {
      await channel.permissionOverwrites?.edit(playerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    }
    const { data: acceptedOrder, error } = await supabase
      .from("play_orders")
      .update({
        assigned_player: selectedIds.join(","),
        status: "accepted",
        accepted_at: order.accepted_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("paid", true)
      .select()
      .maybeSingle();
    if (error || !acceptedOrder) throw new Error(error?.message || "完成人工派單指派失敗");
    order = acceptedOrder;
    await workReportSystem.sendForAcceptedOrder(order, selectedIds);
    await channel.send({
      content:
        `<@${order.customer_id}> ${selectedIds.map((id) => `<@${id}>`).join(" ")}\n` +
        `✅ 付款已完成，系統已將老闆選定的陪陪加入頻道並發送報單。`,
      allowedMentions: {
        users: [String(order.customer_id), ...selectedIds],
      },
    });
  }
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("修改訂單")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`change_order_price_${order.id}`)
      .setLabel("修改金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`extend_order_${order.id}`)
      .setLabel("訂單加時")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`complete_order_${order.id}`)
      .setLabel("完成訂單")
      .setEmoji("🏁")
      .setStyle(ButtonStyle.Success)
  );

  return channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 訂單客服操作面板`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🛠️ 客服訂單管理")
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
            `闆闆：<@${order.customer_id}>\n` +
            `服務：${order.service || order.order_item || "未填寫"}\n` +
            `金額：NT$${order.final_price || order.price || 0}\n\n` +
            `可在這裡修改訂單、修改金額、建立加時，或在服務結束後完成訂單。`
        )
        .setTimestamp(),
    ],
    components: [row1, row2],
  });
}
// ===== 陪玩控制面板 =====
async function sendPlayerPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("🎮 陪玩控制中心")
    .setDescription("請使用下方按鈕控制接單狀態。");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("player_online")
      .setLabel("🟢 開始接單")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("player_offline")
      .setLabel("🔴 停止接單")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("player_status")
      .setLabel("📋 我的狀態")
      .setStyle(ButtonStyle.Secondary)
  );

  const messages = await channel.messages.fetch({
    limit: 10,
  });
  const oldPanel = messages.find(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === "🎮 陪玩控制中心"
  );
  if (oldPanel) {
    await oldPanel.edit({
      embeds: [embed],
      components: [row],
    });
    return;
  }
  await channel.send({
    embeds: [embed],
    components: [row],
  });
}
function buildOrderBackRow(flowId, target) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`new_order_back_${target}_${flowId}`)
      .setLabel("⬅️ 上一步")
      .setStyle(ButtonStyle.Secondary)
  );
}
async function sendJkopayTopupPanel() {
  const channel = await client.channels.fetch(JKOPAY_TOPUP_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.()) {
    throw new Error(`找不到街口自助購幣頻道：${JKOPAY_TOPUP_CHANNEL_ID}`);
  }

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("💳 自助購買星雨幣")
    .setDescription(
      `使用街口支付自助購買星雨幣。\n\n` +
        `匯率：NT$1 = 1 ASD\n` +
        `付款方式：僅限街口支付\n` +
        `付款完成後系統會自動查帳並立即將星雨幣存入錢包，不需要上傳付款截圖。\n\n` +
        `可按「建立訂單」輸入其他金額，或直接使用下方快速購買按鈕。`,
    )
    .setFooter({ text: "秋奈電競｜街口支付自助購幣" })
    .setTimestamp();
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("jkopay_topup_start")
        .setLabel("建立訂單")
        .setEmoji("💳")
        .setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("jkopay_topup_quick_label")
        .setLabel("快速購買")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
    new ActionRowBuilder().addComponents(
      ...TOPUP_PRESET_AMOUNTS.slice(0, 4).map((amount) =>
        new ButtonBuilder()
          .setCustomId(`jkopay_topup_amount_${amount}`)
          .setLabel(`${amount}元`)
          .setStyle(ButtonStyle.Primary),
      ),
    ),
    new ActionRowBuilder().addComponents(
      ...TOPUP_PRESET_AMOUNTS.slice(4).map((amount) =>
        new ButtonBuilder()
          .setCustomId(`jkopay_topup_amount_${amount}`)
          .setLabel(`${amount}元`)
          .setStyle(ButtonStyle.Primary),
      ),
    ),
  ];
  const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const oldPanel = messages?.find(
    (message) =>
      message.author.id === client.user.id &&
      message.embeds[0]?.title === "💳 自助購買星雨幣",
  );
  if (oldPanel) return oldPanel.edit({ embeds: [embed], components });
  return channel.send({ embeds: [embed], components });
}

function parseJkopayTopupPresetAmount(customId) {
  const matched = String(customId || "").match(/^jkopay_topup_amount_(\d+)$/);
  if (!matched) return null;
  const amount = Number(matched[1]);
  return TOPUP_PRESET_AMOUNTS.includes(amount) ? amount : null;
}

async function createTopupTicket(interaction, presetAmount = null, { jkopayOnly = false } = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const normalizedPreset = presetAmount === null
    ? null
    : TOPUP_PRESET_AMOUNTS.includes(Number(presetAmount))
      ? Number(presetAmount)
      : null;
  if (presetAmount !== null && normalizedPreset === null) {
    return interaction.editReply({ content: "❌ 不支援的星雨幣購買金額。" });
  }
  if (jkopayOnly && (!paymentHelpers.jkopayAvailable || !paymentHelpers.createJkopayTopup)) {
    return interaction.editReply({ content: "❌ 街口支付目前無法使用，請稍後再試。" });
  }

  const guild = interaction.guild;
  const topupNo = await getNextTopupNumber(supabase);
  const safeName = interaction.user.username
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
    .slice(0, 10);
  const parentId = await resolveTicketParentId(
    guild,
    ORDER_TICKET_CATEGORY_ID,
    "訂單區"
  );

  const channel = await guild.channels.create({
    name: `購買-${topupNo.toLowerCase()}-${safeName}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${buildTopupTopic(interaction.user.id, topupNo)}${jkopayOnly ? ";payment_mode:jkopay" : ""}`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(jkopayOnly ? "open_jkopay_topup_modal" : "open_topup_modal")
      .setLabel("輸入其他金額")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("owner_cancel_ticket")
      .setLabel("我按錯了，關閉頻道")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
  );

  const checkout = normalizedPreset && !jkopayOnly
    ? prepareTopupCheckout({
        userId: interaction.user.id,
        amount: normalizedPreset,
        note: "快捷金額",
        topupNo,
      })
    : null;

  await channel.send({
    content: jkopayOnly ? `<@${interaction.user.id}>` : `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💳 購買星雨幣訂單")
        .setDescription(
          `訂單編號：${topupNo}\n` +
            (normalizedPreset
              ? `購買金額：NT$${normalizedPreset.toLocaleString("zh-TW")}\n${jkopayOnly ? "街口付款連結將直接建立於下方。" : "請直接選擇付款方式。"}\n\n`
              : `請輸入購買金額後繼續付款。\n\n`) +
            `${jkopayOnly ? "本訂單僅限街口支付。" : "使用街口支付完成付款後，"}系統會自動核帳並將 ASD 存入錢包。`,
        ),
    ],
    components: checkout ? [...checkout.rows, new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("owner_cancel_ticket")
        .setLabel("取消訂單並關閉頻道")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    )] : jkopayOnly && normalizedPreset
      ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("owner_cancel_ticket")
            .setLabel("取消訂單並關閉頻道")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
        )]
      : [actionRow],
  });

  if (jkopayOnly && normalizedPreset) {
    try {
      await createJkopayTopupPaymentMessage({
        channel,
        userId: interaction.user.id,
        amount: normalizedPreset,
        topupNo,
      });
    } catch (error) {
      await channel.send(`❌ 街口付款單建立失敗：${error.message || error}`);
      return interaction.editReply({ content: `❌ 已建立訂單頻道，但街口付款連結建立失敗：<#${channel.id}>` });
    }
  }

  return interaction.editReply({
    content: `✅ 已建立購買星雨幣訂單：<#${channel.id}>${jkopayOnly && normalizedPreset ? "，街口付款連結已產生。" : ""}`,
  });
}
async function createTipTicket(interaction, mode = "tip") {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const guild = interaction.guild;
  const parentId = await resolveTicketParentId(
    guild,
    ORDER_TICKET_CATEGORY_ID,
    "訂單區"
  );

  const channel = await guild.channels.create({
    name: `${mode === "crown" ? "冠名" : "打賞"}-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `owner:${interaction.user.id}`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle(mode === "crown" ? "👑 冠名單頻道" : "💝 打賞頻道")
        .setDescription(
          mode === "crown"
            ? "請依照下方選單選擇冠名方案。"
            : "請依照下方選單選擇打賞禮物。",
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("owner_cancel_ticket")
          .setLabel("我按錯了，關閉頻道")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });

  const startFlow =
    mode === "crown"
      ? paymentHelpers.startCrownFlowInChannel
      : paymentHelpers.startTipFlowInChannel;
  if (!startFlow) {
    await channel.send("❌ 打賞／冠名流程尚未接入。");
  } else {
    await startFlow(channel, interaction.user);
  }

  return interaction.editReply({
    content: `✅ 已建立打賞頻道：<#${channel.id}>`,
  });
}
async function createServiceTicket(interaction, serviceType, initial = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const guild = interaction.guild;
  const serviceName = getServiceName(serviceType);
  const flowId = createFlowId(interaction.user.id);
  const parentId = await resolveTicketParentId(
    guild,
    ORDER_TICKET_CATEGORY_ID,
    "訂單區"
  );

  const channel = await guild.channels.create({
    name: `${serviceName}-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `owner:${interaction.user.id}`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  await pendingServiceOrders.set(flowId, {
    flowId,
    guildId:
      interaction.guildId || interaction.guild?.id || process.env.GUILD_ID,
    channelId: channel.id,
    customerId: interaction.user.id,
    customerUsername: interaction.user.username,
    category: serviceType,

    gameLabel: initial.gameLabel || getServiceName(serviceType),
    itemLabel: initial.itemLabel || null,

    serviceType: initial.serviceType || null,
    serviceTypes: initial.serviceTypes || [],
    playMode: initial.playMode || null,
    rank: initial.rank || null,
    valorantCompanionRank: initial.valorantCompanionRank || null,
    steamCategory: initial.steamCategory || null,
    steamGameName: initial.steamGameName || null,
    deltaPlatform: initial.deltaPlatform || null,
    deltaMode: initial.deltaMode || null,

    playerCount: initial.playerCount || null,
    genderPreference: null,
    assignMode: "不指定",
    selectedPlayerIds: [],

    duration: null,
    rounds: null,
    note: "",
    quotedPrice: null,
    originalPrice: null,
    finalPrice: null,
    discountRate: 1,
    discountAmount: 0,
    couponText: "未使用優惠券",
    usedCouponItemId: null,
    usedCouponName: null,
    paymentMethod: null,
    timeSelectShown: false,
    fromPanel: Boolean(initial.fromPanel),

    // 新分區入口會先把「送出訂單」按鈕直接放進臨時頻道，避免重複出現
    finishButtonShown: Boolean(initial.fromPanel),
  });

  if (initial.fromPanel) {
    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(QIUNAI_WATER_BLUE)
          .setTitle(`🌙 ${serviceName} 下單頻道`)
          .setDescription(
            `請依照下方選項填寫需求。\n\n` +
              `填寫完成後，系統會先自動報價；無法計算時才會通知客服。`
          )
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("owner_cancel_ticket")
            .setLabel("我按錯了，關閉頻道")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger)
        ),
      ],
    });
    await sendQuickServiceNeedPanel(channel, flowId, initial);

    return interaction.editReply({
      content:
        `✅ 已建立臨時下單頻道：<#${channel.id}>\n` +
        `項目：${
          initial.serviceType ||
          initial.itemLabel ||
          getServiceName(serviceType)
        }`,
    });
  }

  await channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle(`🌙 ${serviceName} 下單頻道`)
        .setDescription(
          `請依照下方選項填寫需求。\n\n` +
            `填寫完成後，系統會先自動報價；無法計算時才會通知客服。`
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("owner_cancel_ticket")
          .setLabel("我按錯了，關閉頻道")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });
  if (serviceType === "valorant") {
    await showValorantStart(channel, flowId);
  }
  if (serviceType === "steam") {
    await showSteamStart(channel, flowId);
  }
  if (serviceType === "delta") {
    await showDeltaStart(channel, flowId);
  }
  if (serviceType === "chat") {
    await showSimpleServiceStart(channel, flowId, "chat");
  }
  if (serviceType === "emotion") {
    await showSimpleServiceStart(channel, flowId, "emotion");
  }
  return interaction.editReply({
    content: `✅ 已建立下單頻道：<#${channel.id}>`,
  });
}
async function showValorantStart(channel, flowId) {
  const pending = await pendingServiceOrders.get(flowId);
  const hasPresetType = Boolean(pending?.serviceType);
  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_type_select_${flowId}`)
    .setPlaceholder("請選擇需求的陪陪段位")
    .addOptions([
      {
        label: "娛樂",
        value: "entertain",
        description: "需求的陪陪段位｜娛樂",
      },
      {
        label: "超凡",
        value: "ascendant",
        description: "需求的陪陪段位｜超凡",
      },
      {
        label: "神話",
        value: "immortal",
        description: "需求的陪陪段位｜神話",
      },
      {
        label: "輻能",
        value: "radiant",
        description: "需求的陪陪段位｜輻能",
      },
      {
        label: "頂輻",
        value: "top_radiant",
        description: "需求的陪陪段位｜頂輻",
      },
    ]);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`valorant_mode_rank_${flowId}`)
      .setLabel("排位")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`valorant_mode_normal_${flowId}`)
      .setLabel("一般")
      .setStyle(ButtonStyle.Secondary)
  );

  const rankMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_rank_${flowId}`)
    .setPlaceholder("請選擇段位")
    .addOptions([
      {
        label: "鐵牌",
        value: "鐵牌",
      },
      {
        label: "銅牌",
        value: "銅牌",
      },
      {
        label: "銀牌",
        value: "銀牌",
      },
      {
        label: "金牌",
        value: "金牌",
      },
      {
        label: "白金",
        value: "白金",
      },
      {
        label: "鑽石",
        value: "鑽石",
      },
      {
        label: "超凡",
        value: "超凡",
      },
      {
        label: "神話",
        value: "神話",
      },
      {
        label: "輻能",
        value: "輻能",
      },
      {
        label: "不指定 / 尚未確認",
        value: "不指定",
      },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      {
        label: "1 位",
        value: "1",
      },
      {
        label: "2 位",
        value: "2",
      },
      {
        label: "3 位",
        value: "3",
      },
      {
        label: "4 位",
        value: "4",
      },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "不指定",
        value: "不指定",
      },
      {
        label: "男陪",
        value: "男陪",
      },
      {
        label: "女陪",
        value: "女陪",
      },
    ]);

  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時長｜娛樂 / 金牌以下技術適用")
    .addOptions([
      {
        label: "1 小時",
        value: "1",
      },
      {
        label: "2 小時",
        value: "2",
      },
      {
        label: "3 小時",
        value: "3",
      },
      {
        label: "4 小時",
        value: "4",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);
  const roundsMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數｜技術金牌以上適用")
    .addOptions([
      {
        label: "1 局",
        value: "1",
      },
      {
        label: "3 局",
        value: "3",
      },
      {
        label: "5 局",
        value: "5",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🎯 特戰英豪需求")
        .setDescription(
          (hasPresetType
            ? `已選擇需求的陪陪段位：${pending.serviceType}\n\n`
            : `請先選擇需求的陪陪段位。\n\n`) +
            `**客服價格參考**\n` +
            `陪陪段位：娛樂、超凡、神話、輻能、頂輻\n` +
            `系統會依要打的段位，自動判斷時數或局數及正式金額。`
        ),
    ],
    components: [
      ...(hasPresetType
        ? []
        : [new ActionRowBuilder().addComponents(typeMenu)]),
      row2,
      new ActionRowBuilder().addComponents(rankMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
    ],
  });

  await channel.send({
    content:
      `請繼續選擇時間：\n\n` +
      `娛樂陪玩 / 金牌以下技術單 → 選「時長」\n` +
      `金牌以上技術單 → 選「局數」`,
    components: [
      new ActionRowBuilder().addComponents(durationMenu),
      new ActionRowBuilder().addComponents(roundsMenu),
    ],
  });
}
async function showSteamStart(channel, flowId) {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`steam_category_${flowId}`)
    .setPlaceholder("請選擇 Steam 遊戲類型")
    .addOptions([
      {
        label: "恐怖遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "恐怖遊戲",
      },
      {
        label: "生存遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "生存遊戲",
      },
      {
        label: "肉鴿遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "肉鴿遊戲",
      },
      {
        label: "派對遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "派對遊戲",
      },
      {
        label: "其他",
        description: "請輸入遊戲名稱，由客服報價",
        value: "其他",
      },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`steam_game_name_${flowId}`)
      .setLabel("輸入遊戲名稱")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註 / 自訂需求")
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🎮 Steam 下單需求")
        .setDescription(
          `請選擇遊戲類型、人數、性別與時長。\n\n` +
            `⚠️ 價格只提供客服參考，正式報價由客服輸入。`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(categoryMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      row,
    ],
  });

  await showServiceDurationSelect(channel, flowId, "hour");
}
async function showDeltaStart(channel, flowId) {
  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId(`delta_mode_${flowId}`)
    .setPlaceholder("請選擇三角洲玩法")
    .addOptions([
      { label: "基礎陪護", value: "基礎陪護" },
      { label: "機密雙護", value: "機密雙護" },
      { label: "機密雙護（保底）", value: "機密雙護（保底）" },
      { label: "猛攻護航", value: "猛攻護航" },
      { label: "猛攻護航（保底）", value: "猛攻護航（保底）" },
      { label: "一般陪玩", value: "一般陪玩" },
      { label: "其他玩法", value: "其他玩法" },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🛡️ 三角洲下單需求")
        .setDescription(
          `請選擇玩法、人數、性別與時間。\n\n` +
            `⚠️ 保底、雙護、護航等價格僅供客服參考，正式報價由客服輸入。`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(modeMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
    ],
  });

  await showServiceDurationSelect(channel, flowId, "hour");
}
async function showServiceDurationSelect(channel, flowId, unit = "hour") {
  const options =
    unit === "half"
      ? [
          { label: "30 分鐘", value: "0.5" },
          { label: "1 小時", value: "1" },
          { label: "1.5 小時", value: "1.5" },
          { label: "2 小時", value: "2" },
          { label: "自訂", value: "custom" },
        ]
      : [
          { label: "1 小時", value: "1" },
          { label: "2 小時", value: "2" },
          { label: "3 小時", value: "3" },
          { label: "4 小時", value: "4" },
          { label: "自訂", value: "custom" },
        ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions(options);

  await channel.send({
    content: "請選擇服務時間：",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showServiceRoundSelect(channel, flowId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數")
    .addOptions([
      { label: "1 局", value: "1" },
      { label: "3 局", value: "3" },
      { label: "5 局", value: "5" },
      { label: "自訂", value: "custom" },
    ]);

  await channel.send({
    content: "請選擇局數：",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

function isValorantGoldOrBelow(rank) {
  return ["鐵牌", "銅牌", "銀牌", "金牌", "金牌含以下", "不指定"].includes(
    String(rank || "")
  );
}
function isValorantAboveGold(rank) {
  return ["白金", "鑽石", "超凡", "神話", "輻能"].includes(String(rank || ""));
}
async function showValorantTimeOrRoundOnce(channel, flowId, pending) {
  if (pending.timeSelectShown) {
    return;
  }

  if (!pending.serviceType) {
    return;
  }

  if (pending.serviceType === "娛樂") {
    pending.timeSelectShown = true;
    await pendingServiceOrders.set(flowId, pending);
    await showServiceDurationSelect(channel, flowId, "hour");
    return;
  }

  if (pending.serviceType === "技術") {
    if (!pending.rank) {
      await channel.send("請先選擇段位，系統會依段位顯示時長或局數。");
      return;
    }

    pending.timeSelectShown = true;
    await pendingServiceOrders.set(flowId, pending);

    if (isValorantGoldOrBelow(pending.rank)) {
      await showServiceDurationSelect(channel, flowId, "hour");
    } else {
      await showServiceRoundSelect(channel, flowId);
    }
  }
}
async function showSimpleServiceStart(channel, flowId, serviceType) {
  const isChat = serviceType === "chat";

  const title = isChat ? "💬 陪聊需求" : "🧸 出氣包需求";

  const description = isChat
    ? "陪聊以半小時為一單位，正式價格由客服輸入。"
    : "出氣包以半小時為一單位，正式價格由客服輸入。";

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      {
        label: "1 位",
        value: "1",
      },
      {
        label: "2 位",
        value: "2",
      },
      {
        label: "3 位",
        value: "3",
      },
      {
        label: "4 位",
        value: "4",
      },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "不指定",
        value: "不指定",
      },
      {
        label: "男陪",
        value: "男陪",
      },
      {
        label: "女陪",
        value: "女陪",
      },
    ]);

  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions([
      {
        label: "30 分鐘",
        value: "0.5",
      },
      {
        label: "1 小時",
        value: "1",
      },
      {
        label: "1.5 小時",
        value: "1.5",
      },
      {
        label: "2 小時",
        value: "2",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle(title)
        .setDescription(
          `${description}\n\n` +
            `請依序選擇人數、性別與時間。\n\n` +
            `⚠️ 價格僅供參考，正式報價由客服輸入。`
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(durationMenu),
    ],
  });
}
const NEW_ORDER_GAME_OPTIONS = [
  {
    label: "特戰英豪",
    description: "VALORANT 需求的陪陪段位",
    value: "特戰英豪",
  },
  {
    label: "三角洲行動",
    description: "三角洲護航 / 保底 / 娛樂",
    value: "三角洲行動",
  },
  {
    label: "Apex",
    description: "Apex 大神 / 技術 / 娛樂",
    value: "Apex",
  },
  {
    label: "英雄聯盟",
    description: "召喚峽谷 / ARAM / 聯盟戰棋",
    value: "英雄聯盟",
  },
  {
    label: "STEAM",
    description: "Steam 遊戲陪玩",
    value: "STEAM",
  },
  {
    label: "其他",
    description: "其他遊戲、語音聊天或自訂需求",
    value: "其他",
  },
  {
    label: "陪聊服務",
    description: "聊天 / 陪伴 / 出氣",
    value: "陪聊服務",
  },
  {
    label: "打賞禮物",
    description: "打賞 / 禮物單",
    value: "打賞禮物",
  },
];

function getNewOrderGameOptions() {
  return NEW_ORDER_GAME_OPTIONS.map((option) => ({ ...option }));
}

function buildNewOrderGameMenu(flowId, placeholder = "請選擇遊戲 / 服務類型") {
  return new StringSelectMenuBuilder()
    .setCustomId(`new_order_game_${flowId}`)
    .setPlaceholder(placeholder)
    .addOptions(getNewOrderGameOptions());
}

function buildNewOrderItemMenu(flowId, game) {
  const options = getOrderItemOptions(game)
    .slice(0, 25)
    .map((item) => ({
      label: item.label.slice(0, 100),
      description: item.description.slice(0, 100),
      value: item.value,
    }));

  return new StringSelectMenuBuilder()
    .setCustomId(`new_order_item_${flowId}`)
    .setPlaceholder("請選擇項目")
    .addOptions(options);
}

async function openPlayOrderModal(interaction) {
  const flowId = `${interaction.user.id}_${Date.now()}`;

  await pendingNewOrders.set(flowId, {
    userId: interaction.user.id,
    guildId:
      interaction.guildId || interaction.guild?.id || process.env.GUILD_ID,
    channelId: interaction.channel.id,
    game: "",
    item: "",
    rank: "",
    playerCount: 1,
    gender: "不指定",
    selectedPlayerType: "none",
    selectedPlayerId: null,
    selectedPlayerIds: [],
    duration: "",
    durationMinutes: 0,
    reservedTime: "",
    note: "無",
  });

  const menu = buildNewOrderGameMenu(flowId);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.reply({
    content: "🎮 請先選擇你要下單的遊戲 / 服務：",
    components: [row],
    flags: 64,
  });
}
function getOrderItemOptions(game) {
  if (game === "特戰英豪") {
    return [
      {
        label: "娛樂",
        value: "娛樂",
        description: "需求的陪陪段位｜娛樂",
      },
      {
        label: "超凡",
        value: "超凡",
        description: "需求的陪陪段位｜超凡",
      },
      {
        label: "神話",
        value: "神話",
        description: "需求的陪陪段位｜神話",
      },
      {
        label: "輻能",
        value: "輻能",
        description: "需求的陪陪段位｜輻能",
      },
      {
        label: "頂輻",
        value: "頂輻",
        description: "需求的陪陪段位｜頂輻",
      },
    ];
  }

  if (game === "三角洲行動") {
    return [
      {
        label: "機密雙護",
        value: "機密雙護",
        description: "三角洲機密雙護",
      },
      {
        label: "猛攻護航",
        value: "猛攻護航",
        description: "三角洲猛攻護航",
      },
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "一般娛樂陪玩",
      },
    ];
  }

  if (game === "Apex") {
    return [
      {
        label: "大神陪玩",
        value: "大神陪玩",
        description: "Apex 大神陪玩",
      },
      {
        label: "技術陪玩",
        value: "技術陪玩",
        description: "Apex 技術陪玩",
      },
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "Apex 娛樂陪玩",
      },
    ];
  }

  if (game === "英雄聯盟") {
    return [
      {
        label: "召喚峽谷",
        value: "召喚峽谷",
        description: "英雄聯盟召喚峽谷",
      },
      { label: "ARAM", value: "ARAM", description: "咆哮深淵" },
      {
        label: "聯盟戰棋",
        value: "聯盟戰棋",
        description: "Teamfight Tactics",
      },
    ];
  }

  if (game === "PUBG") {
    return [
      {
        label: "娛樂單陪",
        value: "娛樂單陪",
        description: "PUBG 單陪",
      },
      {
        label: "娛樂雙陪",
        value: "娛樂雙陪",
        description: "PUBG 雙陪",
      },
    ];
  }

  if (game === "STEAM") {
    return [
      {
        label: "恐怖遊戲陪玩",
        value: "恐怖遊戲陪玩",
        description: "Steam 恐怖遊戲",
      },
      {
        label: "一般遊戲陪玩",
        value: "一般遊戲陪玩",
        description: "Steam 一般遊戲",
      },
    ];
  }

  if (game === "陪聊服務") {
    return [
      {
        label: "聊天陪伴",
        value: "聊天陪伴",
        description: "一般聊天陪伴",
      },
      {
        label: "出氣服務",
        value: "出氣服務",
        description: "陪聊 / 出氣",
      },
    ];
  }

  if (game === "其他") {
    return [
      { label: "PUBG M", value: "PUBG M", description: "PUBG M" },
      { label: "NARAKA", value: "NARAKA", description: "NARAKA" },
      {
        label: "Minecraft",
        value: "Minecraft",
        description: "Minecraft",
      },
      {
        label: "王者榮耀",
        value: "王者榮耀",
        description: "王者榮耀",
      },
      {
        label: "傳說對決",
        value: "傳說對決",
        description: "傳說對決",
      },
      {
        label: "第五人格",
        value: "第五人格",
        description: "第五人格",
      },
      {
        label: "語音聊天",
        value: "語音聊天",
        description: "語音聊天服務",
      },
      {
        label: "點歌服務",
        value: "點歌服務",
        description: "點歌服務",
      },
      {
        label: "自訂需求",
        value: "自訂需求",
        description: "在後續備註填寫完整內容",
      },
    ];
  }
  return [
    {
      label: "一般項目",
      value: "一般項目",
      description: "一般服務",
    },
  ];
}
async function handleNewOrderGameSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_game_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  const game = interaction.values[0];

  pending.game = game;
  await pendingNewOrders.set(flowId, pending);
  if (game === "打賞禮物") {
    await pendingNewOrders.delete(flowId);
    if (!paymentHelpers.startTipFlowInChannel) {
      return interaction.update({
        content:
          "❌ 打賞流程尚未接入，請確認 index.js 的 dispatchSystem.setup 有傳 startTipFlowInChannel。",
        components: [],
      });
    }
    await paymentHelpers.startTipFlowInChannel(
      interaction.channel,
      interaction.user
    );
    return interaction.update({
      content: "💝 已切換為打賞流程，請在下方選擇要打賞的禮物。",
      components: [],
    });
  }
  const menu = buildNewOrderItemMenu(flowId, game);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content: `🎮 已選擇：${game}\n\n` + `請選擇你要的項目：`,
    components: [row, buildOrderBackRow(flowId, "game")],
  });
}
function getValorantRankOptions() {
  return [
    {
      label: "金牌含以下",
      value: "金牌含以下",
      description: "Gold and below",
    },
    {
      label: "白金",
      value: "白金",
      description: "Platinum",
    },
    {
      label: "鑽石",
      value: "鑽石",
      description: "Diamond",
    },
    {
      label: "超凡入聖",
      value: "超凡入聖",
      description: "Ascendant",
    },
    {
      label: "神話",
      value: "神話",
      description: "Immortal",
    },
    {
      label: "輻能戰魂",
      value: "輻能戰魂",
      description: "Radiant",
    },
    {
      label: "不指定 / 尚未確認",
      value: "不指定",
      description: "由客服協助確認",
    },
  ];
}
function isValorantRankGameBased(rank) {
  const value = String(rank || "");

  return (
    value.includes("白金") ||
    value.includes("鑽石") ||
    value.includes("超凡") ||
    value.includes("神話") ||
    value.includes("輻能")
  );
}
async function handleNewOrderItemSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_item_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.item = interaction.values[0];
  await pendingNewOrders.set(flowId, pending);
  if (pending.game === "特戰英豪") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_rank_${flowId}`)
      .setPlaceholder("請選擇要打的段位")
      .addOptions(getValorantRankOptions());
    const row = new ActionRowBuilder().addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請選擇這次要打的段位：`,
      components: [row, buildOrderBackRow(flowId, "item")],
    });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_count_${flowId}`)
    .setPlaceholder("請選擇需要幾位陪陪")
    .addOptions([
      {
        label: "1 位陪陪",
        value: "1",
        description: "單陪",
      },
      {
        label: "2 位陪陪",
        value: "2",
        description: "雙陪",
      },
      {
        label: "3 位陪陪",
        value: "3",
        description: "三陪",
      },
      {
        label: "自訂",
        value: "custom",
        description: "由客服協助確認人數",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [row, buildOrderBackRow(flowId, "item")],
  });
}
async function handleNewOrderRankSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_rank_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.rank = interaction.values[0];
  await pendingNewOrders.set(flowId, pending);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_count_${flowId}`)
    .setPlaceholder("請選擇需要幾位陪陪")
    .addOptions([
      {
        label: "1 位陪陪",
        value: "1",
        description: "單陪",
      },
      {
        label: "2 位陪陪",
        value: "2",
        description: "雙陪",
      },
      {
        label: "3 位陪陪",
        value: "3",
        description: "三陪",
      },
      {
        label: "自訂",
        value: "custom",
        description: "由客服協助確認人數",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      `🏅 段位：${pending.rank || "未填寫"}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [row, buildOrderBackRow(flowId, "rank")],
  });
}
async function handleNewOrderCountSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_count_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.playerCount =
    interaction.values[0] === "custom" ? 0 : Number(interaction.values[0]);

  await pendingNewOrders.set(flowId, pending);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "男陪",
        value: "男陪",
        description: "只看男陪",
      },
      {
        label: "女陪",
        value: "女陪",
        description: "只看女陪",
      },
      {
        label: "男女皆可",
        value: "男女皆可",
        description: "男陪女陪都可以",
      },
      {
        label: "不指定",
        value: "不指定",
        description: "不限制性別",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n\n` +
      `請選擇陪陪性別偏好：`,
    components: [row, buildOrderBackRow(flowId, "count")],
  });
}
async function handleNewOrderGenderSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_gender_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.gender = interaction.values[0];
  pending.selectedPlayerType = "none";
  pending.selectedPlayerId = null;
  pending.selectedPlayerIds = [];
  await pendingNewOrders.set(flowId, pending);
  return showDurationSelect(interaction, flowId, pending);
}
async function handleNewOrderPlayerSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_player_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  const selectedValues = interaction.values || [];
  if (selectedValues.includes("none")) {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
  await pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  }
  const onlineIds = selectedValues
    .filter((value) => value.startsWith("online_"))
    .map((value) => value.replace("online_", ""));
  const reserveIds = selectedValues
    .filter((value) => value.startsWith("reserve_"))
    .map((value) => value.replace("reserve_", ""));
  const selectedIds = [...onlineIds, ...reserveIds]
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (!selectedIds.length) {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
  await pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  }
  pending.selectedPlayerIds = selectedIds;
  pending.selectedPlayerId = selectedIds[0];
  if (reserveIds.length > 0) {
    pending.selectedPlayerType = "reserve";
  await pendingNewOrders.set(flowId, pending);
    let reserveQuery = supabase
      .from("qiunai_staff")
      .select("*")
      .in("discord_id", reserveIds);
    reserveQuery = applyStaffGuildFilter(reserveQuery);
    const { data: players } = await reserveQuery;
    const availableText =
      (players || [])
        .map((player) => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join("\n") || "未填寫可接時間";
    const modal = new ModalBuilder()
      .setCustomId(`submit_new_order_reserve_time_${flowId}`)
      .setTitle("填寫預約時間");
    const reserveInput = new TextInputBuilder()
      .setCustomId("reserve_time")
      .setLabel("請輸入想預約的時間")
      .setPlaceholder("例如：今晚 20:00、明天 21:30、週六晚上")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reserveInput));
    return await interaction.showModal(modal);
  }
  pending.selectedPlayerType = "online";
  await pendingNewOrders.set(flowId, pending);
  return await showDurationSelect(interaction, flowId, pending);
}
async function showDurationSelect(interaction, flowId, pending) {
  const valorantCompanionRank = pending.game === "特戰英豪"
    ? getValorantMappedCompanionRank(pending.item, pending.rank)
    : null;
  const isValorantGameBased = Boolean(valorantCompanionRank) &&
    getValorantExpectedUnit({
      serviceType: pending.rank,
      rankOrMap: valorantCompanionRank,
    }) === "局";
  const options = isValorantGameBased
    ? [
        {
          label: "1 局",
          value: "game_1",
          description: "以局數計算",
        },
        {
          label: "3 局",
          value: "game_3",
          description: "以局數計算",
        },
        {
          label: "5 局",
          value: "game_5",
          description: "以局數計算",
        },
        {
          label: "自訂局數",
          value: "game_custom",
          description: "由客服協助確認局數",
        },
      ]
    : [
        {
          label: "30 分鐘",
          value: "30",
          description: "半小時",
        },
        {
          label: "60 分鐘",
          value: "60",
          description: "一小時",
        },
        {
          label: "90 分鐘",
          value: "90",
          description: "一小時半",
        },
        {
          label: "120 分鐘",
          value: "120",
          description: "兩小時",
        },
        {
          label: "自訂",
          value: "custom",
          description: "由客服協助確認時間",
        },
      ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_duration_${flowId}`)
    .setPlaceholder(isValorantGameBased ? "請選擇局數" : "請選擇時間段")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      (isValorantGameBased ? `請選擇需要的局數：` : `請選擇需要的時間段：`),
    components: [row, buildOrderBackRow(flowId, "gender")],
  });
}
async function handleNewOrderDurationSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_duration_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  const value = interaction.values[0];
  const valorantCompanionRank = pending.game === "特戰英豪"
    ? getValorantMappedCompanionRank(pending.item, pending.rank)
    : null;
  const isValorantGameBased = Boolean(valorantCompanionRank) &&
    getValorantExpectedUnit({
      serviceType: pending.rank,
      rankOrMap: valorantCompanionRank,
    }) === "局";
  if (isValorantGameBased) {
    if (value === "game_custom") {
      pending.duration = "自訂局數";
      pending.durationMinutes = 0;
      pending.gameCount = 0;
    } else {
      const count = Number(value.replace("game_", ""));
      pending.duration = `${count} 局`;
      pending.durationMinutes = 0;
      pending.gameCount = count;
    }
  } else {
    if (value === "custom") {
      pending.duration = "自訂";
      pending.durationMinutes = 0;
    } else {
      pending.duration = `${value} 分鐘`;
      pending.durationMinutes = Number(value);
    }
    pending.gameCount = 0;
  }
  await pendingNewOrders.set(flowId, pending);
  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function submitNewOrderReserveTime(interaction) {
  const flowId = interaction.customId.replace(
    "submit_new_order_reserve_time_",
    ""
  );

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個表單。",
      flags: 64,
    });
  }

  const reserveTime = interaction.fields.getTextInputValue("reserve_time");

  pending.reservedTime = reserveTime;
  pending.duration = "預約";
  pending.durationMinutes = 0;
  await pendingNewOrders.set(flowId, pending);

  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function askNewOrderNoteChoice(interaction, flowId, pending) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`new_order_note_yes_${flowId}`)
      .setLabel("填寫備註並確認下單")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`new_order_note_no_${flowId}`)
      .setLabel("無備註，確認下單")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`new_order_back_duration_${flowId}`)
      .setLabel("⬅️ 上一步")
      .setStyle(ButtonStyle.Secondary)
  );

  const timeText = pending.duration;

  const payload = {
    content:
      `📝 請確認需求；你可以填寫備註後下單，或直接以「無備註」確認下單。\n\n` +
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      `🕒 時間：${timeText || "未填寫"}\n\n` +
      `不填則預設為：無`,
    components: [row],
  };

  if (interaction.isModalSubmit()) {
    return interaction.reply({
      ...payload,
      flags: 64,
    });
  }

  return interaction.update(payload);
}
async function handleNewOrderBack(interaction) {
  const raw = interaction.customId.replace("new_order_back_", "");

  const firstUnderscore = raw.indexOf("_");

  const target = raw.slice(0, firstUnderscore);

  const flowId = raw.slice(firstUnderscore + 1);

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.reply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      flags: 64,
    });
  }

  if (target === "game") {
    pending.game = "";
    pending.item = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    const menu = buildNewOrderGameMenu(flowId);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content: "🎮 請重新選擇你要下單的遊戲 / 服務：",
      components: [row],
    });
  }

  if (target === "item") {
    pending.item = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    const options = getOrderItemOptions(pending.game)
      .slice(0, 25)
      .map((item) => ({
        label: item.label.slice(0, 100),
        description: item.description.slice(0, 100),
        value: item.value,
      }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_item_${flowId}`)
      .setPlaceholder("請選擇項目")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content: `🎮 遊戲：${pending.game}\n\n` + `請重新選擇你要的項目：`,
      components: [row, buildOrderBackRow(flowId, "game")],
    });
  }
  if (target === "rank") {
    pending.rank = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_rank_${flowId}`)
      .setPlaceholder("請選擇要打的段位")
      .addOptions(getValorantRankOptions());
    const row = new ActionRowBuilder().addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請重新選擇這次要打的段位：`,
      components: [row, buildOrderBackRow(flowId, "item")],
    });
  }
  if (target === "count") {
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_count_${flowId}`)
      .setPlaceholder("請選擇需要幾位陪陪")
      .addOptions([
        {
          label: "1 位陪陪",
          value: "1",
          description: "單陪",
        },
        {
          label: "2 位陪陪",
          value: "2",
          description: "雙陪",
        },
        {
          label: "3 位陪陪",
          value: "3",
          description: "三陪",
        },
        {
          label: "自訂",
          value: "custom",
          description: "由客服協助確認人數",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        (pending.game === "特戰英豪"
          ? `🏅 段位：${pending.rank || "未填寫"}\n`
          : "") +
        `請重新選擇需要幾位陪陪：`,
      components: [
        row,
        buildOrderBackRow(
          flowId,
          pending.game === "特戰英豪" ? "rank" : "item"
        ),
      ],
    });
  }

  if (target === "gender") {
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_gender_${flowId}`)
      .setPlaceholder("請選擇陪陪性別偏好")
      .addOptions([
        {
          label: "男陪",
          value: "男陪",
          description: "只看男陪",
        },
        {
          label: "女陪",
          value: "女陪",
          description: "只看女陪",
        },
        {
          label: "男女皆可",
          value: "男女皆可",
          description: "男陪女陪都可以",
        },
        {
          label: "不指定",
          value: "不指定",
          description: "不限制性別",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || "自訂"}\n\n` +
        `請重新選擇陪陪性別偏好：`,
      components: [row, buildOrderBackRow(flowId, "count")],
    });
  }

  if (target === "player") {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    const playerOptions = await getQualifiedPlayerOptions(pending);

    if (!playerOptions.length) {
      return interaction.update({
        content:
          `🎮 遊戲：${pending.game}\n` +
          `📌 項目：${pending.item}\n` +
          `👥 人數：${pending.playerCount || "自訂"}\n` +
          `🚻 性別偏好：${pending.gender}\n\n` +
          `❌ 目前沒有符合資格的陪陪，請聯繫客服協助安排。`,
        components: [buildOrderBackRow(flowId, "gender")],
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_player_${flowId}`)
      .setPlaceholder("請選擇陪陪，或選擇不指定")
      .addOptions(playerOptions);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || "自訂"}\n` +
        `🚻 性別偏好：${pending.gender}\n\n` +
        `請重新選擇陪陪：`,
      components: [row, buildOrderBackRow(flowId, "gender")],
    });
  }

  if (target === "duration") {
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

    return await showDurationSelect(interaction, flowId, pending);
  }

  return interaction.reply({
    content: "❌ 找不到上一個步驟",
    flags: 64,
  });
}
async function openNewOrderNoteModal(interaction) {
  const flowId = interaction.customId.replace("new_order_note_yes_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個按鈕。",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_new_order_note_${flowId}`)
    .setTitle("填寫需求備註");

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("請輸入備註")
    .setPlaceholder("例如：希望語音、不要太吵、指定風格、特殊需求")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  return interaction.showModal(modal);
}
async function handleNewOrderNoNote(interaction) {
  const flowId = interaction.customId.replace("new_order_note_no_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.editReply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      components: [],
    });
  }

  pending.note = "無";
  await pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(interaction, flowId, pending);
}
async function submitNewOrderNote(interaction) {
  const flowId = interaction.customId.replace("submit_new_order_note_", "");

  const pending = await pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.reply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      flags: 64,
    });
  }

  const note = interaction.fields.getTextInputValue("note") || "無";

  pending.note = note;
  await pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(interaction, flowId, pending);
}

function buildManualQuoteDispatchComponents(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`manual_quote_dispatch_${orderId}`)
        .setLabel("確認報價並正式派單")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`manual_quote_cancel_${orderId}`)
        .setLabel("取消訂單")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function sendManualQuoteDispatchPrompt(channel, order, { quotedBy = null } = {}) {
  const price = Number(order.final_price || order.price || 0);
  return channel.send({
    content: `<@${order.customer_id}> 報價已完成，請確認後正式派單。`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💰 報價完成｜等待正式派單")
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
          `報價金額：NT$${price.toLocaleString("zh-TW")}\n` +
          (quotedBy ? `報價客服：<@${quotedBy}>\n` : "系統已依現行價目表自動報價。\n") +
          `\n按下「確認報價並正式派單」後，系統會依遊戲送到對應派單區並建立討論串。\n` +
          `選定接單陪陪後，才會進入優惠券與付款流程。`,
        )
        .setTimestamp(),
    ],
    components: buildManualQuoteDispatchComponents(order.id),
  });
}

async function confirmManualQuoteAndDispatch(interaction) {
  await deferReplyOnce(interaction);
  const orderId = interaction.customId.replace("manual_quote_dispatch_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order || !isManualDispatchOrder(order)) {
    return interaction.editReply({ content: "❌ 找不到這張人工下單需求。" });
  }
  if (!canCustomerOrStaffSubmit(interaction, order.customer_id)) {
    return interaction.editReply({ content: "❌ 只有下單者、客服或管理員可以確認正式派單。" });
  }
  if (order.paid) {
    return interaction.editReply({ content: "❌ 這張訂單已經付款，不能重新派單。" });
  }
  if (getClaimDispatchStatuses(order).includes(order.quote_status) || order.preferred_player) {
    return interaction.editReply({ content: "⚠️ 這張訂單已正式派出，請使用原本的討論串。" });
  }
  if (order.quote_status !== "quoted" || Number(order.final_price || order.price || 0) <= 0) {
    return interaction.editReply({ content: "❌ 這張訂單尚未完成報價。" });
  }
  const dispatchAtIso = new Date().toISOString();
  const dispatchNote = `${String(order.note || "").replace(/\[DISPATCH_AT:[^\]]+\]/g, "").trim()} [DISPATCH_AT:${dispatchAtIso}]`;
  const { data: dispatchOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      status: "pending",
      quote_status: "manual_dispatching",
      confirmed_by_customer: true,
      preferred_player: null,
      note: dispatchNote,
      updated_at: dispatchAtIso,
    })
    .eq("id", order.id)
    .eq("quote_status", "quoted")
    .eq("paid", false)
    .select()
    .maybeSingle();
  if (updateError || !dispatchOrder) {
    return interaction.editReply({ content: "⚠️ 訂單狀態已更新，請勿重複操作。" });
  }
  try {
    await sendSelfServiceDispatch(dispatchOrder);
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return interaction.editReply({ content: "✅ 已正式派單，等待陪陪登記接單。" });
  } catch (dispatchError) {
    await supabase
      .from("play_orders")
      .update({ quote_status: "quoted", status: "quoted", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("quote_status", "manual_dispatching");
    return interaction.editReply({ content: `❌ 正式派單失敗：${dispatchError.message || dispatchError}` });
  }
}

async function cancelManualQuotedOrder(interaction) {
  await deferReplyOnce(interaction);
  const orderId = interaction.customId.replace("manual_quote_cancel_", "");
  const { data: order } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (!order || !isManualDispatchOrder(order)) {
    return interaction.editReply({ content: "❌ 找不到這張人工下單需求。" });
  }
  if (!canCustomerOrStaffSubmit(interaction, order.customer_id)) {
    return interaction.editReply({ content: "❌ 只有下單者、客服或管理員可以取消。" });
  }
  const { data: cancelled, error } = await supabase
    .from("play_orders")
    .update({ status: "cancelled", quote_status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("paid", false)
    .in("quote_status", ["quoted", "waiting_quote"])
    .select("id")
    .maybeSingle();
  if (error || !cancelled) return interaction.editReply({ content: "⚠️ 訂單已進入下一階段，無法重複取消。" });
  await interaction.message?.edit({ components: [] }).catch(() => null);
  return interaction.editReply({ content: "✅ 已取消尚未派出的訂單。" });
}

async function createWaitingQuoteOrder(interaction, flowId, pending) {
  const orderNo = await getNextPlayOrderNumber();
  const guildId = pending.guildId || interaction.guildId || interaction.guild?.id || process.env.GUILD_ID;
  const serviceFlowKey = `general_quote:${flowId}`;

  const service = `${pending.game}｜${pending.item}`;

  const timeText = pending.duration;
  const autoQuote = getGeneralOrderAutoQuote(pending);
  const autoPrice = autoQuote.ok ? Number(autoQuote.quote.total) : 0;

  let { data: order, error } = await supabase
    .from("play_orders")
    .insert({
      guild_id: guildId,
      service_flow_key: serviceFlowKey,
      order_no: orderNo,
      customer_id: pending.userId,
      customer_username: pending.username || interaction.user.username,
      channel_id: pending.channelId || interaction.channel.id,

      game: pending.game,
      order_item: pending.item,
      rank_preference: pending.rank || null,
      player_count: pending.playerCount || 0,
      gender_preference: pending.gender,
      preferred_player_type: "none",

      service,
      preferred_player: null,
      reserved_player: null,
      reserved_time: null,

      duration_minutes: pending.durationMinutes || 0,
      duration_text: timeText || "未填寫",

      note: `${pending.note || "無"} [MANUAL_DISPATCH]`.trim(),
      price: autoPrice,
      final_price: autoPrice,
      original_price: autoPrice,
      discount_rate: 1,
      discount_amount: 0,
      payment_method: "未選擇",
      paid: false,

      status: autoQuote.ok ? "quoted" : "waiting_quote",
      quote_status: autoQuote.ok ? "quoted" : "waiting_quote",
      confirmed_by_customer: false,
    })
    .select()
    .single();

  if (error?.code === "23505") {
    const existing = await supabase.from("play_orders").select("*")
      .eq("guild_id", guildId)
      .eq("service_flow_key", serviceFlowKey)
      .maybeSingle();
    if (!existing.error && existing.data?.customer_id === pending.userId &&
        existing.data?.channel_id === (pending.channelId || interaction.channel.id) &&
        !existing.data?.paid && ["quoted", "waiting_quote"].includes(existing.data?.status)) {
      order = existing.data;
      error = null;
    }
  }

  if (error || !order) {
    console.error("[新下單] 建立待報價訂單失敗", error);
    const payload = {
      content:
        "❌ 建立訂單失敗，請檢查 Supabase play_orders 欄位是否完整。\n" +
        `錯誤：${error?.message || "未知錯誤"}`,
      components: [],
    };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload).catch(async () => {
        return interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return interaction.update(payload).catch(async () => {
        return interaction
          .reply({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
    return interaction
      .reply({
        ...payload,
        flags: 64,
      })
      .catch(() => {});
  }
  await pendingNewOrders.delete(flowId).catch((closeError) =>
    console.error("[新下單] 訂單已建立，但關閉草稿失敗", closeError),
  );

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle(autoQuote.ok ? "🧾 已送出需求｜系統自動報價完成" : "🧾 已送出需求｜等待客服報價")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no,
        inline: true,
      },
      {
        name: "🎮 遊戲 / 服務",
        value: pending.game,
        inline: true,
      },
      {
        name: "📦 項目",
        value: pending.item,
        inline: true,
      },
      {
        name: "🏅 段位",
        value: pending.rank || "不指定",
        inline: true,
      },
      {
        name: "👥 陪陪人數",
        value: String(pending.playerCount || "自訂"),
        inline: true,
      },
      {
        name: "🚻 性別偏好",
        value: pending.gender || "不指定",
        inline: true,
      },
      {
        name: "🕒 時間",
        value: timeText || "未填寫",
        inline: true,
      },
      {
        name: "📝 備註",
        value: pending.note || "無",
        inline: false,
      }
    )
    .setDescription(autoQuote.ok
      ? `系統已依現行價目表自動報價 NT$${autoPrice.toLocaleString("zh-TW")}。\n請確認報價後正式派單；選定陪陪後才會進入付款。`
      : `系統無法自動計算：${autoQuote.reason}\n已轉交客服報價；客服填寫金額後，系統會讓你選擇優惠券與付款方式。`)
    .setTimestamp();

  const payload = {
    content: autoQuote.ok
      ? `<@${pending.userId}> 系統已完成自動報價：NT$${autoPrice.toLocaleString("zh-TW")}。`
      : `<@${pending.userId}> 系統無法自動計算這個組合，已通知客服協助報價。`,
    embeds: [embed],
    components: [],
  };

  if (interaction.isModalSubmit()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    } else {
      await interaction
        .reply({
          ...payload,
          flags: 64,
        })
        .catch(() => {});
    }
  } else {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    } else {
      await interaction.update(payload).catch(async () => {
        await interaction
          .reply({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
  }
  if (autoQuote.ok) {
    await sendManualQuoteDispatchPrompt(interaction.channel, order);
  } else {
    await sendStaffQuotePanel(order);
  }
  return true;
}
async function sendStaffQuotePanel(order) {
  const channel = await client.channels
    .fetch(order.channel_id)
    .catch(() => null);

  if (!channel) {
    console.error("[新下單] 找不到訂單頻道，無法送客服報價面板");
    return;
  }

  const controls = [
    new ButtonBuilder()
      .setCustomId(`staff_quote_price_${order.id}`)
      .setLabel("客服填寫金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Primary),
  ];
  if (!isManualDispatchOrder(order) && !isManualQuoteSelfServiceOrder(order)) {
    controls.push(
      new ButtonBuilder()
        .setCustomId(`dispatch_assign_players_${order.id}`)
        .setLabel("客服選擇陪陪")
        .setEmoji("🌟")
        .setStyle(ButtonStyle.Secondary),
    );
  } else {
    controls.push(
      new ButtonBuilder()
        .setCustomId(`staff_ai_quote_${order.id}`)
        .setLabel("AI 輔助報價")
        .setEmoji("🤖")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  controls.push(
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("修改訂單內容")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Secondary),
  );
  const row = new ActionRowBuilder().addComponents(...controls);
  await channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 有新的需求等待報價。\n` +
      (isManualDispatchOrder(order)
        ? `請客服只需確認金額；老闆確認報價後，系統會自動派單選人。`
        : `請客服確認陪陪與金額後，再讓闆闆選擇付款方式。`),
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🧾 客服報價區")
        .addFields(
          {
            name: "📌 訂單編號",
            value: order.order_no || String(order.id),
            inline: true,
          },
          {
            name: "👤 客人",
            value: `<@${order.customer_id}>`,
            inline: true,
          },
          {
            name: "🎮 服務",
            value: order.service || "未填寫",
            inline: false,
          },
          {
            name: isManualQuoteSelfServiceOrder(order)
              ? `🏅 ${getSelfServiceRankFieldLabel(order)}`
              : "🏅 段位",
            value: order.rank_preference || "不指定",
            inline: true,
          },
          {
            name: "👥 人數",
            value: String(order.player_count || "自訂"),
            inline: true,
          },
          {
            name: "🚻 性別偏好",
            value: order.gender_preference || "不指定",
            inline: true,
          },
          {
            name: "🕒 時間",
            value: order.reserved_time || order.duration_text || "未填寫",
            inline: true,
          },
          {
            name: "📝 備註",
            value: getPublicOrderNote(order.note),
            inline: false,
          }
        )
        .setDescription(
          `這則訊息是客服操作用。\n` + `目前客人尚未付款，也尚未正式派單。`
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function handleStaffAiQuote(interaction) {
  await deferReplyOnce(interaction);
  if (
    !memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
    !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以使用 AI 輔助報價。",
    });
  }
  const orderId = interaction.customId.replace("staff_ai_quote_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order || !isManualQuoteSelfServiceOrder(order)) {
    return interaction.editReply({
      content: "❌ 找不到這張待人工報價的自助訂單。",
    });
  }
  if (typeof paymentHelpers.suggestCompanyAiQuote !== "function") {
    return interaction.editReply({
      content: "❌ AI 輔助報價尚未完成設定，請先由客服人工報價。",
    });
  }
  try {
    const suggestion = await paymentHelpers.suggestCompanyAiQuote({
      order,
      userId: interaction.user.id,
    });
    return interaction.editReply({ content: suggestion });
  } catch (error) {
    return interaction.editReply({
      content:
        "❌ " +
        (error.message || "AI 輔助報價暫時無法使用，請由客服人工報價。"),
    });
  }
}
async function openStaffQuotePriceModal(interaction) {
  if (
    !memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
    !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: "❌ 只有客服可以填寫報價",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("staff_quote_price_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_staff_quote_price_${orderId}`)
    .setTitle("客服填寫訂單金額");

  const priceInput = new TextInputBuilder()
    .setCustomId("price")
    .setLabel("請輸入原價金額")
    .setPlaceholder("例如：499")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  return interaction.showModal(modal);
}
async function submitStaffQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (
    !memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
    !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以填寫報價",
    });
  }

  const orderId = interaction.customId.replace("submit_staff_quote_price_", "");

  const priceText = interaction.fields.getTextInputValue("price");

  const price = Number(priceText.replace(/[^\d]/g, ""));

  if (!price || price <= 0) {
    return interaction.editReply({
      content: "❌ 金額格式錯誤，請輸入大於 0 的數字",
    });
  }

  const { data: order, error } = await supabase
    .from("play_orders")
    .update({
      price,
      final_price: price,
      original_price: price,
      quoted_by: interaction.user.id,
      quote_status: "quoted",
      status: "quoted",
    })
    .eq("id", orderId)
    .eq("paid", false)
    .in("status", ["waiting_quote", "quoted", "waiting_payment", "waiting_confirm"])
    .select()
    .single();

  if (error || !order) {
    console.error("[客服報價] 更新金額失敗", error);
    return interaction.editReply({
      content: "❌ 更新報價失敗",
    });
  }

  if (isManualDispatchOrder(order)) {
    await sendManualQuoteDispatchPrompt(interaction.channel, order, {
      quotedBy: interaction.user.id,
    });
    return interaction.editReply({
      content: `✅ 已填寫報價 NT$${price.toLocaleString("zh-TW")}，等待老闆確認正式派單。`,
    });
  }

  await sendOrderQuotePriceConfirm(interaction.channel, order);

  return interaction.editReply({
    content: `✅ 已填寫報價 NT$${price.toLocaleString("zh-TW")}`,
  });
}
async function sendOrderQuotePriceConfirm(channel, order) {
  const price = Number(order.original_price || order.price || 0);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("報價金額無效");
  await channel.send({
    content: `<@${order.customer_id}> 請確認這張訂單的報價金額。`,
    embeds: [new EmbedBuilder().setColor(QIUNAI_WATER_BLUE)
      .setTitle("💰 請顧客確認報價")
      .setDescription(`訂單編號：${order.order_no || order.id}\n金額：NT$${price.toLocaleString("zh-TW")}\n\n確認後選擇優惠券與付款方式；付款完成後才會自動派單。`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`quote_confirm_price_${order.id}_${price}`).setLabel("確認報價金額").setStyle(ButtonStyle.Success),
    )],
  });
}
async function handleOrderQuotePriceConfirm(interaction) {
  await deferReplyOnce(interaction);
  const match = /^quote_confirm_price_(.+)_(\d+)$/.exec(interaction.customId);
  if (!match) return interaction.editReply({ content: "❌ 報價確認資料無效。" });
  const [, orderId, quotedPrice] = match;
  const { data: order, error } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (error || !order) return interaction.editReply({ content: "❌ 找不到這張訂單。" });
  if (order.customer_id !== interaction.user.id) return interaction.editReply({ content: "❌ 只有下單的闆闆可以確認報價。" });
  const price = Number(order.original_price || order.price || 0);
  if (price !== Number(quotedPrice) || price <= 0) return interaction.editReply({ content: "❌ 報價已更新，請確認最新報價。" });
  if (order.quote_status === "price_confirmed") return interaction.editReply({ content: "✅ 報價已確認，請使用先前的優惠券選擇訊息。" });
  if (order.quote_status !== "quoted" || order.status !== "quoted" || order.payment_method !== "未選擇" || order.paid) {
    return interaction.editReply({ content: "❌ 訂單狀態已變更，請先確認最新訊息。" });
  }
  const { data: updated, error: updateError } = await supabase.from("play_orders")
    .update({ quote_status: "price_confirmed", updated_at: new Date().toISOString() })
    .eq("id", order.id).eq("customer_id", interaction.user.id).eq("quote_status", "quoted")
    .eq("status", "quoted").eq("payment_method", "未選擇").eq("paid", false)
    .select("id").maybeSingle();
  if (updateError || !updated) return interaction.editReply({ content: "❌ 報價狀態已變更，請重新整理。" });
  await interaction.channel.send({
    content: `<@${order.customer_id}> 已確認報價 NT$${price.toLocaleString("zh-TW")}，請選擇是否使用優惠券。`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`quote_use_coupon_${order.id}`).setLabel("使用優惠券").setEmoji("🎟️").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`quote_no_coupon_${order.id}`).setLabel("不使用優惠券").setStyle(ButtonStyle.Secondary),
    )],
  });
  await interaction.message?.edit({ components: [] }).catch(() => null);
  return interaction.editReply({ content: "✅ 已確認報價，請繼續選擇優惠券與付款方式。" });
}
async function handleQuoteNoCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  const orderId = interaction.customId.replace("quote_no_coupon_", "");

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    console.error("[報價流程] 讀取訂單失敗", orderError);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券",
    });
  }
  if (order.quote_status === "quoted") {
    await sendOrderQuotePriceConfirm(interaction.channel, order);
    return interaction.editReply({ content: "❌ 請先確認報價金額。" });
  }

  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      coupon_text: "未使用優惠券",
      discount_rate: 1,
      discount_amount: 0,
    })
    .eq("id", orderId)
    .eq("customer_id", interaction.user.id)
    .select()
    .single();

  if (updateError || !updatedOrder) {
    console.error("[報價流程] 不使用優惠券失敗", updateError);
    return interaction.editReply({
      content: "❌ 設定優惠券失敗",
    });
  }

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: "✅ 已選擇不使用優惠券",
  });
}
function getCouponDiscount(itemName = "") {
  const name = String(itemName || "");
  const fixedAmountMatch = name.match(/(\d+(?:\.\d+)?)\s*ASD\s*折價券/i);

  if (fixedAmountMatch) {
    const fixedAmount = Number(fixedAmountMatch[1]);
    return {
      rate: 1,
      fixedAmount,
      label: `折抵 ${fixedAmount.toLocaleString("zh-TW")} ASD`,
    };
  }

  if (name.includes("95折")) {
    return {
      rate: 0.95,
      label: "95折券",
    };
  }

  if (name.includes("9折")) {
    return {
      rate: 0.9,
      label: "9折券",
    };
  }

  if (name.includes("8折")) {
    return {
      rate: 0.8,
      label: "8折券",
    };
  }

  if (name.includes("7折")) {
    return {
      rate: 0.7,
      label: "7折券",
    };
  }

  if (name.includes("6折")) {
    return {
      rate: 0.6,
      label: "6折券",
    };
  }

  return {
    rate: 1,
    label: name || "未知優惠券",
  };
}
function getCouponMaxDiscountPrice(itemName = "") {
  const name = String(itemName || "");

  if (name.includes("95折")) {
    return 500;
  }

  if (name.includes("9折")) {
    return 800;
  }

  if (name.includes("8折")) {
    return 3000;
  }

  if (name.includes("7折")) {
    return 5000;
  }

  if (name.includes("6折")) {
    return 5000;
  }

  return null;
}
async function handleQuoteUseCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("quote_use_coupon_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券",
    });
  }
  if (order.quote_status === "quoted") {
    await sendOrderQuotePriceConfirm(interaction.channel, order);
    return interaction.editReply({ content: "❌ 請先確認報價金額。" });
  }

  const { data: coupons, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("user_id", interaction.user.id)
    .or("item_type.eq.coupon,item_name.ilike.%折券%,item_name.ilike.%優惠券%")
    .order("created_at", { ascending: false });

  if (couponError) {
    console.error("[報價優惠券] 讀取優惠券失敗", couponError);
    return interaction.editReply({
      content: "❌ 讀取優惠券失敗，請稍後再試",
    });
  }

  if (!coupons || coupons.length === 0) {
    return interaction.editReply({
      content: "❌ 你目前沒有可使用的優惠券。\n" + "請改選「不使用優惠券」。",
      components: [],
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`quote_select_coupon_${order.id}`)
    .setPlaceholder("請選擇要使用的優惠券")
    .addOptions(
      coupons.slice(0, 25).map((coupon) => {
        const discount = getCouponDiscount(coupon.item_name);

        return {
          label: String(coupon.item_name).slice(0, 100),
          description: `${discount.label}｜${
            coupon.description || "優惠券"
          }`.slice(0, 100),
          value: String(coupon.id),
        };
      })
    );

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.editReply({
    content:
      `🎟️ 請選擇要使用的優惠券：\n\n` +
      `訂單金額：NT$${Number(
        order.final_price || order.price || 0
      ).toLocaleString("zh-TW")}`,
    components: [row],
  });
}
async function handleQuoteSelectCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("quote_select_coupon_", "");

  const couponId = interaction.values[0];

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以使用優惠券",
    });
  }
  if (order.quote_status === "quoted") {
    await sendOrderQuotePriceConfirm(interaction.channel, order);
    return interaction.editReply({ content: "❌ 請先確認報價金額。" });
  }

  const { data: coupon, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("id", Number(couponId))
    .eq("user_id", interaction.user.id)
    .maybeSingle();
  if (
    couponError ||
    !coupon ||
    !(
      coupon.item_type === "coupon" ||
      String(coupon.item_name || "").includes("折券") ||
      String(coupon.item_name || "").includes("優惠券")
    )
  ) {
    return interaction.editReply({
      content: "❌ 找不到這張優惠券，可能已經被使用",
    });
  }

  const originalPrice = Number(
    order.original_price || order.price || order.final_price || 0
  );

  if (!originalPrice || originalPrice <= 0) {
    return interaction.editReply({
      content: "❌ 訂單金額錯誤，請聯繫客服重新報價",
    });
  }

  const maxPrice = getCouponMaxDiscountPrice(coupon.item_name);

  if (maxPrice && originalPrice > maxPrice) {
    return interaction.editReply({
      content:
        `❌ 這張優惠券只限 NT$${maxPrice} 內訂單使用。\n` +
        `目前訂單金額：NT$${originalPrice.toLocaleString("zh-TW")}`,
    });
  }

  const discount = getCouponDiscount(coupon.item_name);

  const finalPrice = discount.fixedAmount
    ? Math.max(0, originalPrice - discount.fixedAmount)
    : Math.floor(originalPrice * discount.rate);

  const discountAmount = originalPrice - finalPrice;

  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      discount_rate: discount.rate,
      discount_amount: discountAmount,
      final_price: finalPrice,
      coupon_text: coupon.item_name,
    })
    .eq("id", order.id)
    .select()
    .single();

  if (updateError || !updatedOrder) {
    console.error("[報價優惠券] 更新訂單失敗", updateError);
    return interaction.editReply({
      content: "❌ 套用優惠券失敗",
    });
  }

  // 刪除已使用優惠券
  await supabase.from("user_items").delete().eq("id", coupon.id);

  // 寫入 used_coupons，如果沒有這張表會失敗但不影響主流程
  const { error: usedCouponError } = await supabase
    .from("used_coupons")
    .insert({
      user_id: interaction.user.id,
      item_id: coupon.id,
      item_name: coupon.item_name,
      order_id: order.id,
      discount_rate: discount.rate,
      discount_amount: discountAmount,
    });
  if (usedCouponError) {
    console.log("[優惠券使用紀錄失敗]", usedCouponError.message);
  }
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("🎟️ 優惠券已套用")
        .setDescription(
          `<@${interaction.user.id}> 已使用：${coupon.item_name}\n\n` +
            `原價：NT$${originalPrice.toLocaleString("zh-TW")}\n` +
            `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
            `折後金額：NT$${finalPrice.toLocaleString("zh-TW")}`
        )
        .setTimestamp(),
    ],
  });

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: "✅ 優惠券已套用，請繼續選擇付款方式",
    components: [],
  });
}
async function sendPaymentMethodSelect(channel, order) {
  const salaryDeductionEnabled = await isActiveSalaryDeductionStaff(
    order.customer_id,
  );
  const rows = buildPaymentMethodButtonRows(
    `quote_payment_method_${order.id}`,
    getGeneralOrderPaymentOptions({
      ecpayAvailable: paymentHelpers.ecpayAvailable,
      salaryEligible: salaryDeductionEnabled,
      amount: Number(order.final_price || order.price || 0),
    }),
  );

  await channel.send({
    content: `<@${order.customer_id}> 請選擇付款方式：`,
    components: rows,
  });
}
async function handleQuotePaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "quote_payment_method_");
  const orderId = selection?.entityId;
  const paymentMethod = selection?.paymentMethod;

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇付款方式",
    });
  }
  if (order.quote_status === "quoted") {
    await sendOrderQuotePriceConfirm(interaction.channel, order);
    return interaction.editReply({ content: "❌ 請先確認報價金額。" });
  }
  if (order.paid) {
    return interaction.editReply({
      content:
        `❌ 這張訂單已經完成付款，不能重複選擇付款方式。\n` +
        `目前付款方式：${order.payment_method || "已付款"}`,
    });
  }
  if (paymentMethod === "綠界支付" && selection?.requestedMethod &&
      !isGeneralEcpayAmountAllowed(selection.requestedMethod, Number(order.final_price || order.price || 0))) {
    return interaction.editReply({ content: "❌ 此訂單金額不適用所選的綠界付款方式，請改選其他方式。" });
  }
  function isWalletPayment(text = "") {
    const value = String(text || "");
    return (
      value.includes("儲值卡") ||
      value.includes("錢包") ||
      value.includes("餘額")
    );
  }
  function isMonthlyPayment(text = "") {
    const value = String(text || "");
    return (
      value.includes("月結") ||
      value.includes("月結付款") ||
      value.includes("月結會員")
    );
  }
  if (paymentMethod === "員工扣薪" || paymentMethod === "扣薪") {
    const amount = Number(order.final_price || order.price || 0);
    try {
      const eligibility = await getSalaryDeductionEligibility(
        order.customer_id,
        amount,
      );
      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: order.customer_id,
        amount,
        eligibility,
        confirmId: `salary_quote_confirm_${order.id}`,
        cancelId: `salary_quote_cancel_${order.id}`,
        transferId: `salary_quote_transfer_${order.id}`,
      });
      return interaction.editReply({
        content: "✅ 已送出扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 無法使用扣薪付款：${err.message || err}`,
      });
    }
  }
  if (paymentMethod === "街口支付" || paymentMethod === "綠界支付") {
    const ecpay = paymentMethod === "綠界支付";
    const createPayment = ecpay ? paymentHelpers.createEcpayServicePayment : paymentHelpers.createJkopayServicePayment;
    if (!(ecpay ? paymentHelpers.ecpayAvailable : paymentHelpers.jkopayAvailable) || !createPayment)
      return interaction.editReply({ content: `❌ ${paymentMethod}目前無法使用，請改選其他付款方式。` });
    const amount = Number(order.final_price || order.price || 0);
    try {
      const payment = await createPayment({
        kind: "order",
        entityKey: String(order.id),
        userId: order.customer_id,
        amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${order.order_no || order.id}`,
        metadata: { flow: "quote", orderIds: [order.id], orderNo: order.order_no || null },
      });
      const { error: updateError } = await supabase
        .from("play_orders")
        .update({ payment_method: paymentMethod, status: "waiting_payment", updated_at: new Date().toISOString() })
        .eq("id", order.id)
        .eq("paid", false);
      if (updateError) throw updateError;
      if (ecpay && selection?.requestedMethod) {
        payment.onlyMethod = selection.requestedMethod;
        if (selection.requestedMethod !== "CARD") payment.preferredMethod = selection.requestedMethod;
      }
      await (ecpay ? sendEcpayPaymentPrompt : sendJkopayPaymentPrompt)(interaction.channel, order.customer_id, amount, payment, "訂單");
      return interaction.editReply({ content: `✅ 已建立${paymentMethod}付款連結，付款完成後會自動核帳。` });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立${paymentMethod}付款失敗：${err.message || err}` });
    }
  }
  let paidNow = false;
  let paidAt = null;
  if (isWalletPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByWallet) {
        throw new Error("錢包付款函式尚未接入 dispatchSystem");
      }
      const result = await paymentHelpers.payOrderByWallet(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#66ccff")
            .setTitle("💳 儲值卡 / 錢包付款完成")
            .setDescription(
              `<@${order.customer_id}> 已使用儲值卡 / 錢包付款。\n\n` +
                `扣款金額：${result.amount} 星雨幣\n` +
                `剩餘餘額：${result.finalCoins} 星雨幣`
            )
            .setTimestamp(),
        ],
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 儲值卡付款失敗：${err.message}`,
      });
    }
  } else if (isMonthlyPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByMonthly) {
        throw new Error("月結付款函式尚未接入 dispatchSystem");
      }
      const result = await paymentHelpers.payOrderByMonthly(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#66ccff")
            .setTitle("🌙 月結付款完成")
            .setDescription(
              `<@${order.customer_id}> 已使用月結付款。\n\n` +
                `本筆金額：NT$${result.amount}\n` +
                `本筆回饋：${result.cashback} 星雨幣\n` +
                `剩餘月結額度：NT$${result.availableAmount}`
            )
            .setTimestamp(),
        ],
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 月結付款失敗：${err.message}`,
      });
    }
  }
  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      payment_method: paymentMethod,
      status: paidNow ? "waiting_confirm" : "waiting_payment",
      paid: paidNow ? true : order.paid,
      paid_at: paidNow ? paidAt : order.paid_at,
    })
    .eq("id", order.id)
    .select()
    .single();
  if (updateError || !updatedOrder) {
    console.error("[報價流程] 更新付款方式失敗", updateError);
    return interaction.editReply({
      content: "❌ 更新付款方式失敗",
    });
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    paymentMethod.includes("美金") ||
    paymentMethod.includes("加密貨幣")
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${order.customer_id}> 你選擇了：${paymentMethod}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }
  await sendCustomerFinalConfirm(interaction.channel, updatedOrder);
  if (!paidNow) {
    await interaction.channel.send({
      content: `<@&${process.env.STAFF_ROLE}> 請客服確認此訂單是否已付款`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`staff_confirm_order_paid_${order.id}`)
            .setLabel("客服確認已付款")
            .setStyle(ButtonStyle.Success)
        ),
      ],
    });
  }
  return interaction.editReply({
    content: `✅ 已選擇付款方式：${paymentMethod}`,
  });
}

async function handleSalaryQuoteConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認扣薪付款。",
    });
  }

  const orderId = interaction.customId.replace("salary_quote_confirm_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    return interaction.editReply({ content: "❌ 找不到這張訂單。" });
  }
  if (order.paid) {
    return interaction.editReply({ content: "❌ 這張訂單已完成付款。" });
  }

  const amount = Number(order.final_price || order.price || 0);
  let paymentCompleted = false;
  try {
    const result = await applySalaryDeductionToOrders({
      customerId: order.customer_id,
      amount,
      orderIds: [order.id],
      finalStatus: "waiting_confirm",
    });
    paymentCompleted = true;

    const paidOrder = result.orders[0];
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 扣薪付款完成")
          .setDescription(
            `<@${order.customer_id}> 已使用薪資支付 NT$${amount.toLocaleString("zh-TW")}。\n` +
              `EIP 已新增扣項：使用薪水點單\n` +
              `由 <@${interaction.user.id}> 確認。`,
          )
          .setTimestamp(),
      ],
    });
    await sendCustomerFinalConfirm(interaction.channel, paidOrder);
    return interaction.editReply({
      content: "✅ 已確認扣薪付款，EIP 扣項已建立。",
    });
  } catch (err) {
    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 扣薪與 EIP 扣項已完成，但通知訊息發送失敗：${err.message || err}`
        : `❌ 扣薪付款失敗：${err.message || err}`,
    });
  }
}

async function handleSalaryQuoteCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消扣薪付款。",
    });
  }

  const orderId = interaction.customId.replace("salary_quote_cancel_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    return interaction.editReply({ content: "❌ 找不到這張訂單。" });
  }
  if (order.paid) {
    return interaction.editReply({ content: "❌ 這張訂單已完成付款。" });
  }

  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendPaymentMethodSelect(interaction.channel, order);
  return interaction.editReply({
    content: "✅ 已取消扣薪付款，請員工重新選擇付款方式。",
  });
}

async function handleSalaryQuoteTransfer(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({ content: "❌ 只有客服或管理員可以選擇差額轉帳。" });
  }

  const orderId = interaction.customId.replace("salary_quote_transfer_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order || order.paid) {
    return interaction.editReply({ content: "❌ 找不到未付款的訂單。" });
  }

  const amount = Number(order.final_price || order.price || 0);
  const eligibility = await getSalaryDeductionEligibility(order.customer_id, amount);
  const salaryAmount = Math.min(amount, Math.max(0, eligibility.state.availableBefore));
  const transferAmount = amount - salaryAmount;
  if (transferAmount <= 0) {
    return interaction.editReply({ content: "❌ 目前薪資已足夠，請直接按確認使用扣薪。" });
  }

  await supabase
    .from("play_orders")
    .update({ payment_method: "扣薪＋轉帳", status: "waiting_payment" })
    .eq("id", order.id)
    .eq("paid", false);
  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendBankTransferInfo(interaction.channel);
  await interaction.channel.send({
    content:
      `<@${order.customer_id}> 本筆將從薪資扣除 NT$${salaryAmount.toLocaleString("zh-TW")}，` +
      `請另行轉帳 NT$${transferAmount.toLocaleString("zh-TW")}。\n` +
      `收到轉帳明細後，請客服確認差額已入帳。`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`salary_quote_split_confirm_${order.id}_${salaryAmount}`)
          .setLabel("確認差額已入帳")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
  return interaction.editReply({ content: "✅ 已改為扣薪加轉帳補齊差額。" });
}

async function handleSalaryQuoteSplitConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({ content: "❌ 只有客服或管理員可以確認差額入帳。" });
  }
  const match = interaction.customId.match(/^salary_quote_split_confirm_(.+)_(\d+(?:\.\d+)?)$/);
  if (!match) return interaction.editReply({ content: "❌ 差額付款資料錯誤。" });
  const [, orderId, salaryText] = match;
  const salaryAmount = Number(salaryText);
  const { data: order, error } = await supabase.from("play_orders").select("*").eq("id", orderId).maybeSingle();
  if (error || !order || order.paid) return interaction.editReply({ content: "❌ 找不到未付款的訂單。" });
  const amount = Number(order.final_price || order.price || 0);
  if (salaryAmount < 0 || salaryAmount >= amount) return interaction.editReply({ content: "❌ 差額付款金額錯誤。" });

  let paidOrder;
  if (salaryAmount > 0) {
    const result = await applySalaryDeductionToOrders({
      customerId: order.customer_id,
      amount: salaryAmount,
      orderIds: [order.id],
      finalStatus: "waiting_confirm",
      paymentMethod: "扣薪＋轉帳",
    });
    paidOrder = result.orders[0];
  } else {
    const { data, error: updateError } = await supabase
      .from("play_orders")
      .update({ payment_method: "轉帳補齊差額", paid: true, paid_at: new Date().toISOString(), status: "waiting_confirm" })
      .eq("id", order.id)
      .eq("paid", false)
      .select("*")
      .single();
    if (updateError) throw updateError;
    paidOrder = data;
  }

  await interaction.message.edit({ components: [] }).catch(() => null);
  await interaction.channel.send({
    embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ 扣薪＋轉帳付款完成").setDescription(
      `<@${order.customer_id}> 本筆共 NT$${amount.toLocaleString("zh-TW")}。\n` +
      `薪資扣除：NT$${salaryAmount.toLocaleString("zh-TW")}\n` +
      `轉帳補齊：NT$${(amount - salaryAmount).toLocaleString("zh-TW")}\n` +
      `確認客服：<@${interaction.user.id}>`,
    ).setTimestamp()],
  });
  await sendCustomerFinalConfirm(interaction.channel, paidOrder);
  return interaction.editReply({ content: "✅ 已確認差額入帳並完成付款。" });
}
async function sendCustomerFinalConfirm(channel, order) {
  if (order.paid && order.quote_status === "price_confirmed") {
    try {
      const { error: statusError } = await supabase.from("play_orders")
        .update({ status: "pending", quote_status: "dispatched", dispatch_status: "pending", dispatch_last_error: null, updated_at: new Date().toISOString() })
        .eq("id", order.id).eq("paid", true).eq("quote_status", "price_confirmed");
      if (statusError) throw statusError;
      const dispatchOrder = await markPaidOrderDispatchPending(order.id);
      const result = await deliverPaidOrder(dispatchOrder, channel?.isTextBased?.() ? channel : null);
      await channel?.send?.({
        content: `<@${order.customer_id}> ✅ 報價已確認、付款已完成，訂單${result.alreadyDispatched ? "已派單" : "已自動送往指定派單區"}。`,
      });
    } catch (error) {
      console.error(`[報價確認後派單] ${order.order_no || order.id} 待補派`, error);
      await channel?.send?.({ content: `<@${order.customer_id}> ✅ 付款已完成，不需要重複付款；派單正在自動補發，請客服查看。` })?.catch(() => null);
    }
    return;
  }
  const preferredText = buildPreferredPlayerText(order.preferred_player);

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("📋 請確認訂單資訊")
    .setDescription(
      `<@${order.customer_id}> 請確認以下訂單資訊是否正確。\n\n` +
        `確認後，系統才會正式發送派單資訊。`
    )
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || String(order.id),
        inline: true,
      },
      {
        name: "🎮 遊戲 / 服務",
        value: order.game || order.service || "未填寫",
        inline: true,
      },
      {
        name: "📦 項目",
        value: order.order_item || "未填寫",
        inline: true,
      },
      {
        name: "👥 人數",
        value: String(order.player_count || "自訂"),
        inline: true,
      },
      {
        name: "🚻 性別偏好",
        value: order.gender_preference || "不指定",
        inline: true,
      },
      {
        name: "🌟 陪陪",
        value: preferredText,
        inline: true,
      },
      {
        name: "🕒 時間",
        value: order.reserved_time || order.duration_text || "未填寫",
        inline: true,
      },
      {
        name: "💰 金額",
        value: `NT$${Number(
          order.final_price || order.price || 0
        ).toLocaleString("zh-TW")}`,
        inline: true,
      },
      {
        name: "🎟️ 優惠券",
        value: order.coupon_text || "未使用優惠券",
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未選擇",
        inline: true,
      },
      {
        name: "📝 備註",
        value: getPublicOrderNote(order.note),
        inline: false,
      }
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customer_confirm_order_${order.id}`)
      .setLabel("確認正確")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`customer_order_wrong_${order.id}`)
      .setLabel("內容有誤")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`extend_order_${order.id}`)
      .setLabel("➕ 加時 / 續單")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}
async function transitionServicePayment(interaction, prefix, group, action) {
  await deferReplyOnce(interaction);
  if (!memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
      !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "❌ 只有客服可以操作訂單付款或取消。" });
  }
  const target = interaction.customId.replace(prefix, "");
  let orders = await transitionUnpaidOrders(supabase, {
    orderId: group ? null : target, groupId: group ? target : null,
    guildId: interaction.guildId || interaction.guild?.id || process.env.GUILD_ID, action,
  });
  if (!orders.length) {
    let repairQuery = supabase
      .from("play_orders")
      .select("*")
      .eq("guild_id", interaction.guildId || interaction.guild?.id || process.env.GUILD_ID);
    repairQuery = group ? repairQuery.eq("order_group_id", target) : repairQuery.eq("id", target);
    const { data: existingOrders, error: repairError } = await repairQuery;
    if (repairError) throw repairError;
    const paidCandidates = (existingOrders || []).filter(
      (order) =>
        order.paid &&
        order.dispatch_status !== "dispatched" &&
        !["cancelled", "completed", "accepted"].includes(order.status),
    );
    orders = action === "confirm"
      ? await Promise.all(
          paidCandidates.map((order) =>
            !["pending", "processing", "failed"].includes(order.dispatch_status)
              ? markPaidOrderDispatchPending(order.id)
              : order,
          ),
        )
      : [];
    if (!orders.length) {
      await interaction.message?.edit({ components: [] }).catch(() => null);
      return interaction.editReply({ content: "這筆訂單已付款、已取消或狀態已更新，沒有重複處理。已付款訂單請使用退款流程。" });
    }
  }
  if (action === "cancel") {
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return interaction.editReply({ content: "✅ 已取消未付款訂單。" });
  }
  if (action === "confirm_waiting") {
    await interaction.message?.edit({ components: [] }).catch(() => null);
    if (orders[0].quote_status === "price_confirmed") {
      await sendCustomerFinalConfirm(interaction.channel, orders[0]);
      return interaction.editReply({ content: "✅ 已確認付款，系統已啟動自動派單。" });
    }
    await interaction.channel.send({ content: `✅ 已由 <@${interaction.user.id}> 確認付款。<@${orders[0].customer_id}> 現在可以按「確認正確」送出派單。` });
    return interaction.editReply({ content: "✅ 已標記為已付款。" });
  }
  for (const order of orders) {
    await paymentHelpers.countOrderVipSpentOnce?.(order, "客服確認訂單付款完成");
    await deliverPaidOrder(order, interaction.channel);
  }
  await interaction.message?.edit({ components: [] }).catch(() => null);
  return interaction.editReply({ content: "✅ 已確認付款並派單，原付款按鈕已關閉。" });
}

async function handleStaffConfirmOrderPaid(interaction) {
  return transitionServicePayment(interaction, "staff_confirm_order_paid_", false, "confirm_waiting");
}

function shouldPreserveDispatchedOrder(order) {
  return (
    Boolean(order?.assigned_player) &&
    ["pending", "accepted", "completed"].includes(order?.status)
  );
}

async function handleCustomerConfirmOrder(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("customer_confirm_order_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.error("[闆闆確認訂單] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, order.customer_id)) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆、客服或管理員可以確認訂單",
    });
  }

  if (!Number(order.final_price || order.price || 0)) {
    return interaction.editReply({
      content: "❌ 這張訂單尚未填寫金額，請等待客服報價",
    });
  }

  if (!order.payment_method || order.payment_method === "未選擇") {
    return interaction.editReply({
      content: "❌ 這張訂單尚未選擇付款方式",
    });
  }
  if (!order.paid) {
    return interaction.editReply({
      content: "❌ 尚未由客服確認付款，請付款後等待客服確認。",
    });
  }

  if (shouldPreserveDispatchedOrder(order)) {
    const { error: confirmEditError } = await supabase
      .from("play_orders")
      .update({
        confirmed_by_customer: true,
        quote_status: "dispatched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
    if (confirmEditError) {
      console.error("[闆闆確認修改內容] 更新失敗", confirmEditError);
      return interaction.editReply({
        content: "❌ 確認修改內容失敗，請稍後再試",
      });
    }

    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      content:
        `✅ <@${order.customer_id}> 已確認客服修改後的訂單內容正確。\n` +
        `原訂單進度與已接單陪陪維持不變。`,
    });
    return interaction.editReply({
      content: "✅ 已確認修改後的訂單內容正確",
    });
  }

  if (isManualQuoteSelfServiceOrder(order)) {
    if (order.quote_status === "self_dispatching" || order.preferred_player) {
      return interaction.editReply({
        content: "⚠️ 這張訂單已送出自助派單，請勿重複操作。",
      });
    }
    const dispatchAtIso = new Date().toISOString();
    const dispatchNote = `${stripSelfServiceClaimNotes(
      String(order.note || "").replace(/\[DISPATCH_AT:[^\]]+\]/g, ""),
    )} [DISPATCH_AT:${dispatchAtIso}]`.trim();
    const { data: dispatchOrder, error: dispatchUpdateError } = await supabase
      .from("play_orders")
      .update({
        status: "pending",
        quote_status: "self_dispatching",
        confirmed_by_customer: true,
        preferred_player: null,
        note: dispatchNote,
        updated_at: dispatchAtIso,
      })
      .eq("id", order.id)
      .eq("paid", true)
      .eq("quote_status", order.quote_status)
      .select()
      .single();
    if (dispatchUpdateError || !dispatchOrder) {
      console.error("[客服報價自助派單] 更新訂單失敗", dispatchUpdateError);
      return interaction.editReply({ content: "❌ 送出自助派單失敗，請稍後再試。" });
    }
    try {
      await sendSelfServiceDispatch(dispatchOrder);
    } catch (dispatchError) {
      console.error("[客服報價自助派單] 發送失敗", dispatchError);
      await supabase
        .from("play_orders")
        .update({ quote_status: "waiting_confirm", updated_at: new Date().toISOString() })
        .eq("id", order.id)
        .eq("quote_status", "self_dispatching");
      return interaction.editReply({
        content: `❌ ${dispatchError.message || dispatchError}`,
      });
    }
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send(
      "✅ 客服報價款項已完成核帳，訂單已送往自助派單廳；老闆選定陪陪後會直接發送報單，不會再次扣款。",
    );
    return interaction.editReply({ content: "✅ 已確認並送出自助派單。" });
  }

  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      status: "pending",
      quote_status: "dispatched",
      dispatch_status: "pending",
      dispatch_last_error: null,
      confirmed_by_customer: true,
    })
    .eq("id", order.id)
    .select()
    .single();

  if (updateError || !updatedOrder) {
    console.error("[闆闆確認訂單] 更新失敗", updateError);
    return interaction.editReply({
      content: "❌ 確認訂單失敗，請稍後再試",
    });
  }

  await deliverPaidOrder(updatedOrder, interaction.channel);
  await interaction.message.edit({ components: [] }).catch(() => null);

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 訂單已確認，已送出派單")
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
            `闆闆：<@${updatedOrder.customer_id}>\n\n` +
            `系統已將此單送到員工接單區，請等待陪陪接單。`
        )
        .setTimestamp(),
    ],
  });

  await sendPlayLog({
    title: "✅ 訂單已確認並派單",
    description:
      `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
      `闆闆：<@${updatedOrder.customer_id}>\n` +
      `服務：${updatedOrder.service || "未填寫"}\n` +
      `金額：NT$${updatedOrder.final_price || updatedOrder.price || 0}`,
    color: "#57F287",
  });

  return interaction.editReply({
    content: "✅ 訂單已確認，已正式派單",
  });
}
async function handleCustomerOrderWrong(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  const orderId = interaction.customId.replace("customer_order_wrong_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以回報內容有誤",
    });
  }

  const preserveDispatch = shouldPreserveDispatchedOrder(order);
  await supabase
    .from("play_orders")
    .update(
      preserveDispatch
        ? { quote_status: "need_fix", updated_at: new Date().toISOString() }
        : {
            quote_status: "need_fix",
            status: "quoted",
            updated_at: new Date().toISOString(),
          },
    )
    .eq("id", order.id);

  const staffFixRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("客服修改訂單內容")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`change_order_price_${order.id}`)
      .setLabel("修改金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary)
  );
  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 闆闆回報訂單內容有誤，請客服協助修改。\n` +
      `訂單編號：${order.order_no || order.id}`,
    components: [staffFixRow],
  });
  return interaction.editReply({
    content: "✅ 已通知客服協助修改訂單內容",
  });
}
async function openStaffEditOrderModal(interaction) {
  const orderId = interaction.customId.replace("staff_edit_order_", "");

  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: "❌ 只有客服可以修改訂單",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_staff_edit_order_${orderId}`)
    .setTitle("客服修改訂單內容");

  const serviceInput = new TextInputBuilder()
    .setCustomId("service")
    .setLabel("服務項目")
    .setPlaceholder("例如：特戰英豪 技術陪玩")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const timeInput = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("時間 / 局數")
    .setPlaceholder("例如：3局、60分鐘、今晚22:00")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註 / 需求")
    .setPlaceholder("要修改的備註內容")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  const playerCountInput = new TextInputBuilder()
    .setCustomId("player_count")
    .setLabel("陪陪數量")
    .setPlaceholder("例如：1、2、3；不改就留空")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  const preferredPlayerInput = new TextInputBuilder()
    .setCustomId("preferred_player")
    .setLabel("指定陪陪 / 不指定")
    .setPlaceholder("輸入 不指定，或貼上陪陪 Discord ID / @陪陪")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(noteInput),
    new ActionRowBuilder().addComponents(preferredPlayerInput),
    new ActionRowBuilder().addComponents(playerCountInput)
  );

  return interaction.showModal(modal);
}
async function submitStaffEditOrder(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("submit_staff_edit_order_", "");

  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以修改訂單",
    });
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (currentOrderError || !currentOrder) {
    return interaction.editReply({ content: "❌ 找不到這張訂單" });
  }

  const service = interaction.fields.getTextInputValue("service") || "";

  const time = interaction.fields.getTextInputValue("time") || "";

  const note = interaction.fields.getTextInputValue("note") || "";

  const preferredPlayerRaw =
    interaction.fields.getTextInputValue("preferred_player") || "";
  const playerCountRaw =
    interaction.fields.getTextInputValue("player_count") || "";
  const preserveDispatch = shouldPreserveDispatchedOrder(currentOrder);
  const updateData = preserveDispatch
    ? {}
    : { quote_status: "fixed", status: "quoted" };
  if (playerCountRaw.trim()) {
    const playerCount = Number(playerCountRaw.replace(/[^\d]/g, ""));
    if (!playerCount || playerCount <= 0) {
      return interaction.editReply({
        content: "❌ 陪陪數量格式錯誤，請輸入 1、2、3 這種數字",
      });
    }
    updateData.player_count = playerCount;
  }
  if (preferredPlayerRaw.trim()) {
    const raw = preferredPlayerRaw.trim();
    if (raw === "不指定" || raw === "無" || raw.toLowerCase() === "none") {
      updateData.preferred_player = null;
      updateData.preferred_player_type = "none";
      updateData.reserved_player = null;
      updateData.dispatch_type = null;
    } else {
      const playerIds = raw
        .split(/[\s,，、]+/)
        .map((text) =>
          text
            .replace(/[<@!>]/g, "")
            .replace(/[^0-9]/g, "")
            .trim()
        )
        .filter(Boolean);
      if (playerIds.length) {
        updateData.preferred_player = playerIds.join(",");
        updateData.preferred_player_type = "online";
        updateData.reserved_player = null;
        updateData.dispatch_type = "preferred";
        if (
          !updateData.player_count ||
          Number(updateData.player_count) < playerIds.length
        ) {
          updateData.player_count = playerIds.length;
        }
      }
    }
  }
  if (service.trim()) {
    updateData.service = service.trim();
  }

  if (time.trim()) {
    updateData.reserved_time = time.trim();
    updateData.duration_text = time.trim();
  }

  if (note.trim()) {
    updateData.note = note.trim();
  }

  const { data: updatedOrder, error } = await supabase
    .from("play_orders")
    .update(updateData)
    .eq("id", orderId)
    .select()
    .single();

  if (error || !updatedOrder) {
    console.error("[客服修改訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 修改訂單失敗，請查看後台 Logs",
    });
  }
  try {
    await workReportSystem.syncAcceptedOrder(updatedOrder);
  } catch (syncError) {
    console.error("[客服修改訂單] 同步填單失敗", syncError);
    return interaction.editReply({
      content:
        "⚠️ 訂單已修改，但同步陪陪填單失敗，請查看 Railway Logs 後再操作。",
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customer_confirm_order_${updatedOrder.id}`)
      .setLabel("確認正確")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`customer_order_wrong_${updatedOrder.id}`)
      .setLabel("內容有誤")
      .setEmoji("⚠️")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🛠️ 訂單內容已由客服修改")
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
            `闆闆：<@${updatedOrder.customer_id}>\n\n` +
            `🎮 服務：${updatedOrder.service || "未填寫"}\n` +
            `🌟 指定陪陪：${
              updatedOrder.preferred_player
                ? buildPreferredPlayerText(updatedOrder.preferred_player)
                : "不指定"
            }\n` +
            `🕒 時間 / 局數：${
              updatedOrder.reserved_time ||
              updatedOrder.duration_text ||
              "未填寫"
            }\n` +
            `💰 金額：NT$${
              updatedOrder.final_price || updatedOrder.price || 0
            }\n` +
            `💳 付款方式：${updatedOrder.payment_method || "未選擇"}\n` +
            `📝 備註：${updatedOrder.note || "無"}\n\n` +
            `請闆闆重新確認訂單內容。`
        )
        .setTimestamp(),
    ],
    components: [row],
  });

  return interaction.editReply({
    content: preserveDispatch
      ? "✅ 已修改訂單並重新送出確認，原訂單與既有陪陪填單已同步更新"
      : "✅ 已修改訂單，並重新送出給闆闆確認",
  });
}
async function openExtendOrderModal(interaction) {
  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: "❌ 只有客服可以建立加時",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("extend_order_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_extend_order_${orderId}`)
    .setTitle("建立加時 / 續單");

  const textInput = new TextInputBuilder()
    .setCustomId("extension_text")
    .setLabel("加時內容")
    .setPlaceholder("例如：30分鐘、1局、3局、續聊1小時")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("加時金額")
    .setPlaceholder("例如：150")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註")
    .setPlaceholder("例如：客人要求延長，陪陪同意")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(textInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  return interaction.showModal(modal);
}
async function submitExtendOrder(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以建立加時",
    });
  }

  const orderId = interaction.customId.replace("submit_extend_order_", "");

  const extensionText = interaction.fields.getTextInputValue("extension_text");

  const amountText = interaction.fields.getTextInputValue("amount");

  const note = interaction.fields.getTextInputValue("note") || "";

  const amount = Number(amountText.replace(/[^\d]/g, ""));

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 加時金額格式錯誤，請輸入大於 0 的數字",
    });
  }

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    console.error("[加時] 找不到原訂單", orderError);
    return interaction.editReply({
      content: "❌ 找不到原訂單",
    });
  }

  const { data: extension, error: insertError } = await supabase
    .from("order_extensions")
    .insert({
      order_id: order.id,
      order_no: order.order_no || null,
      customer_id: order.customer_id,
      channel_id: order.channel_id || interaction.channel.id,
      staff_id: interaction.user.id,
      extension_text: extensionText,
      amount,
      payment_method: "未選擇",
      paid: false,
      status: "pending",
      applied_to_salary: false,
      note,
    })
    .select()
    .single();

  if (insertError || !extension) {
    console.error(
      "[加時] 建立加時失敗完整錯誤",
      JSON.stringify(insertError, null, 2)
    );
    return interaction.editReply({
      content:
        "❌ 建立加時失敗\n" +
        `錯誤訊息：${insertError?.message || "未知錯誤"}\n` +
        `錯誤代碼：${insertError?.code || "無"}\n` +
        `詳細資訊：${insertError?.details || "無"}\n` +
        `提示：${insertError?.hint || "無"}`,
    });
  }

  await sendExtensionPaymentMethodSelect(interaction.channel, extension);

  return interaction.editReply({
    content:
      `✅ 已建立加時：${extensionText}\n` +
      `金額：NT$${amount.toLocaleString("zh-TW")}`,
  });
}
async function sendExtensionPaymentMethodSelect(channel, extension) {
  const salaryDeductionEnabled = await isActiveSalaryDeductionStaff(
    extension.customer_id,
  );
  const rows = buildPaymentMethodButtonRows(
    `extension_payment_method_${extension.id}`,
    getCanonicalPaymentOptions({
      includeWallet: true,
      includeEcpay: paymentHelpers.ecpayAvailable,
      includeMonthly: true,
      includeSalary: salaryDeductionEnabled,
    }),
  );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("➕ 加時付款")
        .setDescription(
          `<@${extension.customer_id}> 請選擇加時付款方式。\n\n` +
            `原訂單：${extension.order_no || extension.order_id}\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount || 0).toLocaleString(
              "zh-TW"
            )}`
        )
        .setTimestamp(),
    ],
    components: rows,
  });
}
async function handleExtensionPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "extension_payment_method_");
  const extensionId = selection?.entityId;
  const paymentMethod = selection?.paymentMethod;

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .single();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到加時資料",
    });
  }

  if (extension.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有這筆訂單的闆闆可以選擇付款方式",
    });
  }

  const amount = Number(extension.amount || 0);

  if (extension.paid) {
    return interaction.editReply({
      content: "⚠️ 這筆加時已經付款過了，不能重複選擇付款方式。",
    });
  }

  if (paymentMethod === "扣薪") {
    try {
      const eligibility = await getSalaryDeductionEligibility(
        extension.customer_id,
        amount,
      );
      if (!eligibility.state.canUse) {
        return interaction.editReply({
          content:
            `❌ 無法使用扣薪付款：每人最多預支 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}。\n` +
            `本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過上限。`,
        });
      }

      const { data: updatedExtension, error: updateError } = await supabase
        .from("order_extensions")
        .update({
          payment_method: "扣薪",
          status: "waiting_salary_confirm",
          updated_at: new Date().toISOString(),
        })
        .eq("id", extension.id)
        .or("paid.eq.false,paid.is.null")
        .select("id")
        .maybeSingle();
      if (updateError || !updatedExtension) {
        throw new Error(updateError?.message || "這筆加時已付款或狀態已變更");
      }

      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: extension.customer_id,
        amount,
        eligibility,
        confirmId: `salary_extension_confirm_${extension.id}`,
        cancelId: `salary_extension_cancel_${extension.id}`,
        purpose: "續單",
      });
      return interaction.editReply({
        content: "✅ 已送出續單扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 無法使用續單扣薪付款：${err.message || err}`,
      });
    }
  }

  if (paymentMethod === "街口支付" || paymentMethod === "綠界支付") {
    const ecpay = paymentMethod === "綠界支付";
    const createPayment = ecpay ? paymentHelpers.createEcpayServicePayment : paymentHelpers.createJkopayServicePayment;
    if (!(ecpay ? paymentHelpers.ecpayAvailable : paymentHelpers.jkopayAvailable) || !createPayment)
      return interaction.editReply({ content: `❌ ${paymentMethod}目前無法使用，請改選其他付款方式。` });
    try {
      const payment = await createPayment({
        kind: "extension",
        entityKey: String(extension.id),
        userId: extension.customer_id,
        amount,
        channelId: interaction.channel.id,
        description: `訂單加時 ${extension.order_no || extension.order_id}`,
        metadata: { extensionId: extension.id, orderId: extension.order_id, orderNo: extension.order_no || null },
      });
      const { error: updateError } = await supabase
        .from("order_extensions")
        .update({ payment_method: paymentMethod, status: "waiting_payment", updated_at: new Date().toISOString() })
        .eq("id", extension.id)
        .or("paid.eq.false,paid.is.null");
      if (updateError) throw updateError;
      if (ecpay) payment.preferredMethod = selection?.requestedMethod;
      await (ecpay ? sendEcpayPaymentPrompt : sendJkopayPaymentPrompt)(interaction.channel, extension.customer_id, amount, payment, "加時");
      return interaction.editReply({ content: `✅ 已建立加時${paymentMethod}付款連結，付款完成後會自動核帳。` });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立街口付款失敗：${err.message || err}` });
    }
  }

  if (paymentMethod === "月結") {
    if (!paymentHelpers.payExtensionByMonthly) {
      return interaction.editReply({ content: "❌ 月結付款功能尚未完成設定。" });
    }

    const paidAt = new Date().toISOString();
    const { data: reservedExtension, error: reserveError } = await supabase
      .from("order_extensions")
      .update({
        payment_method: "月結",
        status: "processing_monthly",
        updated_at: paidAt,
      })
      .eq("id", extension.id)
      .or("paid.eq.false,paid.is.null")
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (reserveError || !reservedExtension) {
      return interaction.editReply({
        content: "❌ 這筆加時付款狀態已變更，請重新確認。",
      });
    }

    try {
      const result = await paymentHelpers.payExtensionByMonthly(
        reservedExtension,
      );
      const { data: paidExtension, error: updateError } = await supabase
        .from("order_extensions")
        .update({
          payment_method: "月結",
          paid: true,
          status: "paid",
          paid_at: paidAt,
          updated_at: paidAt,
        })
        .eq("id", extension.id)
        .eq("status", "processing_monthly")
        .select("*")
        .maybeSingle();
      if (updateError || !paidExtension) {
        throw new Error(updateError?.message || "更新加時付款狀態失敗");
      }

      await recordPaidExtensionConsumption(
        paidExtension,
        `續單月結付款 ${paidExtension.order_no || paidExtension.order_id}`,
      );
      await paymentHelpers.recordAccountingLedger?.({
        entry_type: "customer_extension_monthly",
        entry_label: "客人消費",
        amount,
        revenue_amount: amount,
        receivable_amount: amount,
        payment_method: "月結",
        customer_id: extension.customer_id,
        order_id: extension.order_id || extension.order_no || null,
        order_no: extension.order_no || null,
        source_table: "order_extensions",
        source_id: String(extension.id),
        dedupe_key: `order_extensions:${extension.id}:customer_extension_monthly`,
        note: `加時 ${extension.extension_text || ""}`.trim(),
      });

      let salaryResult = null;
      try {
        salaryResult = await applyExtensionToPlayOrder(paidExtension);
      } catch (salaryError) {
        console.error("[加時月結] 寫入薪資網失敗", salaryError);
      }

      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#57F287")
            .setTitle("✅ 加時月結付款完成")
            .setDescription(
              `原訂單：${extension.order_no || extension.order_id}\n` +
                `闆闆：<@${extension.customer_id}>\n` +
                `加時內容：${extension.extension_text}\n` +
                `本筆金額：NT$${amount.toLocaleString("zh-TW")}\n` +
                `本筆回饋：${Number(result.cashback || 0).toLocaleString("zh-TW")} 星雨幣\n` +
                `剩餘月結額度：NT$${Number(result.availableAmount || 0).toLocaleString("zh-TW")}` +
                (salaryResult
                  ? `\n薪資網金額已更新為 NT$${salaryResult.newPrice.toLocaleString("zh-TW")}`
                  : ""),
            )
            .setTimestamp(),
        ],
      });
      return interaction.editReply({ content: "✅ 已使用月結完成加時付款。" });
    } catch (err) {
      await supabase
        .from("order_extensions")
        .update({
          payment_method: null,
          status: "waiting_payment",
          updated_at: new Date().toISOString(),
        })
        .eq("id", extension.id)
        .eq("status", "processing_monthly");
      return interaction.editReply({
        content: `❌ 加時月結付款失敗：${err.message || err}`,
      });
    }
  }

  // 儲值卡直接扣款
  if (paymentMethod.includes("儲值卡")) {
    await supabase
      .from("order_extensions")
      .update({
        payment_method: paymentMethod,
        status: "waiting_wallet_confirm",
        updated_at: new Date().toISOString(),
      })
      .eq("id", extension.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_extension_wallet_${extension.id}`)
        .setLabel("確認使用儲值卡付款")
        .setEmoji("💳")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cancel_extension_wallet_${extension.id}`)
        .setLabel("取消此付款方式")
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({
      content: `<@${extension.customer_id}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(QIUNAI_WATER_BLUE)
          .setTitle("💳 確認加時儲值卡付款")
          .setDescription(
            `請確認是否使用儲值卡 / 錢包付款。\n\n` +
              `原訂單：${extension.order_no || extension.order_id}\n` +
              `加時內容：${extension.extension_text}\n` +
              `扣款金額：${Number(extension.amount || 0).toLocaleString(
                "zh-TW"
              )} ASD\n\n` +
              `確認後會直接從你的 ASD 餘額扣款。`
          )
          .setTimestamp(),
      ],
      components: [row],
    });
    return interaction.editReply({
      content: "✅ 已選擇儲值卡付款，請闆闆確認是否使用此付款方式。",
    });
  }
  const { data: updatedExtension, error: updateError } = await supabase
    .from("order_extensions")
    .update({
      payment_method: paymentMethod,
      status: "waiting_payment",
    })
    .eq("id", extension.id)
    .select()
    .single();

  if (updateError || !updatedExtension) {
    console.error("[加時] 更新付款方式失敗", updateError);
    return interaction.editReply({
      content: "❌ 更新加時付款方式失敗",
    });
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    paymentMethod.includes("美金") ||
    paymentMethod.includes("加密貨幣")
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${extension.customer_id}> 你選擇了：${paymentMethod}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }

  await interaction.channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 請客服確認這筆加時是否已付款`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`staff_confirm_extension_paid_${extension.id}`)
          .setLabel("客服確認加時已付款")
          .setStyle(ButtonStyle.Success)
      ),
    ],
  });

  return interaction.editReply({
    content: `✅ 已選擇加時付款方式：${paymentMethod}`,
  });
}

async function handleSalaryExtensionConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認續單扣薪付款。",
    });
  }

  const extensionId = interaction.customId.replace(
    "salary_extension_confirm_",
    "",
  );
  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .maybeSingle();
  if (error || !extension) {
    return interaction.editReply({ content: "❌ 找不到這筆加時資料。" });
  }
  if (extension.paid) {
    return interaction.editReply({ content: "❌ 這筆加時已完成付款。" });
  }
  if (extension.payment_method !== "扣薪") {
    return interaction.editReply({
      content: "❌ 這筆加時目前不是扣薪付款，請重新選擇付款方式。",
    });
  }

  const amount = Number(extension.amount || 0);
  if (!amount || amount <= 0) {
    return interaction.editReply({ content: "❌ 加時金額錯誤。" });
  }

  const paymentKey = `salary:${extension.customer_id}`;
  if (processingSalaryPayments.has(paymentKey)) {
    return interaction.editReply({
      content: "❌ 這位員工目前有另一筆扣薪付款正在處理，請稍後再試。",
    });
  }
  processingSalaryPayments.add(paymentKey);

  let adjustmentId = null;
  let paymentCompleted = false;
  try {
    const adjustment = await createSalaryDeductionAdjustment(
      extension.customer_id,
      amount,
      `使用薪水續單：${extension.extension_text || "加時"}`,
    );
    adjustmentId = adjustment.adjustmentId;

    const paidAt = new Date().toISOString();
    const { data: updatedExtension, error: updateError } = await supabase
      .from("order_extensions")
      .update({
        payment_method: "扣薪",
        paid: true,
        status: "paid",
        paid_at: paidAt,
        updated_at: paidAt,
      })
      .eq("id", extension.id)
      .or("paid.eq.false,paid.is.null")
      .select("*")
      .maybeSingle();
    if (updateError || !updatedExtension) {
      await supabase
        .from("qiunai_staff_bonus")
        .delete()
        .eq("id", adjustmentId);
      adjustmentId = null;
      throw new Error(updateError?.message || "這筆加時已付款或狀態已變更");
    }
    paymentCompleted = true;

    await recordPaidExtensionConsumption(
      updatedExtension,
      `續單扣薪付款 ${updatedExtension.order_no || updatedExtension.order_id}`,
    );

    let salaryResult = null;
    try {
      salaryResult = await applyExtensionToPlayOrder(updatedExtension);
    } catch (salaryError) {
      console.error("[秋奈加時扣薪確認] 寫入薪資網失敗", salaryError);
      await interaction.channel.send({
        content:
          `⚠️ 續單扣薪已完成，但陪陪薪資金額更新失敗。\n` +
          `錯誤：${salaryError.message || salaryError}`,
      });
    }

    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 續單扣薪付款完成")
          .setDescription(
            `原訂單：${extension.order_no || extension.order_id}\n` +
              `闆闆：<@${extension.customer_id}>\n` +
              `加時內容：${extension.extension_text}\n` +
              `加時金額：NT$${amount.toLocaleString("zh-TW")}\n` +
              `付款方式：員工扣薪\n` +
              `秋奈 EIP 已新增扣項：使用薪水續單\n` +
              `確認客服：<@${interaction.user.id}>` +
              (salaryResult
                ? `\n\n已更新薪資網金額：NT$${salaryResult.oldPrice.toLocaleString("zh-TW")} → NT$${salaryResult.newPrice.toLocaleString("zh-TW")}`
                : ""),
          )
          .setTimestamp(),
      ],
    });
    return interaction.editReply({
      content: "✅ 已確認續單扣薪付款並建立秋奈 EIP 扣項。",
    });
  } catch (err) {
    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 續單扣薪與 EIP 扣項已完成，但通知失敗：${err.message || err}`
        : `❌ 續單扣薪付款失敗：${err.message || err}`,
    });
  } finally {
    processingSalaryPayments.delete(paymentKey);
  }
}

async function handleSalaryExtensionCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消續單扣薪付款。",
    });
  }

  const extensionId = interaction.customId.replace(
    "salary_extension_cancel_",
    "",
  );
  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .maybeSingle();
  if (error || !extension) {
    return interaction.editReply({ content: "❌ 找不到這筆加時資料。" });
  }
  if (extension.paid) {
    return interaction.editReply({ content: "❌ 這筆加時已完成付款。" });
  }

  const { data: updatedExtension, error: updateError } = await supabase
    .from("order_extensions")
    .update({
      payment_method: null,
      status: "waiting_payment",
      updated_at: new Date().toISOString(),
    })
    .eq("id", extension.id)
    .or("paid.eq.false,paid.is.null")
    .select("id")
    .maybeSingle();
  if (updateError || !updatedExtension) {
    return interaction.editReply({
      content: `❌ 取消續單扣薪失敗：${updateError?.message || "狀態已變更"}`,
    });
  }

  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendExtensionPaymentMethodSelect(interaction.channel, extension);
  return interaction.editReply({
    content: "✅ 已取消續單扣薪付款，請員工重新選擇付款方式。",
  });
}
async function handleConfirmExtensionWallet(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const extensionId = interaction.customId.replace(
    "confirm_extension_wallet_",
    ""
  );

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .maybeSingle();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到這筆加時資料",
    });
  }

  if (interaction.user.id !== extension.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單闆闆可以確認加時儲值卡付款",
    });
  }

  const amount = Number(extension.amount || 0);

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 加時金額錯誤",
    });
  }

  // 扣 ASD、寫 wallet_logs、標記加時付款及把金額併回原訂單，全部在
  // 同一個資料庫 transaction 完成。重按或兩台機器同時處理只會扣一次。
  const { data: paymentResult, error: paymentError } = await supabase.rpc(
    "qiunai_pay_extension_with_wallet",
    {
      p_extension_id: String(extension.id),
      p_customer_id: String(extension.customer_id),
    },
  );
  if (paymentError || !paymentResult) {
    console.error("[加時儲值卡確認] 原子付款失敗", paymentError);
    return interaction.editReply({
      content:
        `❌ 儲值卡扣款失敗。\n` +
        `可能是 ASD 餘額不足、加時已使用其他方式付款，或錢包系統異常。\n` +
        `錯誤：${paymentError?.message || "未取得付款結果"}`,
    });
  }

  const paidExtension = paymentResult.extension || extension;
  const updatedOrder = paymentResult.order;
  const finalCoins = Number(paymentResult.balance || 0);
  const alreadyProcessed = Boolean(paymentResult.already_processed);

  if (!updatedOrder) {
    return interaction.editReply({
      content: "⚠️ ASD 扣款狀態已保存，但讀取加時後訂單失敗；請保留此按鈕重試，系統不會重複扣款。",
    });
  }

  try {
    // 報單以 EXT id 去重；若程序在 RPC 付款後中斷，重試只會補發缺少的報單。
    await workReportSystem.sendForPaidExtension(paidExtension, updatedOrder);
  } catch (reportError) {
    console.error("[\u52a0\u6642\u5132\u503c\u5361\u78ba\u8a8d] 付款已完成，報單待補發", reportError);
    return interaction.editReply({
      content:
        `⚠️ ASD 扣款與加時金額已完成，本次不會再扣款；` +
        `陪陪報單尚未完整發出，請保留原按鈕重試：${reportError.message || reportError}`,
    });
  }

  if (!alreadyProcessed) {
    // wallet_logs 已由 RPC 寫入；此處只發送 Discord 私訊，不重複落表。
    await paymentHelpers.sendWalletLog?.(
      extension.customer_id,
      "加時扣款",
      -amount,
      finalCoins,
      `加時 ${extension.extension_text}｜原訂單 ${
        extension.order_no || extension.order_id
      }`,
      false,
    );
  }

  await recordPaidExtensionConsumption(
    paidExtension,
    `續單儲值卡付款 ${paidExtension.order_no || paidExtension.order_id}`,
  );

  await paymentHelpers.recordAccountingLedger?.({
    entry_type: "customer_extension_wallet",
    entry_label: "客人消費",
    amount,
    revenue_amount: amount,
    liability_amount: -amount,
    payment_method: "儲值卡 / 錢包",
    customer_id: extension.customer_id,
    order_id: extension.order_id || extension.order_no || null,
    order_no: extension.order_no || null,
    source_table: "order_extensions",
    source_id: String(extension.id),
    dedupe_key: `order_extensions:${extension.id}:customer_extension_wallet`,
    note: `加時 ${extension.extension_text || ""}`.trim(),
  });

  const salaryResult = {
    oldPrice: Number(paymentResult.old_price ?? 0),
    newPrice: Number(paymentResult.new_price ?? 0),
  };

  if (alreadyProcessed) {
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return interaction.editReply({
      content: "✅ 這筆加時先前已完成 ASD 扣款與薪資金額更新，本次沒有重複扣款。",
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 加時儲值卡付款完成")
        .setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${amount.toLocaleString("zh-TW")}\n` +
            `付款方式：儲值卡\n` +
            `扣款後餘額：${Number(finalCoins || 0).toLocaleString(
              "zh-TW"
            )} ASD` +
            `\n\n已更新薪資網金額：NT$${salaryResult.oldPrice.toLocaleString(
              "zh-TW",
            )} → NT$${salaryResult.newPrice.toLocaleString("zh-TW")}`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content: "✅ 已確認使用儲值卡完成加時付款",
  });
}
async function handleStaffConfirmExtensionPaid(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認加時付款",
    });
  }

  const extensionId = interaction.customId.replace(
    "staff_confirm_extension_paid_",
    ""
  );

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .single();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到加時資料",
    });
  }

  if (extension.paid) {
    return interaction.editReply({
      content: "⚠️ 這筆加時已經確認付款過了",
    });
  }

  const { data: paidExtension, error: updateError } = await supabase
    .from("order_extensions")
    .update({
      paid: true,
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("id", extension.id)
    .or("paid.eq.false,paid.is.null")
    .neq("status", "cancelled")
    .select("*")
    .maybeSingle();
  if (updateError || !paidExtension) {
    return interaction.editReply({ content: "加時付款狀態已更新或確認失敗，未重複處理。" });
  }
  await recordPaidExtensionConsumption(
    paidExtension,
    `續單客服確認付款 ${paidExtension.order_no || paidExtension.order_id}`,
  );
  await interaction.message?.edit({ components: [] }).catch(() => null);
  let salaryResult = null;
  try {
    salaryResult = await applyExtensionToPlayOrder(extension);
  } catch (error) {
    console.error("[加時] 寫入薪資網失敗", error);
    await interaction.channel.send({
      content:
        `⚠️ 加時已確認付款，但寫入薪資網失敗。\n` +
        `錯誤：${error.message || error}`,
    });
  }
  if (updateError) {
    console.error("[加時] 確認付款失敗", updateError);
    return interaction.editReply({
      content: "❌ 確認加時付款失敗",
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 加時付款已確認")
        .setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount || 0).toLocaleString(
              "zh-TW"
            )}\n` +
            `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content: "✅ 已確認加時付款",
  });
}
async function startNewOrderFlow(channel, user, initialGame = "") {
  const flowId = `${user.id}_${Date.now()}`;

  const allowedGame = NEW_ORDER_GAME_OPTIONS.some(
    (option) => option.value === initialGame,
  )
    ? initialGame
    : "";

  await pendingNewOrders.set(flowId, {
    userId: user.id,
    username: user.username,
    guildId: channel.guildId || channel.guild?.id || process.env.GUILD_ID,
    channelId: channel.id,

    game: allowedGame,
    item: "",
    rank: "",
    playerCount: 1,
    gender: "不指定",

    selectedPlayerType: "none",
    selectedPlayerId: null,
    selectedPlayerIds: [],
    selectedPlayerName: "",
    selectedPlayerStatus: "",

    duration: "",
    durationMinutes: 0,
    reservedTime: "",
    note: "無",
  });

  const menu = allowedGame
    ? buildNewOrderItemMenu(flowId, allowedGame)
    : buildNewOrderGameMenu(flowId, "請選擇遊戲 / 服務");

  const row = new ActionRowBuilder().addComponents(menu);

  await channel.send({
    content:
      `<@${user.id}> 歡迎使用秋奈電競點單系統。\n\n` +
      (allowedGame
        ? `已選擇：${allowedGame}\n請繼續選擇要下單的項目：`
        : `請先選擇你要下單的遊戲 / 服務：`),
    components: [row],
  });
}
async function openTopupModal(interaction, { jkopayOnly = false } = {}) {
  const modal = new ModalBuilder()
    .setCustomId(jkopayOnly ? "submit_jkopay_topup_form" : "submit_topup_form")
    .setTitle("💰 購買星雨幣");

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("購買金額")
    .setPlaceholder("例如：1000")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註")
    .setPlaceholder("沒有可填無")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}
function canEditOrderPrice(interaction) {
  return (
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE) ||
    (process.env.CUSTOMER_SERVICE_ROLE_ID &&
      memberHasRole(interaction.member, process.env.CUSTOMER_SERVICE_ROLE_ID))
  );
}

function isWalletPaymentMethod(paymentMethod) {
  const value = String(paymentMethod || "");
  return value.includes("儲值卡") || value.includes("錢包") || value.includes("餘額") || value.includes("ASD");
}

function getPaidOrderPriceAdjustment(oldPrice, newPrice) {
  const oldAmount = Number(oldPrice);
  const newAmount = Number(newPrice);
  if (!Number.isFinite(oldAmount) || !Number.isFinite(newAmount) || oldAmount < 0 || newAmount < 0) {
    throw new Error("訂單金額格式錯誤");
  }
  return { oldAmount, newAmount, difference: newAmount - oldAmount };
}

async function hasMatchingManualPriceGapDeduction(order, difference) {
  const amount = Math.abs(Number(difference || 0));
  const changedAt = new Date(order.updated_at || order.paid_at || order.created_at || 0);
  if (!amount || Number.isNaN(changedAt.getTime())) return false;
  const windowEnd = new Date(changedAt.getTime() + 30 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("wallet_logs")
    .select("id")
    .eq("user_id", order.customer_id)
    .eq("type", "管理員扣錢")
    .eq("amount", -amount)
    .gte("created_at", changedAt.toISOString())
    .lte("created_at", windowEnd)
    .limit(1);
  if (error) {
    console.error("[訂單差額] 查詢人工扣款失敗", error);
    throw new Error("無法核對既有人工扣款，已停止補扣以避免重複扣款");
  }
  return Boolean(data?.length);
}
// ===== 開啟更改訂單金額視窗 =====
async function openChangeOrderPriceModal(interaction) {
  if (!canEditOrderPrice(interaction)) {
    return interaction.reply({
      content: "❌ 你沒有權限更改訂單金額",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("change_order_price_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_change_order_price_${orderId}`)
    .setTitle("更改訂單金額");

  const priceInput = new TextInputBuilder()
    .setCustomId("new_price")
    .setLabel("請輸入新的訂單金額")
    .setPlaceholder("例如：499")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  await interaction.showModal(modal);
}
async function openSaveOrderNoteModal(interaction) {
  const orderId = interaction.customId.replace("save_order_note_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_save_order_note_${orderId}`)
    .setTitle("📝 存單內容");

  const noteInput = new TextInputBuilder()
    .setCustomId("saved_order_text")
    .setLabel("請輸入要存單的內容")
    .setPlaceholder("例如：闆闆要存單的內容")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  await interaction.showModal(modal);
}

async function openDispatchPlayerMenu(interaction) {
  const orderId = interaction.customId.replace("dispatch_assign_players_", "");

  if (
    !memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
    !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以派單",
    });
  }

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (
    !["waiting_quote", "quoted", "waiting_payment", "pending"].includes(
      order.status
    )
  ) {
    return interaction.editReply({
      content: "❌ 這張訂單目前狀態不能再選擇陪陪",
    });
  }
  const service =
    order.dispatch_service_key ||
    order.service ||
    order.order_item ||
    order.game ||
    "";

  const playerOptions = await getAvailablePlayerOptions(service);
  if (!playerOptions.length) {
    return interaction.editReply({
      content: "❌ 目前沒有可接單陪陪",
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`submit_dispatch_players_${order.id}`)
    .setPlaceholder("可多選指定陪陪")
    .setMinValues(1)
    .setMaxValues(Math.min(playerOptions.length, 10))
    .addOptions(playerOptions.slice(0, 25));

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.editReply({
    content: "🌟 請選擇要指定派單的陪陪，可多選：",
    components: [row],
  });
}

async function submitDispatchPlayers(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("submit_dispatch_players_", "");

  if (
    !memberHasRole(interaction.member, process.env.STAFF_ROLE) &&
    !interactionHasPermission(interaction, PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以派單",
      components: [],
    });
  }

  const selectedPlayerIds = interaction.values;

  const preferredPlayerValue = selectedPlayerIds.join(",");

  const { data: order, error } = await supabase
    .from("play_orders")
    .update({
      preferred_player: preferredPlayerValue,
    })
    .eq("id", orderId)
    .select()
    .single();

  if (error || !order) {
    console.log("[指定派單失敗]", error);
    return interaction.editReply({
      content: "❌ 指定派單失敗",
      components: [],
    });
  }

  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${selectedPlayerIds
        .map((id) => `<@${id}>`)
        .join("、")}\n` +
      `請繼續完成報價、優惠券與付款方式流程，等闆闆確認後才會正式派單。`,
    components: [],
  });
}

function parseTopupPresetAmount(customId) {
  const matched = String(customId || "").match(/^order_start_topup_amount_(\d+)$/);
  if (!matched) return null;
  const amount = Number(matched[1]);
  return TOPUP_PRESET_AMOUNTS.includes(amount) ? amount : null;
}

function buildTopupPaymentMethodRows(topupId) {
  return buildPaymentMethodButtonRows(
    `topup_payment_method_${topupId}`,
    getCanonicalPaymentOptions({ includeEcpay: paymentHelpers.ecpayAvailable }),
  );
}

function prepareTopupCheckout({ userId, amount, note = "無", topupNo }) {
  const topupId = `${userId}_${Date.now()}`;
  pendingTopups.set(topupId, { userId, amount, note, topupNo });
  const expiryTimer = setTimeout(() => pendingTopups.delete(topupId), 30 * 60 * 1000);
  expiryTimer.unref?.();
  return { topupId, rows: buildTopupPaymentMethodRows(topupId) };
}

async function submitTopupForm(interaction, { jkopayOnly = false } = {}) {
  await interaction.deferReply({
    flags: 64,
  });
  const amountText = interaction.fields.getTextInputValue("amount");
  let note = "無";
  try {
    note = interaction.fields.getTextInputValue("note") || "無";
  } catch {}
  // ===== 金額處理 =====
  const amount = parseInt(amountText.replace(/[^\d]/g, ""), 10);
  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 金額格式錯誤",
    });
  }
  let topupNo = getTopupNumberFromTopic(interaction.channel?.topic);
  if (!topupNo) {
    topupNo = await getNextTopupNumber(supabase);
    const safeName = interaction.user.username
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
      .slice(0, 10);
    await interaction.channel
      ?.edit({
        name: `購買-${topupNo.toLowerCase()}-${safeName}`.slice(0, 90),
        topic: buildTopupTopic(interaction.user.id, topupNo),
      })
      .catch(() => {});
  }
  if (jkopayOnly) {
    if (!paymentHelpers.jkopayAvailable || !paymentHelpers.createJkopayTopup) {
      return interaction.editReply({ content: "❌ 街口支付目前無法使用，請稍後再試。", components: [] });
    }
    try {
      await createJkopayTopupPaymentMessage({
        channel: interaction.channel,
        userId: interaction.user.id,
        amount,
        topupNo,
      });
      return interaction.editReply({
        content: `✅ 已建立街口付款單。\n訂單編號：${topupNo}\n購買金額：NT$${amount.toLocaleString("zh-TW")}\n請使用頻道中的按鈕完成付款。`,
        components: [],
      });
    } catch (error) {
      return interaction.editReply({ content: `❌ 街口付款單建立失敗：${error.message || error}`, components: [] });
    }
  }

  const { rows } = prepareTopupCheckout({ userId: interaction.user.id, amount, note, topupNo });

  return interaction.editReply({
    content:
      `訂單編號：${topupNo}\n` +
      `✅ 購買金額：NT$${amount}\n` +
      `📝 備註：${note}\n\n` +
      `請繼續選擇付款方式：`,
    components: rows,
  });
}

async function createJkopayTopupPaymentMessage({ channel, userId, amount, topupNo }) {
  const payment = await paymentHelpers.createJkopayTopup({
    userId,
    amount,
    topupNo,
    channelId: channel.id,
  });
  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("街口支付｜購買星雨幣")
    .setDescription(
      `<@${userId}> 請點擊下方按鈕完成付款。\n\n` +
        `購買編號：${topupNo}\n` +
        `付款金額：NT$${Number(amount).toLocaleString("zh-TW")}\n` +
        `入帳數量：${Number(amount).toLocaleString("zh-TW")} ASD\n\n` +
        `付款完成後系統會自動查帳並將星雨幣存入錢包，不需要上傳付款截圖。`,
    )
    .setFooter({ text: "付款連結逾時後，可重新建立訂單取得新連結" })
    .setTimestamp();
  if (payment.qrImg) embed.setImage(payment.qrImg);
  const message = await channel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("前往街口付款")
          .setEmoji("💳")
          .setStyle(ButtonStyle.Link)
          .setURL(payment.paymentUrl),
      ),
    ],
  });
  await paymentHelpers.attachJkopayPaymentMessage?.(payment.platformOrderId, message.id);
  return payment;
}

async function handleTopupPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "topup_payment_method_");
  const topupId = selection?.entityId;

  const pending = pendingTopups.get(topupId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆儲值申請已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有建立儲值申請的人可以選擇付款方式。",
      components: [],
    });
  }

  const method = selection?.paymentMethod;

  const { amount, note, topupNo } = pending;

  if (method === "綠界支付") {
    if (!paymentHelpers.ecpayAvailable || !paymentHelpers.createEcpayServicePayment)
      return interaction.editReply({ content: "❌ 綠界信用卡付款目前尚未開放，請改選其他付款方式。", components: [] });
    try {
      const payment = await paymentHelpers.createEcpayServicePayment({
        kind: "topup", entityKey: String(topupNo), userId: interaction.user.id,
        amount, channelId: interaction.channel.id,
        description: `秋奈星雨幣儲值 ${topupNo}`,
        metadata: { topupNo: String(topupNo), guildId: interaction.guildId || process.env.GUILD_ID, note },
      });
      await sendEcpayPaymentPrompt(interaction.channel, interaction.user.id, amount, payment, "ASD 儲值");
      pendingTopups.delete(topupId);
      return interaction.editReply({
        content: `✅ 已建立綠界付款單。\n儲值編號：${topupNo}\n付款金額：NT$${amount.toLocaleString("zh-TW")}\n完成後會自動存入 ASD 錢包。`,
        components: [],
      });
    } catch (error) {
      return interaction.editReply({ content: `❌ 建立綠界儲值付款失敗：${error.message || error}`, components: [] });
    }
  }

  if (method === "街口支付") {
    if (!paymentHelpers.jkopayAvailable) {
      return interaction.editReply({
        content: "❌ 街口支付目前無法使用，請稍後再試或改選其他付款方式。",
        components: [],
      });
    }
    if (!paymentHelpers.createJkopayTopup) {
      return interaction.editReply({
        content: "❌ 街口支付尚未完成設定，請聯繫客服。",
        components: [],
      });
    }
    try {
      await createJkopayTopupPaymentMessage({
        channel: interaction.channel,
        userId: interaction.user.id,
        amount,
        topupNo,
      });
      pendingTopups.delete(topupId);
      return interaction.editReply({
        content: "✅ 街口付款單已建立，請使用頻道中的按鈕完成付款。",
        components: [],
      });
    } catch (error) {
      console.error("[JKOPAY] 建立儲值付款失敗", error);
      return interaction.editReply({
        content: `❌ 街口付款單建立失敗：${error.message || error}`,
        components: [],
      });
    }
  }

  pendingTopups.delete(topupId);

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("💰 儲值申請")
    .setDescription(
      `👤 會員：${interaction.user}\n\n` +
        `🔢 儲值編號：${topupNo}\n` +
        `💵 儲值金額：NT$${amount}\n` +
        `💳 付款方式：${method}\n` +
        `📝 備註：${note}`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `confirm_topup_${interaction.user.id}_${amount}_${topupNo}`,
      )
      .setLabel("確認儲值")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("關閉單子")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    embeds: [embed],
    components: [row],
  });

  if (isCardPayment(method)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(method)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(method)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (method.includes("美金") || method.includes("加密貨幣")) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${interaction.user.id}> 你選擇了：${method}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${method}`,
    components: [],
  });
}
async function confirmTopup(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isStaff =
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認儲值",
    });
  }

  const parts = interaction.customId.split("_");

  // confirm_topup_userId_amount_topupNo
  const userId = parts[2];

  const amount = Number(parts[3]);
  const topupNo =
    parts[4] || getTopupNumberFromTopic(interaction.channel?.topic) || null;

  if (!userId || !amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 儲值資料錯誤",
    });
  }

  if (
    !paymentHelpers.sendWalletLog ||
    !paymentHelpers.recordMembershipActivity ||
    !paymentHelpers.checkAndUpgradeVip
  ) {
    return interaction.editReply({
      content:
        "❌ 儲值函式尚未完整接入，請確認會員累積與錢包紀錄設定",
    });
  }

  const topupKey = String(
    topupNo || interaction.message?.id || interaction.customId,
  );
  const { data: topupResult, error: topupError } = await supabase.rpc(
    "qiunai_apply_manual_topup",
    {
      p_topup_no: topupKey,
      p_user_id: String(userId),
      p_amount: amount,
      p_confirmed_by: String(interaction.user.id),
    },
  );
  if (topupError || !topupResult) {
    console.error("[確認儲值] 原子儲值失敗", topupError);
    return interaction.editReply({
      content: `❌ 儲值失敗：${topupError?.message || "未取得儲值結果"}`,
    });
  }
  const finalCoins = Number(topupResult.balance || 0);
  const alreadyProcessed = Boolean(topupResult.already_processed);
  if (!alreadyProcessed) {
    // RPC 已持久寫入 wallet_logs；此處只發送 Discord 私訊。
    await paymentHelpers.sendWalletLog?.(
      userId,
      "儲值",
      amount,
      finalCoins,
      `💳 自動儲值成功｜${topupKey}`,
      false,
    );
  }

  let effectsPending = false;
  try {
    await processFinancialEffect(
      topupResult.effects_key || `manual-topup-effects:${topupKey}`,
    );
  } catch (effectError) {
    effectsPending = true;
    console.error(`[確認儲值] ${topupKey} VIP/會計待背景補償`, effectError);
  }

  await interaction.message
    ?.edit({
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("關閉單子")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    })
    .catch(() => {});

  if (alreadyProcessed) {
    return interaction.editReply({
      content:
        `✅ ${topupKey} 先前已完成儲值，本次沒有重複增加 ASD。` +
        (effectsPending ? "\n⚠️ VIP／會計後處理已保留，系統會自動補做。" : ""),
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 儲值已完成")
        .setDescription(
          `<@${userId}> 已成功儲值。\n\n` +
            `儲值編號：${topupKey}\n` +
            `儲值金額：${amount} ASD\n` +
            `目前餘額：${finalCoins} ASD\n` +
            `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content:
      `✅ ${topupKey} 已幫 <@${userId}> 儲值 ${amount} ASD` +
      (effectsPending ? "\n⚠️ VIP／會計後處理已保留，系統會自動補做。" : ""),
  });
}
async function submitSaveOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("submit_save_order_note_", "");

  const savedText = interaction.fields.getTextInputValue("saved_order_text");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.log("[存單讀取訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  const saveChannel = await client.channels
    .fetch(process.env.SAVED_ORDER_CHANNEL)
    .catch(() => null);

  if (!saveChannel) {
    return interaction.editReply({
      content: "❌ 找不到存單指定頻道，請檢查 SAVED_ORDER_CHANNEL",
    });
  }

  const endButton = new ButtonBuilder()
    .setCustomId(`saved_order_end_${order.id}`)
    .setLabel("已結束")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(endButton);

  const embed = new EmbedBuilder()
    .setColor("#66ccff")
    .setTitle("📝 訂單存單")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "👤 客人",
        value: `<@${order.customer_id}>`,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: "💰 金額",
        value: `NT$${order.final_price || order.price || 0}`,
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未填寫",
        inline: true,
      },
      {
        name: "📝 存單內容",
        value: savedText.slice(0, 1000),
        inline: false,
      }
    )
    .setFooter({
      text: `存單人：${interaction.user.username}`,
    })
    .setTimestamp();

  await saveChannel.send({
    embeds: [embed],
    components: [row],
  });

  await interaction.channel.send({
    content: `✅ <@${interaction.user.id}> 已完成存單，內容已送到指定頻道。`,
  });

  return interaction.editReply({
    content: "✅ 存單已送出",
  });
}
async function handleSavedOrderEnd(interaction) {
  const roleId = process.env.STAFF_ROLE;

  const isStaff =
    interaction.guild.ownerId === interaction.user.id ||
    interactionHasPermission(interaction, PermissionFlagsBits.Administrator) ||
    memberHasRole(interaction.member, roleId);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以按已結束",
    });
  }

  const oldEmbed = interaction.message.embeds[0];

  const newEmbed = EmbedBuilder.from(oldEmbed)
    .setColor("#999999")
    .setTitle("✅ 訂單存單｜已結束")
    .addFields({
      name: "🔒 結束人",
      value: `<@${interaction.user.id}>`,
      inline: true,
    });

  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.message.components[0].components[0])
      .setDisabled(true)
      .setLabel("已結束")
  );

  await interaction.message.edit({
    embeds: [newEmbed],
    components: [disabledRow],
  });

  return interaction.editReply({
    content: "✅ 已標記為結束",
  });
}
// ===== 送出更改訂單金額 =====
async function submitChangeOrderPrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (!canEditOrderPrice(interaction)) {
    return interaction.editReply({
      content: "❌ 你沒有權限更改訂單金額",
    });
  }

  const orderId = interaction.customId.replace(
    "submit_change_order_price_",
    ""
  );

  const priceText = interaction.fields.getTextInputValue("new_price");
  const cleanPriceText = priceText.replace(/[^\d]/g, "");
  if (cleanPriceText === "") {
    return interaction.editReply({
      content: "❌ 請輸入金額",
    });
  }
  const newPrice = Number(cleanPriceText);
  if (Number.isNaN(newPrice) || newPrice < 0) {
    return interaction.editReply({
      content: "❌ 金額不能小於 0",
    });
  }
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.log("[更改金額讀取訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  const oldPrice = Number(order.final_price ?? order.price ?? 0);
  const adjustment = getPaidOrderPriceAdjustment(oldPrice, newPrice);
  if (adjustment.difference === 0) {
    return interaction.editReply({ content: "⚠️ 新金額與目前訂單金額相同，沒有需要調整的差額。" });
  }

  const orderChannel = await client.channels
    .fetch(order.channel_id)
    .catch(() => null);

  if (!orderChannel) {
    return interaction.editReply({ content: "❌ 找不到訂單臨時頻道" });
  }

  if (order.paid && isWalletPaymentMethod(order.payment_method)) {
    const actionLabel = adjustment.difference > 0 ? "補扣" : "退回";
    const difference = Math.abs(adjustment.difference);
    await orderChannel.send({
      content: `<@${order.customer_id}> 客服已修改訂單金額，請確認 ASD 差額調整。`,
      embeds: [new EmbedBuilder()
        .setColor(adjustment.difference > 0 ? "#ffaa00" : "#57F287")
        .setTitle("💰 訂單金額差額確認")
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
          `原金額：NT$${oldPrice.toLocaleString("zh-TW")}\n` +
          `新金額：NT$${newPrice.toLocaleString("zh-TW")}\n` +
          `${actionLabel}差額：${difference.toLocaleString("zh-TW")} ASD\n\n` +
          `只會調整上述差額，不會重複扣除原訂單金額。`,
        )
        .setFooter({ text: `由 ${interaction.user.username} 修改` })
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_order_price_adjustment_${order.id}_${oldPrice}_${newPrice}`)
          .setLabel(adjustment.difference > 0 ? "確認補扣差額" : "確認退回差額")
          .setStyle(adjustment.difference > 0 ? ButtonStyle.Danger : ButtonStyle.Success),
      )],
    });
    return interaction.editReply({
      content: `✅ 已請闆闆確認${actionLabel} ${difference.toLocaleString("zh-TW")} ASD；確認前訂單金額不會先變更。`,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from("play_orders")
    .update({
      price: newPrice,
      final_price: newPrice,
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError || !updated) {
    console.log("[更改金額失敗]", updateError);
    return interaction.editReply({
      content: "❌ 更改金額失敗",
    });
  }
  try {
    await workReportSystem.syncAcceptedOrder(updated);
  } catch (syncError) {
    console.error("[更改金額同步填單失敗]", syncError);
    return interaction.editReply({
      content:
        "⚠️ 原訂單金額已更新，但陪陪填單同步失敗，請查看 Railway Logs。",
    });
  }

  const embed = new EmbedBuilder()
    .setColor("#ffaa00")
    .setTitle("💰 訂單金額已更新")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "👤 客人",
        value: `<@${order.customer_id}>`,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: "💰 原金額",
        value: `NT$${order.price || 0}`,
        inline: true,
      },
      {
        name: "💵 新金額",
        value: `NT$${newPrice}`,
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未填寫",
        inline: true,
      },
      {
        name: "📝 備註需求",
        value: order.note || "無",
        inline: false,
      }
    )
    .setFooter({
      text: `由 ${interaction.user.username} 更改`,
    })
    .setTimestamp();

  await orderChannel.send({
    content: `<@${order.customer_id}> 訂單金額已更新，請確認新的金額。`,
    embeds: [embed],
  });

  await sendPlayLog({
    title: "💰 訂單金額已更新",
    description:
      `訂單編號：${order.order_no}\n` +
      `修改人：<@${interaction.user.id}>\n` +
      `原金額：NT$${order.price || 0}\n` +
      `新金額：NT$${newPrice}`,
    color: "#ffaa00",
  });

  return interaction.editReply({
    content: `✅ 已將訂單金額改為 NT$${newPrice}`,
  });
}

async function confirmPaidWalletPriceAdjustment(interaction) {
  await deferReplyOnce(interaction);
  const reconcileMatch = interaction.customId.match(/^confirm_order_paid_gap_(.+)_(\d+)_(\d+)$/);
  const match = reconcileMatch || interaction.customId.match(/^confirm_order_price_adjustment_(.+)_(\d+)_(\d+)$/);
  if (!match) return interaction.editReply({ content: "❌ 差額調整資料格式錯誤。" });
  const [, orderId, expectedPriceText, newPriceText] = match;
  const isExistingPaidGap = Boolean(reconcileMatch);
  const operationKey = `${isExistingPaidGap ? "gap" : "edit"}:${orderId}:${expectedPriceText}:${newPriceText}`;
  if (processingOrderPriceAdjustments.has(operationKey)) {
    return interaction.editReply({ content: "⚠️ 這筆差額正在處理，請勿重複點擊。" });
  }
  processingOrderPriceAdjustments.add(operationKey);
  try {
    const { data: order, error } = await supabase
      .from("play_orders")
      .select("*")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !order) return interaction.editReply({ content: "❌ 找不到這張訂單。" });
    if (interaction.user.id !== order.customer_id) {
      return interaction.editReply({ content: "❌ 只有下單的闆闆可以確認差額調整。" });
    }
    if (!order.paid || !isWalletPaymentMethod(order.payment_method)) {
      return interaction.editReply({ content: "❌ 這張訂單不是已付款的 ASD 訂單，無法自動調整。" });
    }
    const expectedPrice = Number(expectedPriceText);
    const newPrice = Number(newPriceText);
    const currentPrice = Number(order.final_price ?? order.price ?? 0);
    if ((!isExistingPaidGap && currentPrice !== expectedPrice) || (isExistingPaidGap && currentPrice !== newPrice)) {
      await interaction.message.edit({ components: [] }).catch(() => null);
      return interaction.editReply({ content: "❌ 訂單金額已再次變更，這個確認按鈕已失效。" });
    }
    const { difference } = getPaidOrderPriceAdjustment(
      isExistingPaidGap ? expectedPrice : currentPrice,
      newPrice,
    );
    if (!difference) {
      await interaction.message.edit({ components: [] }).catch(() => null);
      return interaction.editReply({ content: "⚠️ 訂單已是這個金額，不會重複調整。" });
    }
    if (
      isExistingPaidGap &&
      difference > 0 &&
      await hasMatchingManualPriceGapDeduction(order, difference)
    ) {
      await interaction.message.edit({ components: [] }).catch(() => null);
      return interaction.editReply({
        content:
          `✅ 已查到客服在訂單改價後人工扣除同額 ${difference.toLocaleString("zh-TW")} ASD，` +
          "這張延遲補扣通知已作廢，不會再次扣款。",
      });
    }
    if (difference > 0) {
      const user = await paymentHelpers.getUser(order.customer_id);
      if (Number(user.coins || 0) < difference) {
        return interaction.editReply({
          content: `❌ ASD 餘額不足。目前：${Number(user.coins || 0).toLocaleString("zh-TW")} ASD，需要補扣：${difference.toLocaleString("zh-TW")} ASD。`,
        });
      }
    }

    const finalCoins = await paymentHelpers.changeCoins(order.customer_id, -difference);
    let updated = order;
    if (!isExistingPaidGap) {
      const { data, error: updateError } = await supabase
        .from("play_orders")
        .update({ price: newPrice, final_price: newPrice, updated_at: new Date().toISOString() })
        .eq("id", order.id)
        .eq("final_price", currentPrice)
        .select()
        .maybeSingle();
      if (updateError || !data) {
        await paymentHelpers.changeCoins(order.customer_id, difference).catch(() => null);
        throw new Error(updateError?.message || "訂單金額已被其他操作變更，錢包異動已撤銷");
      }
      updated = data;
    }

    const actionLabel = difference > 0 ? "訂單補扣" : "訂單退款";
    await paymentHelpers.sendWalletLog(
      order.customer_id,
      actionLabel,
      -difference,
      finalCoins,
      `訂單 ${order.order_no || order.id}｜${isExistingPaidGap ? "補齊既有未扣差額" : `金額由 NT$${currentPrice} 調整為 NT$${newPrice}`}`,
    );
    await paymentHelpers.recordAccountingLedger?.({
      entry_type: "customer_spend_wallet_adjustment",
      entry_label: difference > 0 ? "客人補款" : "客人退款",
      amount: difference,
      revenue_amount: difference,
      liability_amount: -difference,
      payment_method: "儲值卡 / 錢包",
      customer_id: order.customer_id,
      order_id: String(order.id),
      order_no: order.order_no || null,
      source_table: "play_orders",
      source_id: String(order.id),
      dedupe_key: `play_orders:${order.id}:price_adjustment:${interaction.id}`,
      note: isExistingPaidGap
        ? `補齊訂單未扣差額 NT$${Math.abs(difference)}`
        : `訂單金額由 NT$${currentPrice} 調整為 NT$${newPrice}`,
    }).catch((ledgerError) => console.error("[修改金額帳務明細] 寫入失敗", ledgerError));
    await paymentHelpers.recordSpendActivity?.({
      userId: order.customer_id,
      amount: difference,
      sourceKey: `order-price-adjustment:${interaction.id}`,
      note: `訂單 ${order.order_no || order.id} 金額差額調整`,
    }).catch((activityError) => console.error("[修改金額聯盟累積消費] 更新失敗", activityError));
    await paymentHelpers.checkAndUpgradeVip?.(
      order.customer_id,
      "spend",
      difference,
      order.guild_id || process.env.GUILD_ID,
      order.channel_id || null,
    ).catch((vipError) => console.error("[修改金額累積消費] 更新失敗", vipError));
    await workReportSystem.syncAcceptedOrder(updated).catch((syncError) =>
      console.error("[修改金額同步填單失敗]", syncError),
    );
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setColor("#57F287")
        .setTitle(difference > 0 ? "✅ 訂單差額補扣完成" : "✅ 訂單差額退款完成")
        .setDescription(
          `訂單：${order.order_no || order.id}\n` +
          `原已扣金額：NT$${(isExistingPaidGap ? expectedPrice : currentPrice).toLocaleString("zh-TW")}\n` +
          `新金額：NT$${newPrice.toLocaleString("zh-TW")}\n` +
          `${difference > 0 ? "已補扣" : "已退回"}：${Math.abs(difference).toLocaleString("zh-TW")} ASD\n` +
          `目前餘額：${Number(finalCoins).toLocaleString("zh-TW")} ASD`,
        )
        .setTimestamp()],
    });
    return interaction.editReply({ content: "✅ 差額與訂單金額已同步完成。" });
  } catch (error) {
    console.error("[已付款訂單修改金額] 失敗", error);
    return interaction.editReply({ content: `❌ 差額調整失敗：${error.message || error}` });
  } finally {
    processingOrderPriceAdjustments.delete(operationKey);
  }
}
// 接單
async function acceptPlayOrder(interaction) {
  try {
    const orderId = interaction.customId.replace("accept_play_order_", "");

    let playerQuery = supabase
      .from("qiunai_staff")
      .select("*")
      .eq("discord_id", interaction.user.id)
      .eq("status", "available")
      .limit(1);

    playerQuery = applyStaffGuildFilter(playerQuery);

    const { data: playerRows, error: playerError } = await playerQuery;

    const player = playerRows?.[0];

    if (playerError) {
      console.log("[接單錯誤 players]", playerError);
    }

    if (!player) {
      return interaction.editReply({
        content: "❌ 你目前不是可接單狀態，請先按「開始接單」",
      });
    }

    const { data: order, error: orderError } = await supabase
      .from("play_orders")
      .select("*")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) {
      console.log("[接單錯誤 play_orders]", orderError);
    }

    if (!order || !["pending", "accepted"].includes(order.status)) {
      return interaction.editReply({
        content: "❌ 這張訂單已經被接走了，或目前不能接單",
      });
    }

    const orderServiceText = `${order.game || ""}｜${order.order_item || ""}｜${
      order.service || ""
    }`;
    if (
      orderServiceText.includes("王者榮耀") ||
      orderServiceText.includes("第五人格")
    ) {
      const requiredService = getServiceKeywordFromPending({
        category: "other",
        gameLabel: order.game,
        itemLabel: order.order_item,
        serviceType: order.service,
      });
      if (!matchAllowedServiceName(player.allowed_services, requiredService)) {
        return interaction.editReply({
          content: `❌ 你的薪資網尚未勾選「${requiredService}」，目前不能接這張訂單。`,
        });
      }
    }

    // ===== 指定陪陪限制 =====
    if (order.preferred_player) {
      const preferredPlayers = String(order.preferred_player)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      const needCount = Number(order.player_count || 1) || 1;

      const assignedPlayerIdsNow = String(order.assigned_player || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      const preferredFull = preferredPlayers.length >= needCount;

      const isPreferredPlayer = preferredPlayers.includes(interaction.user.id);

      const alreadyAssignedPreferredCount = assignedPlayerIdsNow.filter((id) =>
        preferredPlayers.includes(id)
      ).length;

      const stillWaitingPreferred =
        preferredPlayers.length > alreadyAssignedPreferredCount;

      if (preferredFull && !isPreferredPlayer) {
        return interaction.editReply({
          content:
            `❌ 這張訂單只開放指定陪陪接單：` +
            preferredPlayers.map((id) => `<@${id}>`).join("、"),
        });
      }

      if (!preferredFull && !isPreferredPlayer && stillWaitingPreferred) {
        return interaction.editReply({
          content:
            `❌ 這張訂單還有指定陪陪尚未接單，請先等待：` +
            preferredPlayers.map((id) => `<@${id}>`).join("、") +
            `\n如果指定陪陪無法接，請客服將指定改為不指定或調整名單。`,
        });
      }
    }

    // ===== 多人接單邏輯 =====
    const needCount = Number(order.player_count || 1) || 1;

    let assignedPlayerIds = String(order.assigned_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (assignedPlayerIds.includes(interaction.user.id)) {
      return interaction.editReply({
        content: "❌ 你已經接過這張訂單了",
      });
    }

    assignedPlayerIds.push(interaction.user.id);

    if (assignedPlayerIds.length > needCount) {
      return interaction.editReply({
        content: `❌ 這張訂單需要 ${needCount} 位陪玩，目前名額已滿。`,
      });
    }

    const assignedPlayerValue = assignedPlayerIds.join(",");

    const isFull = assignedPlayerIds.length >= needCount;

    const nextStatus = isFull ? "accepted" : "pending";

    const updatePayload = {
      status: nextStatus,
      assigned_player: assignedPlayerValue,
    };

    if (isFull) {
      updatePayload.accepted_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabase
      .from("play_orders")
      .update(updatePayload)
      .eq("id", orderId)
      .in("status", ["pending", "accepted"])
      .select()
      .maybeSingle();

    if (updateError) {
      console.log("[接單更新錯誤]", updateError);

      return interaction.editReply({
        content: "❌ 接單更新失敗，請查看 Railway Logs",
      });
    }

    if (!updated) {
      return interaction.editReply({
        content: "❌ 這張訂單目前無法接單，可能已被接滿或狀態已變更",
      });
    }

    if (isFull) {
      try {
        await workReportSystem.sendForAcceptedOrder(updated, assignedPlayerIds);
      } catch (error) {
        console.error("[工時申報] 發送填單面板失敗", error);
      }
    }

    const orderChannel = await client.channels.fetch(order.channel_id);

    if (!orderChannel) {
      return interaction.editReply({
        content: "❌ 找不到客人訂單頻道",
      });
    }

    for (const playerId of assignedPlayerIds) {
      await orderChannel.permissionOverwrites.edit(playerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    }

    await supabase
      .from("play_orders")
      .update({
        channel_id: orderChannel.id,
      })
      .eq("id", orderId);

    const embed = new EmbedBuilder()
      .setColor(isFull ? "#00ff99" : "#ffd166")
      .setTitle(isFull ? "✅ 陪玩訂單已接單" : "⏳ 陪玩接單中")
      .setDescription(
        `訂單編號：${order.order_no || order.id}\n` +
          `客人：<@${order.customer_id}>\n` +
          `目前陪玩：${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join("、")}\n` +
          `需要人數：${needCount} 位\n` +
          `目前人數：${assignedPlayerIds.length} 位\n` +
          `服務：${order.service || order.order_item || "未填寫"}\n` +
          `商品金額：NT$${order.final_price || order.price || 0}`
      );

    await orderChannel.send({
      content: isFull
        ? `<@${order.customer_id}> ${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join(" ")}`
        : `${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join(" ")} 已接單，目前還差 ${
            needCount - assignedPlayerIds.length
          } 位陪玩。`,
      embeds: [embed],
    });

    await sendPlayLog({
      title: "✅ 訂單已接取",
      description:
        `訂單編號：${order.order_no || order.id}\n` +
        `陪玩：${assignedPlayerIds.map((id) => `<@${id}>`).join("、")}\n` +
        `服務：${order.service || order.order_item || "未填寫"}\n` +
        `商品金額：NT$${order.final_price || order.price || 0}`,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 接單成功")
          .setDescription(`📂 點擊前往訂單頻道\n${orderChannel}`),
      ],
    });
  } catch (err) {
    console.log("[接單系統錯誤]", err);

    return interaction
      .editReply({
        content: `❌ 接單失敗：${err.message || "未知錯誤"}`,
      })
      .catch(() => {});
  }
}
function getGrowthVipLevel(totalTopup, singleTopup = 0) {
  void totalTopup;
  if (singleTopup >= 50000) {
    return "vvip";
  }
  if (singleTopup >= 30000) {
    return "vip_plus";
  }
  if (singleTopup >= 10000) {
    return "vip";
  }
  return "none";
}
function getTopupBonus(amount) {
  if (amount >= 75000) {
    return 8000;
  }
  if (amount >= 50000) {
    return 5000;
  }
  if (amount >= 30000) {
    return 3000;
  }
  if (amount >= 18000) {
    return 1800;
  }
  if (amount >= 8000) {
    return 700;
  }
  if (amount >= 5000) {
    return 300;
  }
  return 0;
}

function getGrowthVipRoleId(level) {
  const roles = {
    vip: process.env.GROWTH_VIP_ROLE_ID,
    vip_plus: process.env.GROWTH_VIP_PLUS_ROLE_ID,
    // vvip 不發身分組
  };

  return roles[level] || null;
}

async function checkGrowthVip(client, guildId, userId, singleTopup = 0) {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !user) {
    console.log("[VIP] 找不到使用者", error);
    return;
  }

  const totalTopup = user.total_topup || 0;

  const newLevel = getGrowthVipLevel(totalTopup, singleTopup);

  if (newLevel === user.growth_vip) {
    return;
  }

  await supabase
    .from("users")
    .update({
      growth_vip: newLevel,
    })
    .eq("user_id", userId);

  const guild = await client.guilds.fetch(guildId);

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  const growthRoles = [
    process.env.GROWTH_VIP_ROLE_ID,
    process.env.GROWTH_VIP_PLUS_ROLE_ID,
  ].filter(Boolean);

  await member.roles.remove(growthRoles).catch(() => {});

  const roleId = getGrowthVipRoleId(newLevel);

  if (roleId) {
    await member.roles.add(roleId).catch(() => {});
  }

  const levelName = {
    vip: "💎 VIP",
    vip_plus: "🌟 VIP+",
    vvip: "👑 VVIP",
    none: "無",
  };

  await member
    .send({
      content: `🎉 恭喜你已升級為 ${levelName[newLevel]}！`,
    })
    .catch(() => {});
}
function getFlowIdFromCustomId(customId, prefix = "") {
  return String(customId || "").replace(prefix, "");
}
function getValorantTypeSelection(value) {
  const selections = {
    entertain: {
      label: "娛樂",
      serviceTypes: ["娛樂"],
      companionRank: "娛樂",
    },
    ascendant: {
      label: "超凡",
      serviceTypes: ["超凡"],
      companionRank: "超凡",
    },
    immortal: {
      label: "神話",
      serviceTypes: ["神話"],
      companionRank: "神話",
    },
    radiant: {
      label: "輻能",
      serviceTypes: ["輻能"],
      companionRank: "輻能",
    },
    top_radiant: {
      label: "頂輻",
      serviceTypes: ["頂輻"],
      companionRank: "頂輻",
    },
  };

  return selections[value] || null;
}
function getValorantServiceTypes(pending) {
  return Array.isArray(pending?.serviceTypes) ? pending.serviceTypes : [];
}
function isValorantEntertainmentSkillOrder(pending) {
  const serviceTypes = getValorantServiceTypes(pending);

  return (
    pending?.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術")
  );
}
function enforceValorantMinimumPlayerCount(pending) {
  if (!isValorantEntertainmentSkillOrder(pending)) {
    return false;
  }

  const currentCount = Number(pending.playerCount || 0);

  if (currentCount >= 2) {
    return false;
  }

  pending.playerCount = 2;
  return true;
}
function getValorantTypeReply(pending, adjusted = false) {
  const serviceTypes = getValorantServiceTypes(pending);

  if (!serviceTypes.length) {
    return "✅ 已取消選擇，目前尚未選擇需求的陪陪段位";
  }

  return (
    `✅ 需求的陪陪段位：${serviceTypes.join("＋")}` +
    (isValorantEntertainmentSkillOrder(pending)
      ? `\n同時選擇娛樂＋技術時，陪陪人數至少需要 2 位。` +
        (adjusted ? "\n已自動把陪陪人數調整為 2 位。" : "")
      : "")
  );
}
async function handleValorantTypeSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("valorant_type_select_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const selected = getValorantTypeSelection(interaction.values[0]);

  if (!selected) {
    return interaction.editReply({
      content: "❌ 找不到這個陪陪段位選項，請重新選擇。",
    });
  }

  pending.itemLabel = selected.label;
  pending.playMode = selected.label;
  pending.serviceTypes = selected.serviceTypes;
  pending.serviceType = selected.label;
  pending.valorantCompanionRank = selected.companionRank;

  const adjusted = enforceValorantMinimumPlayerCount(pending);

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: getValorantTypeReply(pending, adjusted),
  });
}

async function handleValorantTypeButton(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isEntertainment = interaction.customId.includes(
    "valorant_type_entertain_"
  );

  const prefix = isEntertainment
    ? "valorant_type_entertain_"
    : "valorant_type_skill_";

  const flowId = getFlowIdFromCustomId(interaction.customId, prefix);

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const selectedType = isEntertainment ? "娛樂" : "技術";

  const serviceTypes = getValorantServiceTypes(pending);

  if (serviceTypes.includes(selectedType)) {
    pending.serviceTypes = serviceTypes.filter((type) => type !== selectedType);
  } else {
    pending.serviceTypes = [...serviceTypes, selectedType];
  }

  pending.serviceType = pending.serviceTypes.join("＋") || null;

  const adjusted = enforceValorantMinimumPlayerCount(pending);

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: getValorantTypeReply(pending, adjusted),
  });
}

async function handleValorantModeButton(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = getFlowIdFromCustomId(
    interaction.customId,
    interaction.customId.includes("valorant_mode_rank_")
      ? "valorant_mode_rank_"
      : "valorant_mode_normal_"
  );
  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.playMode = interaction.customId.includes("_rank_") ? "排位" : "一般";

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇模式：${pending.playMode}`,
  });
}

async function handleValorantRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("valorant_rank_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];
  pending.duration = null;
  pending.rounds = null;
  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes.filter(Boolean)
    : [];
  const selectedType = serviceTypes.length === 1
    ? serviceTypes[0]
    : pending.serviceType;
  pending.valorantCompanionRank = isValorantEntertainmentSkillOrder(pending)
    ? null
    : getValorantMappedCompanionRank(selectedType, pending.rank);
  pending.timeSelectShown = true;
  await pendingServiceOrders.set(flowId, pending);

  const unit = pending.valorantCompanionRank
    ? getValorantExpectedUnit({
        serviceType: pending.rank,
        rankOrMap: pending.valorantCompanionRank,
      })
    : isValorantAboveGold(pending.rank)
      ? "局"
      : "小時";
  if (unit === "局") await showServiceRoundSelect(interaction.channel, flowId);
  else await showServiceDurationSelect(interaction.channel, flowId, "hour");

  return interaction.editReply({
    content:
      `✅ 已選擇要打的段位：${pending.rank}\n` +
      (pending.valorantCompanionRank
        ? `${selectedType}自動套用：${pending.valorantCompanionRank}\n`
        : "此多人組合將由客服分項報價。\n") +
      `此組合使用${unit === "局" ? "局數" : "時間"}制。`,
  });
}
async function handleApexRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("apex_rank_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇 Apex 段位：${pending.rank}`,
  });
}
async function handleLolRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("lol_rank_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇英雄聯盟段位 / 類型：${pending.rank}`,
  });
}
async function handleServicePlayerCountSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_player_count_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  const selectedCount = Number(interaction.values[0]);

  if (isValorantEntertainmentSkillOrder(pending) && selectedCount < 2) {
    return interaction.editReply({
      content:
        "❌ 同時選擇娛樂＋技術時，陪陪人數至少需要 2 位。\n" +
        "請重新選擇 2 位以上。",
    });
  }

  pending.playerCount = selectedCount;

  await pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇陪陪人數：${pending.playerCount} 位\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}

async function handleServiceGenderSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_gender_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.genderPreference = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇性別偏好：${pending.genderPreference}`,
  });
}
function getServiceKeywordFromPending(pending = {}) {
  const text = [
    pending.serviceType,
    pending.gameLabel,
    pending.itemLabel,
    pending.playMode,
    pending.deltaMode,
    pending.steamCategory,
    pending.game,
    pending.item,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("｜");

  if (pending.category === "valorant" || text.includes("特戰英豪")) {
    if (text.includes("大神")) return "特戰英豪大神陪玩";
    if (text.includes("技術")) return "特戰英豪技術陪玩";
    if (text.includes("娛樂")) return "特戰英豪娛樂陪玩";
    return "特戰英豪";
  }

  if (pending.category === "apex" || text.includes("Apex")) {
    if (text.includes("大神")) return "Apex大神陪玩";
    if (text.includes("技術")) return "Apex技術陪玩";
    if (text.includes("娛樂")) return "Apex娛樂陪玩";
    return "Apex";
  }

  if (pending.category === "delta" || text.includes("三角洲")) {
    if (text.includes("娛樂陪玩")) return "三角洲行動娛樂陪玩";
    if (text.includes("基本單護")) return "三角洲行動基本單護";
    if (text.includes("機密雙護") && text.includes("保底"))
      return "三角洲行動機密雙護保底";
    if (text.includes("機密雙護")) return "三角洲行動機密雙護";
    if (text.includes("猛攻") && text.includes("保底"))
      return "三角洲行動猛攻護航保底";
    if (text.includes("猛攻")) return "三角洲行動猛攻護航";
    return "三角洲行動";
  }

  if (
    pending.category === "lol" ||
    text.includes("英雄聯盟") ||
    text.includes("ARAM") ||
    text.includes("聯盟戰棋")
  ) {
    if (text.includes("聯盟戰棋")) return "聯盟戰棋";

    if (text.includes("ARAM")) {
      if (text.includes("大神")) return "ARAM大神陪玩";
      if (text.includes("技術")) return "ARAM技術陪玩";
      if (text.includes("娛樂")) return "ARAM娛樂陪玩";
      return "ARAM";
    }

    if (text.includes("大神")) return "英雄聯盟大神陪玩";
    if (text.includes("技術")) return "英雄聯盟技術陪玩";
    if (text.includes("娛樂")) return "英雄聯盟娛樂陪玩";
    return "英雄聯盟";
  }

  if (pending.category === "steam" || text.includes("Steam")) {
    if (text.includes("肉鴿")) return "Steam肉鴿遊戲";
    if (text.includes("生存")) return "Steam生存遊戲";
    if (text.includes("恐怖")) return "Steam恐怖遊戲";
    if (text.includes("派對")) return "Steam派對遊戲";
    return "Steam";
  }

  if (pending.category === "other") {
    if (text.includes("傳說對決")) {
      if (text.includes("大神")) return "傳說對決大神";
      if (text.includes("技術")) return "傳說對決技術";
      if (text.includes("娛樂")) return "傳說對決娛樂";
    }
    if (text.includes("王者榮耀")) {
      if (text.includes("技術")) return "王者榮耀技術";
      if (text.includes("娛樂")) return "王者榮耀娛樂";
    }
    if (text.includes("第五人格")) {
      if (text.includes("四階")) return "第五人格四階";
      if (text.includes("五階")) return "第五人格五階";
      if (text.includes("六階")) return "第五人格六階";
      if (text.includes("七階")) return "第五人格七階";
      if (text.includes("娛樂")) return "第五人格娛樂";
    }
    if (text.includes("語音聊天")) return "語音聊天";
    if (text.includes("點歌")) return "點歌服務";
    if (text.includes("PUBG M")) return "PUBG M";
    if (text.includes("NARAKA")) return "NARAKA";
    if (text.includes("Minecraft")) return "Minecraft";
  }

  return "";
}
function getServiceGroupName(targetService) {
  const target = cleanServiceKey(targetService);

  if (target.includes("特戰英豪")) return "特戰英豪";
  if (target.includes("三角洲行動")) return "三角洲行動";
  if (target.includes("Apex")) return "Apex";
  if (target.includes("英雄聯盟")) return "英雄聯盟";
  if (target.includes("ARAM")) return "ARAM";
  if (target.includes("聯盟戰棋")) return "聯盟戰棋";
  if (target.includes("Steam")) return "Steam";

  return target;
}

function matchAllowedServiceName(allowedServices, targetService) {
  const target = cleanServiceKey(targetService);

  if (!target) return false;

  const services = normalizeAllowedServices(allowedServices)
    .map((service) => cleanServiceKey(service))
    .filter(Boolean);

  if (!services.length) return false;

  const group = getServiceGroupName(target);

  const serviceAliases = {
    傳說對決娛樂: "aov_entertain",
    傳說對決技術: "aov_skill",
    傳說對決大神: "aov_god",
    王者榮耀娛樂: "hok_entertain",
    王者榮耀技術: "hok_skill",
    第五人格娛樂: "identity_v_entertain",
    第五人格四階: "identity_v_rank_4",
    第五人格五階: "identity_v_rank_5",
    第五人格六階: "identity_v_rank_6",
    第五人格七階: "identity_v_rank_7",
  };
  const alias = serviceAliases[target];

  return (
    services.includes(target) ||
    (alias && services.includes(cleanServiceKey(alias))) ||
    services.includes("全部服務") ||
    services.includes(`${group}全部`)
  );
}
async function showServicePlayerSelect(channel, flowId, pending) {
  let playerQuery = supabase
    .from("qiunai_staff")
    .select("*")
    .order("status", { ascending: true });

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[新版指定陪陪] 讀取陪陪失敗", error);
    return channel.send("❌ 讀取陪陪資料失敗，請聯繫客服。");
  }

  const serviceKeyword = getServiceKeywordFromPending(pending);

  const matchedPlayers = (players || [])
    .filter((player) => player.discord_id)
    .filter((player) => matchPlayerGender(player, pending.genderPreference))
    .filter((player) => {
      const allowedServices = normalizeAllowedServices(player.allowed_services);

      // 沒有設定可接服務，就不要顯示，避免誤接錯項目
      if (!allowedServices.length) return false;

      return matchAllowedServiceName(allowedServices, serviceKeyword);
    });

  const onlinePlayers = matchedPlayers.filter(
    (player) => player.status === "available"
  );

  const offlinePlayers = matchedPlayers.filter(
    (player) => player.status !== "available"
  );

  const options = [
    ...onlinePlayers.map((player) => ({
      label: `🟢 ${getStaffDisplayName(player)}`.slice(0, 100),
      description: "目前在線，可直接安排".slice(0, 100),
      value: `online_${player.discord_id}`,
    })),

    ...offlinePlayers.map((player) => ({
      label: `⚪ ${getStaffDisplayName(player)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`,
    })),
  ].slice(0, 25);

  if (!options.length) {
    return channel.send(
      `❌ 目前沒有符合條件的陪陪。\n` +
        `性別偏好：${pending.genderPreference || "不指定"}\n` +
        `服務：${serviceKeyword || "未填寫"}`
    );
  }

  const maxValues = Math.min(Number(pending.playerCount || 1), options.length);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_selected_players_${flowId}`)
    .setPlaceholder(`請選擇指定陪陪，最多 ${maxValues} 位`)
    .setMinValues(1)
    .setMaxValues(maxValues)
    .addOptions(options);

  await channel.send({
    content:
      `請選擇指定陪陪：\n` +
      `🟢 在線：可直接安排\n` +
      `⚪ 不在線：可查看可接單時間並預約`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}
async function handleServiceAssignSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_assign_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.assignMode = interaction.values[0];
  await pendingServiceOrders.set(flowId, pending);
  if (pending.assignMode === "不指定") {
    await showFinishNeedButtons(interaction.channel, flowId);
    return interaction.editReply({
      content:
        "✅ 已選擇指定方式：不指定陪陪\n" +
        "請確認需求無誤後，按下方「送出訂單」。",
    });
  }
  await showServicePlayerSelect(interaction.channel, flowId, pending);
  return interaction.editReply({
    content:
      `✅ 已選擇指定方式：${pending.assignMode}\n` + `請在頻道內選擇陪陪。`,
  });
}
async function handleServiceSelectedPlayersSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_selected_players_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  const selectedValues = interaction.values || [];

  const playerIds = selectedValues
    .map((value) =>
      String(value).replace("online_", "").replace("reserve_", "")
    )
    .filter(Boolean);

  const reserveIds = selectedValues
    .filter((value) => String(value).startsWith("reserve_"))
    .map((value) => String(value).replace("reserve_", ""));

  pending.selectedPlayerIds = playerIds;
  pending.selectedPlayerType = reserveIds.length > 0 ? "reserve" : "online";

  if (reserveIds.length > 0) {
    pending.assignMode = "預約指定";
  }

  await pendingServiceOrders.set(flowId, pending);

  if (reserveIds.length > 0) {
    let reserveQuery = supabase
      .from("qiunai_staff")
      .select("*")
      .in("discord_id", reserveIds);
    reserveQuery = applyStaffGuildFilter(reserveQuery);
    const { data: players } = await reserveQuery;

    const availableText =
      (players || [])
        .map((player) => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join("\n") || "未填寫可接時間";

    await interaction.channel.send({
      content:
        `⚪ 你選擇了不在線 / 可預約的陪陪：\n` +
        `${availableText}\n\n` +
        `請在備註或頻道內告訴客服想預約的時間。`,
    });
  }

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${playerIds.map((id) => `<@${id}>`).join("、")}\n` +
      `請確認需求無誤後，按下方「送出訂單」。`,
  });
}
async function handleServiceDurationSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_duration_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.duration = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.duration === "custom"
        ? "✅ 已選擇自訂時間，請在頻道內告訴客服想要的時間。"
        : `✅ 已選擇時間：${pending.duration} 小時`,
  });
}

async function handleServiceRoundsSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_rounds_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.rounds = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.rounds === "custom"
        ? "✅ 已選擇自訂局數，請在頻道內告訴客服想要的局數。"
        : `✅ 已選擇局數：${pending.rounds} 局`,
  });
}

async function handleSteamCategorySelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("steam_category_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.steamCategory = interaction.values[0];

  await pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇 Steam 類型：${pending.steamCategory}\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}
async function handleDeltaModeSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("delta_mode_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.deltaMode = interaction.values[0];

  pending.serviceType = `三角洲行動｜${
    pending.deltaPlatform || pending.itemLabel || "未選平台"
  }｜${pending.deltaMode}`;

  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content:
      `✅ 已選擇三角洲服務：${pending.deltaMode}\n` +
      `平台：${pending.deltaPlatform || pending.itemLabel || "未選平台"}`,
  });
}
async function showFinishNeedButtons(channel, flowId) {
  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return;
  }

  if (pending.finishButtonShown) {
    return;
  }

  pending.finishButtonShown = true;
  await pendingServiceOrders.set(flowId, pending);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`order_finish_need_${flowId}`)
      .setLabel("送出訂單")
      .setEmoji("📨")
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({
    content: "需求填寫完成後，請按「送出訂單」。",
    components: [row],
  });
}
async function finishServiceNeed(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("order_finish_need_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.customerId)) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆、客服或管理員可以送出訂單。",
    });
  }

  if (
    isValorantEntertainmentSkillOrder(pending) &&
    Number(pending.playerCount || 0) < 2
  ) {
    return interaction.editReply({
      content:
        "❌ 這筆特戰訂單同時選擇了娛樂＋技術，陪陪人數至少需要 2 位。\n" +
      "請先把陪陪人數改成 2 位以上，再送出訂單。",
    });
  }

  const autoQuote = getGeneralOrderAutoQuote(pending);
  if (autoQuote.ok) {
    const price = Number(autoQuote.quote.total);
    pending.quotedPrice = price;
    pending.originalPrice = price;
    pending.finalPrice = price;
    pending.discountRate = 1;
    pending.discountAmount = 0;
    pending.couponText = "未使用優惠券";
    pending.usedCouponItemId = null;
    pending.usedCouponName = null;
    pending.serviceCouponRecorded = false;
    pending.quoteConfirmedPrice = null;
    pending.quotedBy = null;
    pending.autoQuote = {
      unitPrice: autoQuote.quote.unitPrice,
      quantity: autoQuote.quote.quantity,
      playerCount: autoQuote.quote.playerCount,
      unit: autoQuote.quote.unit,
    };
    await pendingServiceOrders.set(flowId, pending);
    await interaction.message?.edit({ components: [] }).catch(() => null);
    await sendServiceQuoteConfirmPrompt(interaction.channel, flowId, pending);
    return interaction.editReply({
      content: `✅ 系統已依現行價目表自動報價：NT$${price.toLocaleString("zh-TW")}。`,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(QIUNAI_WATER_BLUE)
    .setTitle("📋 待客服報價訂單")
    .addFields(
      {
        name: "客人",
        value: `<@${pending.customerId}>`,
        inline: true,
      },
      {
        name: "服務類型",
        value: getServiceName(pending.category),
        inline: true,
      },
      {
        name: "服務內容",
        value:
          pending.steamGameName ||
          pending.serviceType ||
          pending.steamCategory ||
          pending.deltaMode ||
          "未填寫",
        inline: true,
      },
      {
        name: "模式 / 段位",
        value:
          pending.category === "valorant"
            ? `${pending.playMode || "無"} / 要打：${pending.rank || "無"} / 陪陪：${pending.valorantCompanionRank || "未選擇"}`
            : `${pending.playMode || "無"} / ${pending.rank || "無"}`,
        inline: true,
      },
      {
        name: "陪陪人數",
        value: `${pending.playerCount || 1} 位`,
        inline: true,
      },
      {
        name: "性別偏好",
        value: pending.genderPreference || "不指定",
        inline: true,
      },
      {
        name: "時間 / 局數",
        value: pending.duration
          ? `${pending.duration} 小時`
          : pending.rounds
          ? `${pending.rounds} 局`
          : "未填寫",
        inline: true,
      },
      {
        name: "備註",
        value: pending.note || "無",
        inline: false,
      },
      {
        name: "自動報價結果",
        value: `無法自動計算：${autoQuote.reason}\n已轉交客服人工報價。`,
        inline: false,
      }
    )
    .setFooter({
      text: "正式價格請由客服輸入",
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`service_quote_price_${flowId}`)
      .setLabel("輸入價格")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
  );
  await interaction.channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 有新的訂單需求等待報價。`,
    embeds: [embed],
    components: [row],
  });
  return interaction.editReply({
    content: `✅ 系統暫時無法自動計算這個組合，已通知客服協助報價。\n原因：${autoQuote.reason}`,
  });
}
async function openServiceQuotePriceModal(interaction) {
  if (!isStaffInteraction(interaction)) {
    return interaction.reply({
      content: "❌ 只有客服可以填寫報價",
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_quote_price_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
      flags: 64,
    });
  }

  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];

  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術");

  const modal = new ModalBuilder()
    .setCustomId(`submit_service_quote_price_${flowId}`)
    .setTitle(isValorantSplit ? "客服輸入娛樂 / 技術報價" : "客服輸入正式報價");

  if (isValorantSplit) {
    const entertainInput = new TextInputBuilder()
      .setCustomId("entertain_price")
      .setLabel("娛樂陪玩金額")
      .setPlaceholder("例如：500")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const skillInput = new TextInputBuilder()
      .setCustomId("skill_price")
      .setLabel("技術陪玩金額")
      .setPlaceholder("例如：700")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(entertainInput),
      new ActionRowBuilder().addComponents(skillInput)
    );

    return interaction.showModal(modal);
  }

  const priceInput = new TextInputBuilder()
    .setCustomId("price")
    .setLabel("請輸入正式報價金額")
    .setPlaceholder("例如：560")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  return interaction.showModal(modal);
}
async function submitServiceQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (!isStaffInteraction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服可以填寫報價",
    });
  }

  const flowId = interaction.customId.replace(
    "submit_service_quote_price_",
    ""
  );

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];
  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術");
  let price = 0;
  if (isValorantSplit) {
    const entertainText =
      interaction.fields.getTextInputValue("entertain_price");
    const skillText = interaction.fields.getTextInputValue("skill_price");
    const entertainPrice = Number(
      String(entertainText || "").replace(/[^\d]/g, "")
    );
    const skillPrice = Number(String(skillText || "").replace(/[^\d]/g, ""));
    if (!entertainPrice || entertainPrice <= 0) {
      return interaction.editReply({
        content: "❌ 娛樂陪玩金額格式錯誤",
      });
    }
    if (!skillPrice || skillPrice <= 0) {
      return interaction.editReply({
        content: "❌ 技術陪玩金額格式錯誤",
      });
    }
    price = entertainPrice + skillPrice;
    pending.quoteParts = {
      entertain: entertainPrice,
      skill: skillPrice,
    };
  } else {
    const priceText = interaction.fields.getTextInputValue("price");
    price = Number(String(priceText || "").replace(/[^\d]/g, ""));
    if (!price || price <= 0) {
      return interaction.editReply({
        content: "❌ 金額格式錯誤，請輸入大於 0 的數字",
      });
    }
    pending.quoteParts = null;
  }
  pending.quotedPrice = price;
  pending.originalPrice = price;
  pending.finalPrice = price;
  pending.discountRate = 1;
  pending.discountAmount = 0;
  pending.couponText = "未使用優惠券";
  pending.usedCouponItemId = null;
  pending.usedCouponName = null;
  pending.serviceCouponRecorded = false;
  pending.quoteConfirmedPrice = null;
  pending.quotedBy = hasCustomerServicePointRole(
    interaction,
    CUSTOMER_SERVICE_POINT_ROLE_ID,
  )
    ? interaction.user.id
    : null;
  await pendingServiceOrders.set(flowId, pending);

  await sendServiceQuoteConfirmPrompt(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: `✅ 已送出正式報價：NT$${price.toLocaleString("zh-TW")}`,
  });
}
function getServiceOriginalPrice(pending) {
  return Number(pending?.originalPrice || pending?.quotedPrice || 0);
}
function getServiceFinalPrice(pending) {
  const originalPrice = getServiceOriginalPrice(pending);

  if (
    pending &&
    pending.finalPrice !== null &&
    pending.finalPrice !== undefined &&
    pending.finalPrice !== ""
  ) {
    const finalPrice = Number(pending.finalPrice);

    if (Number.isFinite(finalPrice) && finalPrice >= 0) {
      return finalPrice;
    }
  }

  return originalPrice;
}
function buildServiceQuoteAmountText(pending) {
  const originalPrice = getServiceOriginalPrice(pending);
  const finalPrice = getServiceFinalPrice(pending);
  const discountAmount = Number(pending?.discountAmount || 0);

  const autoQuoteText = pending?.autoQuote
    ? `系統自動報價：NT$${Number(pending.autoQuote.unitPrice || 0).toLocaleString("zh-TW")} / ${pending.autoQuote.unit}\n` +
      `數量：${pending.autoQuote.quantity} ${pending.autoQuote.unit} × ${pending.autoQuote.playerCount} 位\n` +
      `合計金額：NT$${originalPrice.toLocaleString("zh-TW")}`
    : null;
  const quoteText = autoQuoteText || (pending?.quoteParts
    ? `娛樂陪玩：NT$${Number(pending.quoteParts.entertain || 0).toLocaleString(
        "zh-TW"
      )}\n` +
      `技術陪玩：NT$${Number(pending.quoteParts.skill || 0).toLocaleString(
        "zh-TW"
      )}\n` +
      `合計金額：NT$${originalPrice.toLocaleString("zh-TW")}`
    : `金額：NT$${originalPrice.toLocaleString("zh-TW")}`);

  if (!discountAmount) {
    return quoteText;
  }

  return (
    `${quoteText}\n` +
    `優惠券：${pending.couponText || "已使用優惠券"}\n` +
    `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
    `應付金額：NT$${finalPrice.toLocaleString("zh-TW")}`
  );
}
async function sendServiceCouponPrompt(channel, flowId, pending) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`service_use_coupon_${flowId}`)
      .setLabel("使用優惠券")
      .setEmoji("🎟️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`service_no_coupon_${flowId}`)
      .setLabel("不使用優惠券")
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    content: `<@${pending.customerId}> ${pending.autoQuote ? "系統已完成自動報價" : "客服已完成報價"}，請選擇是否使用優惠券。`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💰 正式報價單")
        .setDescription(
          `服務：${getServiceName(pending.category)}\n` +
            `${buildServiceQuoteAmountText(pending)}\n\n` +
            `請先選擇是否使用優惠券，再選擇付款方式。`
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function sendServiceQuoteConfirmPrompt(channel, flowId, pending) {
  const price = getServiceOriginalPrice(pending);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("報價金額無效");
  await channel.send({
    content: `<@${pending.customerId}> 請先確認報價金額，確認後才會進入優惠券與付款流程。`,
    embeds: [new EmbedBuilder()
      .setColor(QIUNAI_WATER_BLUE)
      .setTitle("💰 請顧客確認報價")
      .setDescription(`服務：${getServiceName(pending.category)}\n${buildServiceQuoteAmountText(pending)}\n\n確認後請選擇優惠券及付款方式；付款完成後系統會自動派單。`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`service_confirm_quote_${flowId}_${price}`).setLabel("確認報價金額").setStyle(ButtonStyle.Success),
    )],
  });
}
async function handleServiceQuoteConfirm(interaction) {
  await deferReplyOnce(interaction);
  const match = /^service_confirm_quote_(.+)_(\d+)$/.exec(interaction.customId);
  if (!match) return interaction.editReply({ content: "❌ 報價確認資料無效。" });
  const [, flowId, quotedPrice] = match;
  const pending = await pendingServiceOrders.get(flowId);
  if (!pending) return interaction.editReply({ content: "❌ 這筆訂單流程已過期，請重新下單。" });
  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({ content: "❌ 只有下單的闆闆可以確認報價。" });
  }
  const price = getServiceOriginalPrice(pending);
  if (price !== Number(quotedPrice) || price <= 0) {
    return interaction.editReply({ content: "❌ 報價已更新，請確認最新的報價訊息。" });
  }
  if (pending.quoteConfirmedPrice === price) {
    return interaction.editReply({ content: "✅ 報價已確認，請使用先前的優惠券選擇訊息。" });
  }
  pending.quoteConfirmedPrice = price;
  await pendingServiceOrders.set(flowId, pending);
  await sendServiceCouponPrompt(interaction.channel, flowId, pending);
  await interaction.message?.edit({ components: [] }).catch(() => null);
  return interaction.editReply({ content: `✅ 已確認報價 NT$${price.toLocaleString("zh-TW")}，請選擇優惠券與付款方式。` });
}
async function sendServicePaymentMethodSelect(channel, flowId, pending) {
  const salaryDeductionEnabled = await isActiveSalaryDeductionStaff(
    pending.customerId,
  );
  const rows = buildPaymentMethodButtonRows(
    `service_payment_method_${flowId}`,
    getGeneralOrderPaymentOptions({
      ecpayAvailable: paymentHelpers.ecpayAvailable,
      salaryEligible: salaryDeductionEnabled,
      amount: getServiceFinalPrice(pending),
    }),
  );

  await channel.send({
    content: `<@${pending.customerId}> 請選擇付款方式。`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💳 選擇付款方式")
        .setDescription(
          `服務：${getServiceName(pending.category)}\n` +
            `${buildServiceQuoteAmountText(pending)}\n\n` +
            `付款完成後請上傳付款證明。`
        )
        .setTimestamp(),
    ],
    components: rows,
  });
}
function resetServiceCouponSelection(pending) {
  const originalPrice = getServiceOriginalPrice(pending);

  pending.finalPrice = originalPrice;
  pending.discountRate = 1;
  pending.discountAmount = 0;
  pending.couponText = "未使用優惠券";
  pending.usedCouponItemId = null;
  pending.usedCouponName = null;
  pending.serviceCouponRecorded = false;
}
async function handleServiceNoCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_no_coupon_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券。",
    });
  }
  if (pending.quoteConfirmedPrice !== getServiceOriginalPrice(pending)) {
    await sendServiceQuoteConfirmPrompt(interaction.channel, flowId, pending);
    return interaction.editReply({ content: "❌ 請先確認最新報價金額。" });
  }

  resetServiceCouponSelection(pending);
  await pendingServiceOrders.set(flowId, pending);

  await sendServicePaymentMethodSelect(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: "✅ 已選擇不使用優惠券，請繼續選擇付款方式。",
  });
}
async function handleServiceUseCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_use_coupon_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券。",
    });
  }
  if (pending.quoteConfirmedPrice !== getServiceOriginalPrice(pending)) {
    await sendServiceQuoteConfirmPrompt(interaction.channel, flowId, pending);
    return interaction.editReply({ content: "❌ 請先確認最新報價金額。" });
  }

  const { data: coupons, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("user_id", interaction.user.id)
    .or("item_type.eq.coupon,item_name.ilike.%折券%,item_name.ilike.%優惠券%")
    .order("created_at", { ascending: false });

  if (couponError) {
    console.error("[新版下單優惠券] 讀取優惠券失敗", couponError);
    return interaction.editReply({
      content: "❌ 讀取優惠券失敗，請稍後再試。",
    });
  }

  if (!coupons?.length) {
    return interaction.editReply({
      content: "❌ 你目前沒有可使用的優惠券。\n" + "請改選「不使用優惠券」。",
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_select_coupon_${flowId}`)
    .setPlaceholder("請選擇要使用的優惠券")
    .addOptions(
      coupons.slice(0, 25).map((coupon) => {
        const discount = getCouponDiscount(coupon.item_name);

        return {
          label: String(coupon.item_name).slice(0, 100),
          description: `${discount.label}｜${
            coupon.description || "優惠券"
          }`.slice(0, 100),
          value: String(coupon.id),
        };
      })
    );

  return interaction.editReply({
    content:
      `🎟️ 請選擇要使用的優惠券：\n\n` +
      `訂單金額：NT$${getServiceOriginalPrice(pending).toLocaleString(
        "zh-TW"
      )}`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}
async function handleServiceSelectCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_select_coupon_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以使用優惠券。",
    });
  }

  const couponId = interaction.values[0];

  const { data: coupon, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("id", Number(couponId))
    .eq("user_id", interaction.user.id)
    .maybeSingle();

  if (
    couponError ||
    !coupon ||
    !(
      coupon.item_type === "coupon" ||
      String(coupon.item_name || "").includes("折券") ||
      String(coupon.item_name || "").includes("優惠券")
    )
  ) {
    return interaction.editReply({
      content: "❌ 找不到這張優惠券，可能已經被使用。",
    });
  }

  const originalPrice = getServiceOriginalPrice(pending);

  if (!originalPrice || originalPrice <= 0) {
    return interaction.editReply({
      content: "❌ 訂單金額錯誤，請聯繫客服重新報價。",
    });
  }

  const maxPrice = getCouponMaxDiscountPrice(coupon.item_name);

  if (maxPrice && originalPrice > maxPrice) {
    return interaction.editReply({
      content:
        `❌ 這張優惠券只限 NT$${maxPrice} 內訂單使用。\n` +
        `目前訂單金額：NT$${originalPrice.toLocaleString("zh-TW")}`,
    });
  }

  const discount = getCouponDiscount(coupon.item_name);
  const finalPrice = discount.fixedAmount
    ? Math.max(0, originalPrice - discount.fixedAmount)
    : Math.floor(originalPrice * discount.rate);
  const discountAmount = originalPrice - finalPrice;

  const { error: deleteError } = await supabase
    .from("user_items")
    .delete()
    .eq("id", coupon.id)
    .eq("user_id", interaction.user.id);

  if (deleteError) {
    console.error("[新版下單優惠券] 刪除優惠券失敗", deleteError);
    return interaction.editReply({
      content: "❌ 套用優惠券失敗，無法從背包移除這張券。",
    });
  }

  pending.finalPrice = finalPrice;
  pending.discountRate = discount.rate;
  pending.discountAmount = discountAmount;
  pending.couponText = coupon.item_name;
  pending.usedCouponItemId = coupon.id;
  pending.usedCouponName = coupon.item_name;
  pending.serviceCouponRecorded = false;
  await pendingServiceOrders.set(flowId, pending);

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("🎟️ 優惠券已套用")
        .setDescription(
          `<@${interaction.user.id}> 已使用：${coupon.item_name}\n\n` +
            `原價：NT$${originalPrice.toLocaleString("zh-TW")}\n` +
            `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
            `折後金額：NT$${finalPrice.toLocaleString("zh-TW")}`
        )
        .setTimestamp(),
    ],
  });

  await sendServicePaymentMethodSelect(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: "✅ 優惠券已套用，請繼續選擇付款方式。",
    components: [],
  });
}
async function openServiceOrderNoteModal(interaction) {
  const flowId = interaction.customId.replace("order_add_note_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_service_order_note_${flowId}`)
    .setTitle("填寫訂單備註");

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("請輸入備註 / 自訂需求")
    .setPlaceholder("例如：指定時間、遊戲名稱、希望氣氛、特殊需求等")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  return interaction.showModal(modal);
}

async function submitServiceOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("submit_service_order_note_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const note = interaction.fields.getTextInputValue("note") || "";

  pending.note = note || "無";
  await pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: "✅ 已儲存備註",
  });
}
async function openSteamGameNameModal(interaction) {
  const flowId = interaction.customId.replace("steam_game_name_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_steam_game_name_${flowId}`)
    .setTitle("Steam 遊戲名稱");

  const gameInput = new TextInputBuilder()
    .setCustomId("game_name")
    .setLabel("請輸入遊戲名稱")
    .setPlaceholder("例如：Lethal Company")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(gameInput));

  return interaction.showModal(modal);
}

async function submitSteamGameName(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("submit_steam_game_name_", "");

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期",
    });
  }

  pending.steamGameName = interaction.fields.getTextInputValue("game_name");

  await pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已設定遊戲名稱：${pending.steamGameName}\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}
function buildServiceTextFromPending(pending) {
  const timeText = pending.duration
    ? `${pending.duration}小時`
    : pending.rounds
    ? `${pending.rounds}局`
    : "";

  if (pending.category === "valorant") {
    return [
      "特戰英豪",
      pending.itemLabel || pending.playMode || pending.serviceType,
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "apex") {
    return [
      "Apex",
      pending.itemLabel || pending.playMode || pending.serviceType,
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }
  if (pending.category === "lol") {
    return [
      "英雄聯盟",
      pending.itemLabel || "未選擇模式",
      pending.playMode || "未選擇陪玩類型",
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "steam") {
    return [
      "Steam",
      pending.steamCategory || pending.itemLabel,
      pending.steamGameName,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "delta") {
    return [
      "三角洲行動",
      pending.deltaPlatform || pending.itemLabel,
      pending.deltaMode,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "other") {
    return [
      "其他項目",
      pending.itemLabel || pending.playMode || pending.serviceType,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "chat") {
    return ["陪聊", timeText].filter(Boolean).join("｜");
  }

  if (pending.category === "emotion") {
    return ["出氣包", timeText].filter(Boolean).join("｜");
  }

  return (
    [
      getServiceName(pending.category),
      pending.itemLabel,
      pending.playMode,
      timeText,
    ]
      .filter(Boolean)
      .join("｜") || "陪玩訂單"
  );
}
function getDispatchServiceKeyFromPending(pending) {
  const text = [
    pending.serviceType,
    pending.itemLabel,
    pending.playMode,
    pending.steamCategory,
    pending.deltaMode,
  ]
    .filter(Boolean)
    .join("");

  if (pending.category === "valorant") {
    if (text.includes("大神")) return "特戰英豪大神陪玩";
    if (text.includes("技術")) return "特戰英豪技術陪玩";
    if (text.includes("娛樂")) return "特戰英豪娛樂陪玩";
    return "特戰英豪";
  }

  if (pending.category === "apex") {
    if (text.includes("大神")) return "Apex大神陪玩";
    if (text.includes("技術")) return "Apex技術陪玩";
    if (text.includes("娛樂")) return "Apex娛樂陪玩";
    return "Apex";
  }
  if (pending.category === "lol") {
    if (text.includes("大神")) return "英雄聯盟大神陪玩";
    if (text.includes("技術")) return "英雄聯盟技術陪玩";
    if (text.includes("娛樂")) return "英雄聯盟娛樂陪玩";
    return "英雄聯盟";
  }

  if (pending.category === "steam") {
    return pending.steamCategory ? `Steam${pending.steamCategory}` : "Steam";
  }

  if (pending.category === "delta") {
    return pending.deltaMode ? `三角洲行動${pending.deltaMode}` : "三角洲行動";
  }

  if (pending.category === "other") {
    return pending.itemLabel || pending.playMode || "其他項目";
  }

  if (pending.category === "chat") {
    return "語音聊天";
  }

  if (pending.category === "emotion") {
    return "出氣包";
  }

  return getServiceName(pending.category);
}
async function createPlayOrderFromServicePending(pending, channelId) {
  const originalAmount = getServiceOriginalPrice(pending);
  const amount = getServiceFinalPrice(pending);

  if (!originalAmount || originalAmount <= 0) {
    throw new Error("尚未報價，不能建立訂單");
  }

  const serviceText = buildServiceTextFromPending(pending);

  return getOrCreateServiceOrder(supabase, {
      guild_id: pending.guildId || process.env.GUILD_ID,
      service_flow_key: pending.flowId ? `${pending.flowId}:${pending.splitRole || "single"}` : null,
      order_group_id: pending.serviceGroupId || null,
      split_role: pending.splitRole || null,
      group_total_price: pending.groupTotalPrice ?? null,

      customer_id: pending.customerId,
      customer_username: pending.customerUsername || `<@${pending.customerId}>`,
      customer_name: `<@${pending.customerId}>`,

      channel_id: channelId,
      source_channel_id: channelId,

      game: getServiceName(pending.category),
      service: serviceText,
      dispatch_service_key: getDispatchServiceKeyFromPending(pending),
      order_type: "訂單",
      order_item: serviceText,

      rank_preference: pending.rank || null,
      player_count: Number(pending.playerCount || 1),
      gender_preference: pending.genderPreference || "不指定",

      preferred_player: null,
      reserved_player: null,
      dispatch_type: null,
      assigned_player: null,

      duration_text: pending.duration
        ? `${pending.duration} 小時`
        : pending.rounds
        ? `${pending.rounds} 局`
        : null,

      note: pending.note || "",

      price: originalAmount,
      original_price: originalAmount,
      final_price: amount,
      discount_rate: Number(pending.discountRate || 1),
      discount_amount: Number(pending.discountAmount || 0),
      coupon_text: pending.couponText || "未使用優惠券",
      payment_method: pending.paymentMethod || null,
      quoted_by: pending.quotedBy || null,
      quote_status: "quoted",

      paid: false,
      paid_at: null,

      salary_paid: false,
      salary_paid_at: null,

      status: "waiting_payment",
    }, getNextPlayOrderNumber);
}
function clonePendingForValorantSplit(
  pending,
  splitRole,
  splitPrice,
  splitFinalPrice,
  splitDiscountAmount,
  splitPlayerCount
) {
  return {
    ...pending,
    splitRole,
    serviceType: splitRole,
    serviceTypes: [splitRole],
    quotedPrice: splitPrice,
    originalPrice: splitPrice,
    finalPrice: splitFinalPrice,
    discountAmount: splitDiscountAmount,
    playerCount: splitPlayerCount,
    quoteParts: null,
  };
}

async function createValorantSplitOrdersFromPending(pending, channelId) {
  const entertainPrice = Number(pending.quoteParts?.entertain || 0);

  const skillPrice = Number(pending.quoteParts?.skill || 0);

  if (!entertainPrice || !skillPrice) {
    throw new Error("娛樂 / 技術報價不完整");
  }

  const groupId = `VG-${pending.flowId}`;

  const originalTotal = entertainPrice + skillPrice;
  const finalTotal = getServiceFinalPrice(pending);
  const totalDiscount = Math.max(0, originalTotal - finalTotal);
  const totalPlayerCount = Math.max(2, Number(pending.playerCount || 2));
  const entertainPlayerCount = Math.max(1, Math.floor(totalPlayerCount / 2));
  const skillPlayerCount = Math.max(1, totalPlayerCount - entertainPlayerCount);

  let entertainFinal = entertainPrice;
  let skillFinal = skillPrice;
  let entertainDiscount = 0;
  let skillDiscount = 0;

  if (totalDiscount > 0 && originalTotal > 0) {
    entertainFinal = Math.floor((entertainPrice * finalTotal) / originalTotal);
    skillFinal = finalTotal - entertainFinal;
    entertainDiscount = entertainPrice - entertainFinal;
    skillDiscount = skillPrice - skillFinal;
  }

  const entertainPending = clonePendingForValorantSplit(
    pending,
    "娛樂",
    entertainPrice,
    entertainFinal,
    entertainDiscount,
    entertainPlayerCount
  );

  const skillPending = clonePendingForValorantSplit(
    pending,
    "技術",
    skillPrice,
    skillFinal,
    skillDiscount,
    skillPlayerCount
  );

  for (const splitPending of [entertainPending, skillPending]) {
    splitPending.serviceGroupId = groupId;
    splitPending.groupTotalPrice = finalTotal;
  }

  const entertainOrder = await createPlayOrderFromServicePending(
    entertainPending,
    channelId
  );

  const skillOrder = await createPlayOrderFromServicePending(
    skillPending,
    channelId
  );

  const totalPrice = finalTotal;

  const { data: orders, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("order_group_id", groupId);

  if (error || orders?.length !== 2) {
    console.error("[特戰分單] 讀取分單失敗", error);
    throw new Error("建立分單後讀取失敗");
  }

  return {
    groupId,
    totalPrice,
    orders,
  };
}
async function recordServiceUsedCoupon(pending, orderOrOrders) {
  if (!pending?.usedCouponItemId || pending.serviceCouponRecorded) {
    return;
  }

  const orders = Array.isArray(orderOrOrders)
    ? orderOrOrders
    : [orderOrOrders].filter(Boolean);
  const firstOrder = orders[0] || null;

  const { error: usedCouponError } = await supabase
    .from("used_coupons")
    .insert({
      user_id: pending.customerId,
      item_id: pending.usedCouponItemId,
      item_name: pending.usedCouponName || pending.couponText,
      order_id: firstOrder?.id || null,
      discount_rate: Number(pending.discountRate || 1),
      discount_amount: Number(pending.discountAmount || 0),
    });

  if (usedCouponError) {
    console.log("[新版下單優惠券紀錄失敗]", usedCouponError.message);
  }

  pending.serviceCouponRecorded = true;
  await pendingServiceOrders.set(pending.flowId, pending);
}
async function sendServiceWalletConfirm(interaction, order, orderGroup) {
  const isGroup = !!orderGroup;

  const totalAmount = isGroup
    ? Number(orderGroup.totalPrice || 0)
    : Number(order.final_price || order.price || 0);

  const confirmId = isGroup
    ? `service_confirm_wallet_group_${orderGroup.groupId}`
    : `service_confirm_wallet_${order.id}`;

  const cancelId = isGroup
    ? `service_cancel_wallet_group_${orderGroup.groupId}`
    : `service_cancel_wallet_${order.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("確認使用儲值卡付款")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("取消此付款方式")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("💳 確認儲值卡付款")
        .setDescription(
          `請確認是否使用儲值卡 / 錢包付款。\n\n` +
            `扣款金額：NT$${totalAmount.toLocaleString("zh-TW")}\n\n` +
            (isGroup
              ? `此為特戰娛樂＋技術合併付款，系統會一次扣總額，扣款後分開派單。`
              : `確認後會直接從你的 ASD 餘額扣款。`)
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}

async function sendServiceMonthlyConfirm(interaction, order, orderGroup) {
  const isGroup = !!orderGroup;

  const totalAmount = isGroup
    ? Number(orderGroup.totalPrice || 0)
    : Number(order.final_price || order.price || 0);

  const confirmId = isGroup
    ? `service_confirm_monthly_group_${orderGroup.groupId}`
    : `service_confirm_monthly_${order.id}`;

  const cancelId = isGroup
    ? `service_cancel_monthly_group_${orderGroup.groupId}`
    : `service_cancel_monthly_${order.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("確認使用月結付款")
      .setEmoji("🌙")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("取消此付款方式")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(QIUNAI_WATER_BLUE)
        .setTitle("🌙 確認月結付款")
        .setDescription(
          `請確認是否使用月結額度付款。\n\n` +
            `扣額金額：NT$${totalAmount.toLocaleString("zh-TW")}\n\n` +
            (isGroup
              ? `此為特戰娛樂＋技術合併付款，系統會一次扣總額，扣款後分開派單。`
              : `確認後會直接扣除你的月結可用額度。`)
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function handleServicePaymentMethodSelect(interaction) {
  await deferReplyOnce(interaction);
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "service_payment_method_");
  const flowId = selection?.entityId;

  const pending = await pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇付款方式。",
    });
  }
  if (pending.quoteConfirmedPrice !== getServiceOriginalPrice(pending)) {
    await sendServiceQuoteConfirmPrompt(interaction.channel, flowId, pending);
    return interaction.editReply({ content: "❌ 請先確認最新報價金額。" });
  }

  const paymentMethod = selection?.paymentMethod;

  if (pending.checkoutStarted && pending.paymentMethod !== paymentMethod) {
    return interaction.editReply({ content: "這筆需求已建立付款確認，請使用原付款訊息；如需更改付款方式，請聯繫客服。" });
  }

  if (paymentMethod === "街口支付" && !paymentHelpers.jkopayAvailable) {
    return interaction.editReply({ content: "❌ 街口支付目前無法使用，請稍後再試或改選其他付款方式。" });
  }
  if (paymentMethod === "綠界支付" && !paymentHelpers.ecpayAvailable) {
    return interaction.editReply({ content: "❌ 綠界信用卡付款目前尚未開放，請改選其他付款方式。" });
  }
  if (paymentMethod === "綠界支付" && selection?.requestedMethod &&
      !isGeneralEcpayAmountAllowed(selection.requestedMethod, getServiceFinalPrice(pending))) {
    return interaction.editReply({ content: "❌ 此訂單金額不適用所選的綠界付款方式，請改選其他方式。" });
  }

  pending.paymentMethod = paymentMethod;
  pending.checkoutStarted = true;
  await pendingServiceOrders.set(flowId, pending);

  if (paymentMethod === "員工扣薪" || paymentMethod === "扣薪") {
    const amount = getServiceFinalPrice(pending);
    try {
      const eligibility = await getSalaryDeductionEligibility(
        pending.customerId,
        amount,
      );
      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: pending.customerId,
        amount,
        eligibility,
        confirmId: `salary_service_confirm_${flowId}`,
        cancelId: `salary_service_cancel_${flowId}`,
        transferId: `salary_service_transfer_${flowId}`,
      });
      return interaction.editReply({
        content: "✅ 已送出扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      pending.paymentMethod = null;
      pending.checkoutStarted = false;
      await pendingServiceOrders.set(flowId, pending);
      return interaction.editReply({
        content: `❌ 無法使用扣薪付款：${err.message || err}`,
      });
    }
  }

  let order = null;
  let orderGroup = null;
  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];
  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術") &&
    pending.quoteParts;
  try {
    if (isValorantSplit) {
      orderGroup = await createValorantSplitOrdersFromPending(
        pending,
        interaction.channel.id
      );
    } else {
      order = await createPlayOrderFromServicePending(
        pending,
        interaction.channel.id
      );
    }
    await recordServiceUsedCoupon(
      pending,
      orderGroup ? orderGroup.orders : order
    );
  } catch (err) {
    console.error("[新版下單] 建立訂單失敗", err);
    return interaction.editReply({
      content: `❌ 建立訂單失敗：${err.message || err}`,
    });
  }
  if (paymentMethod === "儲值卡") {
    await sendServiceWalletConfirm(interaction, order, orderGroup);
    return interaction.editReply({
      content: "✅ 已選擇儲值卡 / 錢包付款，請確認是否使用此付款方式。",
    });
  }
  if (paymentMethod === "月結") {
    await sendServiceMonthlyConfirm(interaction, order, orderGroup);
    return interaction.editReply({
      content: "✅ 已選擇月結付款，請確認是否使用此付款方式。",
    });
  }
  if (paymentMethod === "街口支付" || paymentMethod === "綠界支付") {
    const ecpay = paymentMethod === "綠界支付";
    const createPayment = ecpay ? paymentHelpers.createEcpayServicePayment : paymentHelpers.createJkopayServicePayment;
    if (!createPayment) return interaction.editReply({ content: `❌ ${paymentMethod}尚未完成設定。` });
    const orders = orderGroup ? orderGroup.orders : [order];
    const amount = orders.reduce(
      (sum, current) => sum + Number(current.final_price || current.price || 0),
      0,
    );
    const entityKey = orderGroup ? `group-${orderGroup.groupId}` : String(order.id);
    try {
      const payment = await createPayment({
        kind: "order",
        entityKey,
        userId: pending.customerId,
        amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${orderGroup?.groupId || order.order_no || order.id}`,
        metadata: {
          flow: "service",
          orderIds: orders.map((current) => current.id),
          orderGroupId: orderGroup?.groupId || null,
        },
      });
      if (ecpay && selection?.requestedMethod) {
        payment.onlyMethod = selection.requestedMethod;
        if (selection.requestedMethod !== "CARD") payment.preferredMethod = selection.requestedMethod;
      }
      await (ecpay ? sendEcpayPaymentPrompt : sendJkopayPaymentPrompt)(interaction.channel, pending.customerId, amount, payment, "訂單");
      await pendingServiceOrders.delete(flowId);
      return interaction.editReply({ content: `✅ 已建立${paymentMethod}付款連結，付款完成後會自動核帳並派單。` });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立${paymentMethod}付款失敗：${err.message || err}` });
    }
  }

  if (paymentMethod === "匯款") {
    await sendBankTransferInfo(interaction.channel);
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  }

  if (paymentMethod === "無卡") {
    await sendNoCardPaymentInfo(interaction.channel);
  }

  if (paymentMethod === "加密貨幣" || paymentMethod === "虛擬貨幣" || paymentMethod === "美金轉帳") {
    await interaction.channel.send({
      content:
        `<@${pending.customerId}> 你選擇了${paymentMethod}付款。\n` +
        `請等待客服提供${paymentMethod === "美金轉帳" ? "轉帳帳號" : "錢包地址"}，付款後請上傳付款證明。`,
    });
  }

  const confirmCustomId = orderGroup
    ? `service_confirm_paid_group_${orderGroup.groupId}`
    : `service_confirm_paid_${order.id}`;
  const cancelCustomId = orderGroup
    ? `service_cancel_order_group_${orderGroup.groupId}`
    : `service_cancel_order_${order.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmCustomId)
      .setLabel("客服確認付款，派單")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cancelCustomId)
      .setLabel("取消訂單")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 客人已選擇付款方式：${paymentMethod}\n` +
      (orderGroup
        ? `本次為特戰娛樂＋技術合併付款，合計 NT$${orderGroup.totalPrice.toLocaleString(
            "zh-TW"
          )}。\n`
        : "") +
      `付款完成並確認明細後，請按「客服確認付款，派單」。`,
    components: [row],
  });

  await pendingServiceOrders.delete(flowId);

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${paymentMethod}，請依照頻道內資訊完成付款。`,
  });
}

async function handleSalaryServiceConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認扣薪付款。",
    });
  }

  const flowId = interaction.customId.replace("salary_service_confirm_", "");
  const pending = await pendingServiceOrders.get(flowId);
  if (!pending || pending.paymentMethod !== "扣薪") {
    return interaction.editReply({
      content: "❌ 這筆扣薪付款已過期或已處理，請重新下單。",
    });
  }

  const amount = getServiceFinalPrice(pending);
  let createdOrderIds = [];
  let paymentCompleted = false;
  try {
    const latestEligibility = await getSalaryDeductionEligibility(
      pending.customerId,
      amount,
    );
    if (!latestEligibility.state.canUse) {
      throw new Error(
        `本筆確認後會預支 NT$${latestEligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過 NT$${latestEligibility.state.advanceLimit.toLocaleString("zh-TW")} 上限`,
      );
    }

    const serviceTypes = Array.isArray(pending.serviceTypes)
      ? pending.serviceTypes
      : [];
    const isValorantSplit =
      pending.category === "valorant" &&
      serviceTypes.includes("娛樂") &&
      serviceTypes.includes("技術") &&
      pending.quoteParts;
    let order = null;
    let orderGroup = null;
    if (isValorantSplit) {
      orderGroup = await createValorantSplitOrdersFromPending(
        pending,
        interaction.channel.id,
      );
      createdOrderIds = orderGroup.orders.map((item) => item.id);
    } else {
      order = await createPlayOrderFromServicePending(
        pending,
        interaction.channel.id,
      );
      createdOrderIds = [order.id];
    }

    await recordServiceUsedCoupon(
      pending,
      orderGroup ? orderGroup.orders : order,
    );
    const result = await applySalaryDeductionToOrders({
      customerId: pending.customerId,
      amount,
      orderIds: createdOrderIds,
      finalStatus: "pending",
      quoteStatus: "dispatched",
    });
    paymentCompleted = true;

    for (const paidOrder of result.orders) {
      if (paymentHelpers.countOrderVipSpentOnce) {
        await paymentHelpers.countOrderVipSpentOnce(
          paidOrder,
          "員工扣薪付款完成",
        );
      }
      const dispatchOrder = await markPaidOrderDispatchPending(paidOrder.id);
      await deliverPaidOrder(dispatchOrder, interaction.channel);
    }

    await pendingServiceOrders.delete(flowId);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 扣薪付款完成")
          .setDescription(
            `<@${pending.customerId}> 已使用薪資支付 NT$${amount.toLocaleString("zh-TW")}。\n` +
              `EIP 已新增扣項：使用薪水點單\n` +
              `由 <@${interaction.user.id}> 確認，系統已自動派單。`,
          )
          .setTimestamp(),
      ],
    });
    return interaction.editReply({
      content: "✅ 已確認扣薪付款、建立 EIP 扣項並完成派單。",
    });
  } catch (err) {
    if (!paymentCompleted && createdOrderIds.length) {
      await supabase
        .from("play_orders")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .in("id", createdOrderIds)
        .eq("paid", false);
    }
    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 扣薪與 EIP 扣項已完成，但派單通知發送失敗，請客服人工確認：${err.message || err}`
        : `❌ 扣薪付款失敗：${err.message || err}`,
    });
  }
}

async function handleSalaryServiceCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消扣薪付款。",
    });
  }

  const flowId = interaction.customId.replace("salary_service_cancel_", "");
  const pending = await pendingServiceOrders.get(flowId);
  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆扣薪付款已過期或已處理。",
    });
  }

  pending.paymentMethod = null;
  pending.checkoutStarted = false;
  await pendingServiceOrders.set(flowId, pending);
  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendServicePaymentMethodSelect(
    interaction.channel,
    flowId,
    pending,
  );
  return interaction.editReply({
    content: "✅ 已取消扣薪付款，請員工重新選擇付款方式。",
  });
}

async function handleSalaryServiceTransfer(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({ content: "❌ 只有客服或管理員可以選擇差額轉帳。" });
  }
  const flowId = interaction.customId.replace("salary_service_transfer_", "");
  const pending = await pendingServiceOrders.get(flowId);
  if (!pending || pending.paymentMethod !== "扣薪") {
    return interaction.editReply({ content: "❌ 這筆扣薪付款已過期或已處理。" });
  }
  const amount = getServiceFinalPrice(pending);
  const eligibility = await getSalaryDeductionEligibility(pending.customerId, amount);
  const salaryAmount = Math.min(amount, Math.max(0, eligibility.state.availableBefore));
  const transferAmount = amount - salaryAmount;
  if (transferAmount <= 0) {
    return interaction.editReply({ content: "❌ 目前薪資已足夠，請直接按確認使用扣薪。" });
  }

  pending.paymentMethod = "扣薪＋轉帳";
  pending.salarySplit = { salaryAmount, transferAmount };
  await pendingServiceOrders.set(flowId, pending);
  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendBankTransferInfo(interaction.channel);
  await interaction.channel.send({
    content:
      `<@${pending.customerId}> 本筆將從薪資扣除 NT$${salaryAmount.toLocaleString("zh-TW")}，` +
      `請另行轉帳 NT$${transferAmount.toLocaleString("zh-TW")}。\n` +
      `收到轉帳明細後，請客服確認差額已入帳。`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`salary_service_split_confirm_${flowId}`)
          .setLabel("確認差額已入帳並派單")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
  return interaction.editReply({ content: "✅ 已改為扣薪加轉帳補齊差額。" });
}

async function handleSalaryServiceSplitConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({ content: "❌ 只有客服或管理員可以確認差額入帳。" });
  }
  const flowId = interaction.customId.replace("salary_service_split_confirm_", "");
  const pending = await pendingServiceOrders.get(flowId);
  if (!pending || pending.paymentMethod !== "扣薪＋轉帳" || !pending.salarySplit) {
    return interaction.editReply({ content: "❌ 這筆差額付款已過期或已處理。" });
  }

  const amount = getServiceFinalPrice(pending);
  const salaryAmount = Number(pending.salarySplit.salaryAmount || 0);
  const transferAmount = amount - salaryAmount;
  if (salaryAmount < 0 || transferAmount <= 0) {
    return interaction.editReply({ content: "❌ 差額付款金額錯誤。" });
  }

  let createdOrderIds = [];
  let paymentCompleted = false;
  try {
    const serviceTypes = Array.isArray(pending.serviceTypes) ? pending.serviceTypes : [];
    const isValorantSplit =
      pending.category === "valorant" &&
      serviceTypes.includes("娛樂") &&
      serviceTypes.includes("技術") &&
      pending.quoteParts;
    let orders;
    if (isValorantSplit) {
      const orderGroup = await createValorantSplitOrdersFromPending(pending, interaction.channel.id);
      orders = orderGroup.orders;
    } else {
      orders = [await createPlayOrderFromServicePending(pending, interaction.channel.id)];
    }
    createdOrderIds = orders.map((order) => order.id);
    await recordServiceUsedCoupon(pending, orders.length > 1 ? orders : orders[0]);

    let paidOrders;
    if (salaryAmount > 0) {
      const result = await applySalaryDeductionToOrders({
        customerId: pending.customerId,
        amount: salaryAmount,
        orderIds: createdOrderIds,
        finalStatus: "pending",
        quoteStatus: "dispatched",
        paymentMethod: "扣薪＋轉帳",
      });
      paidOrders = result.orders;
    } else {
      const paidAt = new Date().toISOString();
      const { data, error } = await supabase
        .from("play_orders")
        .update({
          payment_method: "轉帳補齊差額",
          paid: true,
          paid_at: paidAt,
          status: "pending",
          quote_status: "dispatched",
          dispatch_status: "pending",
          dispatch_last_error: null,
          updated_at: paidAt,
        })
        .in("id", createdOrderIds)
        .eq("paid", false)
        .select("*");
      if (error || data?.length !== createdOrderIds.length) {
        throw new Error(error?.message || "訂單付款狀態已變更");
      }
      paidOrders = data;
    }
    paymentCompleted = true;

    for (const paidOrder of paidOrders) {
      if (paymentHelpers.countOrderVipSpentOnce) {
        await paymentHelpers.countOrderVipSpentOnce(paidOrder, "扣薪加轉帳付款完成");
      }
      const dispatchOrder = await markPaidOrderDispatchPending(paidOrder.id);
      await deliverPaidOrder(dispatchOrder, interaction.channel);
    }
    await pendingServiceOrders.delete(flowId);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ 扣薪＋轉帳付款完成").setDescription(
        `<@${pending.customerId}> 本筆共 NT$${amount.toLocaleString("zh-TW")}。\n` +
        `薪資扣除：NT$${salaryAmount.toLocaleString("zh-TW")}\n` +
        `轉帳補齊：NT$${transferAmount.toLocaleString("zh-TW")}\n` +
        `確認客服：<@${interaction.user.id}>，系統已自動派單。`,
      ).setTimestamp()],
    });
    return interaction.editReply({ content: "✅ 已確認差額入帳、建立 EIP 扣項並完成派單。" });
  } catch (err) {
    if (!paymentCompleted && createdOrderIds.length) {
      await supabase.from("play_orders").update({ status: "cancelled", updated_at: new Date().toISOString() }).in("id", createdOrderIds).eq("paid", false);
    }
    return interaction.editReply({ content: `❌ 差額付款完成失敗：${err.message || err}` });
  }
}
async function handleServiceConfirmWallet(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("service_confirm_wallet_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !order) {
    console.error("[儲值卡確認] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  if (!isUnpaidWaitingOrder(order)) {
    if (order.paid && order.dispatch_status === "dispatched") {
      await interaction.message?.edit({ components: [] }).catch(() => null);
      return interaction.editReply({
        content: "✅ 這張訂單先前已完成付款與派單，本次沒有重複扣款。",
      });
    }
    if (order.paid && !["cancelled", "completed", "accepted"].includes(order.status)) {
      try {
        const dispatchOrder = !["pending", "processing", "failed"].includes(order.dispatch_status)
          ? await markPaidOrderDispatchPending(order.id)
          : order;
        const recovered = await deliverPaidOrder(dispatchOrder, interaction.channel);
        await interaction.message?.edit({ components: [] }).catch(() => null);
        return interaction.editReply({
          content: recovered.inProgress
            ? "⚠️ 付款已完成，派單正在由另一個程序處理，請稍候。"
            : "✅ 付款先前已完成，本次只補派 Discord 訊息，沒有重複扣款。",
        });
      } catch (dispatchError) {
        return interaction.editReply({
          content: `⚠️ 付款已完成且沒有重複扣款，但補派失敗：${dispatchError.message || dispatchError}`,
        });
      }
    }
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return interaction.editReply({ content: "訂單已付款或已結束，未重複扣款或派單。" });
  }

  let paymentCompleted = false;
  try {
    const result = await paymentHelpers.payOrderByWallet(order, {
      dispatchAfterPayment: true,
    });
    paymentCompleted = true;

    await deliverPaidOrder(result.order || order, interaction.channel);

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 儲值卡付款完成")
          .setDescription(
            `<@${order.customer_id}> 已確認使用儲值卡付款。\n\n` +
              `扣款金額：${Number(result.amount || 0).toLocaleString(
                "zh-TW"
              )} ASD\n` +
              `剩餘餘額：${Number(result.finalCoins || 0).toLocaleString(
                "zh-TW"
              )} ASD\n\n` +
              `系統已自動派單。`
          )
          .setTimestamp(),
      ],
    });

    await interaction.message?.edit({ components: [] }).catch(() => null);

    return interaction.editReply({
      content: "✅ 儲值卡付款成功，已派單。",
    });
  } catch (err) {
    console.error("[儲值卡確認] 付款或派單失敗", err);

    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ ASD 扣款已完成，本次不會再扣款；Discord 派單將自動補發：${err.message || err}`
        : `❌ 儲值卡付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceConfirmMonthly(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("service_confirm_monthly_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !order) {
    console.error("[月結確認] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  if (!isUnpaidWaitingOrder(order)) {
    if (order.paid && order.dispatch_status === "dispatched") {
      await interaction.message?.edit({ components: [] }).catch(() => null);
      return interaction.editReply({
        content: "✅ 這張訂單先前已完成月結扣額與派單，本次沒有重複扣額。",
      });
    }
    if (order.paid && !["cancelled", "completed", "accepted"].includes(order.status)) {
      try {
        const dispatchOrder = !["pending", "processing", "failed"].includes(order.dispatch_status)
          ? await markPaidOrderDispatchPending(order.id)
          : order;
        const recovered = await deliverPaidOrder(dispatchOrder, interaction.channel);
        await interaction.message?.edit({ components: [] }).catch(() => null);
        return interaction.editReply({
          content: recovered.inProgress
            ? "⚠️ 付款已完成，派單正在由另一個程序處理，請稍候。"
            : "✅ 付款先前已完成，本次只補派 Discord 訊息，沒有重複扣除月結額度。",
        });
      } catch (dispatchError) {
        return interaction.editReply({
          content: `⚠️ 月結已扣額且沒有重複扣款，但補派失敗：${dispatchError.message || dispatchError}`,
        });
      }
    }
    await interaction.message?.edit({ components: [] }).catch(() => null);
    return interaction.editReply({ content: "訂單已付款或已結束，未重複扣款或派單。" });
  }

  let paymentCompleted = false;
  try {
    const result = await paymentHelpers.payOrderByMonthly(order, {
      dispatchAfterPayment: true,
    });
    paymentCompleted = true;

    await deliverPaidOrder(result.order || order, interaction.channel);

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 月結付款完成")
          .setDescription(
            `<@${order.customer_id}> 已確認使用月結付款。\n\n` +
              `本次扣額：NT$${Number(result.amount || 0).toLocaleString(
                "zh-TW"
              )}\n` +
              `剩餘月結額度：NT$${Number(
                result.availableAmount || 0
              ).toLocaleString("zh-TW")}\n\n` +
              `系統已自動派單。`
          )
          .setTimestamp(),
      ],
    });

    await interaction.message?.edit({ components: [] }).catch(() => null);

    return interaction.editReply({
      content: "✅ 月結付款成功，已派單。",
    });
  } catch (err) {
    console.error("[月結確認] 付款或派單失敗", err);

    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 月結扣額已完成，本次不會再扣額；Discord 派單將自動補發：${err.message || err}`
        : `❌ 月結付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceGroupPayment(interaction, method) {
  await deferReplyOnce(interaction);
  const groupId = interaction.customId.replace(method === "wallet" ? "service_confirm_wallet_group_" : "service_confirm_monthly_group_", "");
  try {
    const { data, error } = await supabase.rpc("qiunai_pay_service_group", {
      p_group_id: groupId, p_customer_id: interaction.user.id,
      p_guild_id: interaction.guildId || interaction.guild?.id || process.env.GUILD_ID,
      p_method: method,
    });
    if (error) throw new Error(error.message || "合併付款失敗，未扣款。");
    const orders = data?.orders;
    if (!orders?.length) throw new Error("未取得付款結果，請客服核對訂單狀態。");
    const amount = Number(data.amount || 0);
    const receipt = data.receipt || {};
    await paymentHelpers.recordAccountingLedger?.({
      entry_type: method === "wallet" ? "customer_spend_wallet_group" : "customer_spend_monthly_group",
      entry_label: "客人消費", amount, revenue_amount: amount,
      ...(method === "wallet" ? {liability_amount: -amount} : {receivable_amount: amount}),
      payment_method: method === "wallet" ? "儲值卡 / 錢包" : "月結",
      customer_id: interaction.user.id, order_id: groupId, order_no: groupId,
      source_table: "play_orders", source_id: `group:${groupId}`,
      dedupe_key: `play_orders:group:${groupId}:customer_spend_${method}`,
      note: "特戰娛樂＋技術合併付款", metadata: {order_ids:orders.map(order=>order.id)},
    });
    for (const order of orders) {
      await paymentHelpers.countOrderVipSpentOnce?.(order, "特戰合併付款完成");
      await deliverPaidOrder(order, interaction.channel);
    }
    await interaction.message?.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({content: `✅ 特戰合併付款完成，共 NT$${amount.toLocaleString("zh-TW")}。
${method === "wallet" ? "剩餘 ASD：" + Number(receipt.balance || 0).toLocaleString("zh-TW") : "剩餘月結額度：NT$" + Number(receipt.available_amount || 0).toLocaleString("zh-TW")}
娛樂與技術已分開派單。`});
    return interaction.editReply({content:"✅ 合併付款完成，原付款按鈕已關閉。"});
  } catch (error) {
    // RPC 若回報「已付款」，可能是上一輪已扣款但 Discord 發送中斷。
    // 此時只補派，不再次呼叫付款 RPC。
    const { data: paidOrders } = await supabase
      .from("play_orders")
      .select("*")
      .eq("order_group_id", groupId)
      .eq("customer_id", interaction.user.id)
      .eq("guild_id", interaction.guildId || interaction.guild?.id || process.env.GUILD_ID)
      .eq("paid", true);
    const recoverable = (paidOrders || []).filter((order) =>
      ["pending", "processing", "failed"].includes(order.dispatch_status),
    );
    if (paidOrders?.length === 2 && recoverable.length) {
      try {
        const amount = paidOrders.reduce(
          (total, order) => total + Number(order.final_price || order.price || 0),
          0,
        );
        await paymentHelpers.recordAccountingLedger?.({
          entry_type: method === "wallet" ? "customer_spend_wallet_group" : "customer_spend_monthly_group",
          entry_label: "客人消費",
          amount,
          revenue_amount: amount,
          ...(method === "wallet" ? { liability_amount: -amount } : { receivable_amount: amount }),
          payment_method: method === "wallet" ? "儲值卡 / 錢包" : "月結",
          customer_id: interaction.user.id,
          order_id: groupId,
          order_no: groupId,
          source_table: "play_orders",
          source_id: `group:${groupId}`,
          dedupe_key: `play_orders:group:${groupId}:customer_spend_${method}`,
          note: "特戰娛樂＋技術合併付款",
          metadata: { order_ids: paidOrders.map((order) => order.id) },
        });
        for (const paidOrder of paidOrders) {
          await paymentHelpers.countOrderVipSpentOnce?.(paidOrder, "特戰合併付款完成");
          await deliverPaidOrder(paidOrder, interaction.channel);
        }
        await interaction.message?.edit({ components: [] }).catch(() => null);
        return interaction.editReply({
          content: "✅ 合併付款先前已完成，本次只補派 Discord 訊息，沒有重複扣款。",
        });
      } catch (dispatchError) {
        return interaction.editReply({
          content: `⚠️ 合併付款已完成且沒有重複扣款，但補派仍失敗：${dispatchError.message || dispatchError}`,
        });
      }
    }
    return interaction.editReply({content:`❌ ${error.message || error}`});
  }
}
async function handleServiceConfirmWalletGroup(interaction) {
  return handleServiceGroupPayment(interaction, "wallet");
}
async function handleServiceConfirmMonthlyGroup(interaction) {
  return handleServiceGroupPayment(interaction, "monthly");
}
async function handleServiceConfirmPaidGroup(interaction) {
  return transitionServicePayment(interaction, "service_confirm_paid_group_", true, "confirm");
}
async function handleServiceConfirmPaid(interaction) {
  return transitionServicePayment(interaction, "service_confirm_paid_", false, "confirm");
}
async function handleServiceCancelOrderGroup(interaction) {
  return transitionServicePayment(interaction, "service_cancel_order_group_", true, "cancel");
}
async function handleServiceCancelOrder(interaction) {
  return transitionServicePayment(interaction, "service_cancel_order_", false, "cancel");
}
async function handleDispatchInteraction(interaction) {
  const customId = interaction.customId || "";
  const paymentSelection = [
    "quote_payment_method_",
    "extension_payment_method_",
    "topup_payment_method_",
    "service_payment_method_",
  ].map((prefix) => getPaymentMethodSelection(interaction, prefix)).find(Boolean);
  const key = paymentSelection?.entityId ||
    customId.match(/(VG-[\w-]+|[0-9a-f]{8}-[0-9a-f-]{27}|\d{16,22}_\d{13})$/i)?.[1];
  return guardOrderOperation(key, async () => {
    // Once checkout starts, old requirements/coupon/quote controls cannot rewrite its amount.
    if (key && /^\d{16,22}_\d{13}$/.test(key) &&
        /^(service_|submit_service_|order_|valorant_|apex_|lol_|steam_|delta_)/.test(customId) &&
        !customId.startsWith("service_payment_method_")) {
      const flow = await pendingServiceOrders.get(key);
      if (flow?.checkoutStarted) {
        await deferReplyOnce(interaction);
        await interaction.editReply({ content: "這筆需求已進入付款階段，請使用最新付款訊息。如需修改，請聯繫客服。" });
        return true;
      }
    }
    return handleDispatchInteractionInner(interaction);
  }, async () => {
    await deferReplyOnce(interaction);
    await interaction.editReply({ content: "這筆訂單正在處理，請稍候，勿重複操作。" });
    return true;
  });
}

async function handleDispatchInteractionInner(interaction) {
  if (interaction.isButton?.() && interaction.customId === "payment_review_back") {
    await interaction.update({ content: "已返回付款方式，請在原本的付款選單重新選擇。", components: [] });
    return true;
  }
  if (interaction.isButton?.()) {
    const reviewSelection = [
      "quote_payment_method_",
      "extension_payment_method_",
      "topup_payment_method_",
      "service_payment_method_",
    ].map((prefix) => getPaymentMethodSelection(interaction, prefix)).find((selection) => selection?.requiresConfirmation);
    if (reviewSelection) {
      await deferReplyOnce(interaction);
      await interaction.editReply({
        content: `確認使用「${interaction.component?.label || reviewSelection.paymentMethod}」？按返回可重新選擇，不會立即扣款或建立付款單。`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(interaction.customId.replace(/__review$/, ""))
            .setLabel("確認此付款方式").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("payment_review_back")
            .setLabel("返回付款方式").setStyle(ButtonStyle.Secondary),
        )],
      });
      return true;
    }
  }
  if (workReportSystem && (await workReportSystem.handleInteraction(interaction))) {
    return true;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "上班") {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.commandName === "下班") {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.commandName === "我的狀態") {
      await playerStatus(interaction);
      return true;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("ecpay_direct_")) {
      return handleEcpayDirect(interaction, supabase, process.env.ECPAY_PUBLIC_BASE_URL);
    }
    if (interaction.customId.startsWith("quote_payment_method_")) {
      await handleQuotePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extension_payment_method_")) {
      await handleExtensionPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("topup_payment_method_")) {
      await handleTopupPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_payment_method_")) {
      await handleServicePaymentMethodSelect(interaction);
      return true;
    }
    // ===== 陪玩控制 =====
    if (interaction.customId === "self_service_start") {
      await startSelfServiceOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_quote_yes_")) {
      await confirmSelfServiceQuote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_quote_no_")) {
      await cancelSelfServiceOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_cancel_refund_")) {
      await cancelAndRefundSelfServiceOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("manual_quote_dispatch_")) {
      await confirmManualQuoteAndDispatch(interaction);
      return true;
    }
    if (interaction.customId.startsWith("manual_quote_cancel_")) {
      await cancelManualQuotedOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_selection_extend_")) {
      await extendSelfServiceSelectionTime(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_claim_")) {
      await openSelfServiceClaimModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_quantity_")) {
      await openSelfServiceQuantityModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_players_confirm_")) {
      await confirmSelfServicePlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_players_reselect_")) {
      await reselectSelfServicePlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_pay_wallet_")) {
      await paySelfServiceOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_prepare_")) {
      await prepareSelfServicePayment(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_payment_back_")) {
      await backToSelfServicePayment(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_cancel_order_")) {
      await cancelSelfServiceBeforePayment(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_pay_jkopay_") || interaction.customId.startsWith("self_service_pay_ecpay_")) {
      await paySelfServiceOrderByGateway(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_extend_")) {
      await openSelfServiceExtensionModal(interaction);
      return true;
    }
    if (interaction.customId === "open_topup_modal") {
      await openTopupModal(interaction);
      return true;
    }
    if (interaction.customId === "open_jkopay_topup_modal") {
      await openTopupModal(interaction, { jkopayOnly: true });
      return true;
    }
    if (interaction.customId.startsWith("confirm_topup_")) {
      await confirmTopup(interaction);
      return true;
    }
    if (interaction.customId === "order_start_valorant") {
      await createServiceTicket(interaction, "valorant");
      return true;
    }

    if (interaction.customId === "order_start_steam") {
      await createServiceTicket(interaction, "steam");
      return true;
    }

    if (interaction.customId === "order_start_delta") {
      await createServiceTicket(interaction, "delta");
      return true;
    }

    if (interaction.customId === "order_start_chat") {
      await createServiceTicket(interaction, "chat");
      return true;
    }

    if (interaction.customId === "order_start_emotion") {
      await createServiceTicket(interaction, "emotion");
      return true;
    }

    if (
      interaction.customId === "order_start_topup" ||
      interaction.customId.startsWith("order_start_topup_amount_")
    ) {
      await createTopupTicket(
        interaction,
        parseTopupPresetAmount(interaction.customId),
      );
      return true;
    }
    if (
      interaction.customId === "jkopay_topup_start" ||
      interaction.customId.startsWith("jkopay_topup_amount_")
    ) {
      await createTopupTicket(
        interaction,
        parseJkopayTopupPresetAmount(interaction.customId),
        { jkopayOnly: true },
      );
      return true;
    }

    if (interaction.customId === "order_start_tip") {
      await createTipTicket(interaction);
      return true;
    }
    if (interaction.customId === "order_start_crown") {
      await createTipTicket(interaction, "crown");
      return true;
    }
    if (interaction.customId.startsWith("valorant_type_")) {
      await handleValorantTypeButton(interaction);
      return true;
    }

    if (interaction.customId.startsWith("valorant_mode_")) {
      await handleValorantModeButton(interaction);
      return true;
    }
    if (interaction.customId.startsWith("order_add_note_")) {
      await openServiceOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("steam_game_name_")) {
      await openSteamGameNameModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("order_finish_need_")) {
      await finishServiceNeed(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_quote_price_")) {
      await openServiceQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_quote_")) {
      await handleServiceQuoteConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_no_coupon_")) {
      await handleServiceNoCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_use_coupon_")) {
      await handleServiceUseCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_confirm_")) {
      await handleSalaryQuoteConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_split_confirm_")) {
      await handleSalaryQuoteSplitConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_transfer_")) {
      await handleSalaryQuoteTransfer(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_cancel_")) {
      await handleSalaryQuoteCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_confirm_")) {
      await handleSalaryServiceConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_split_confirm_")) {
      await handleSalaryServiceSplitConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_transfer_")) {
      await handleSalaryServiceTransfer(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_cancel_")) {
      await handleSalaryServiceCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_wallet_group_")) {
      await handleServiceConfirmWalletGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_monthly_group_")) {
      await handleServiceConfirmMonthlyGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_wallet_")) {
      await handleServiceConfirmWallet(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_monthly_")) {
      await handleServiceConfirmMonthly(interaction);
      return true;
    }
    if (
      interaction.customId.startsWith("service_cancel_wallet_") ||
      interaction.customId.startsWith("service_cancel_monthly_")
    ) {
      await interaction.reply({
        content: "已取消此付款方式，請重新選擇付款方式或聯繫客服。",
        flags: 64,
      });
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_paid_group_")) {
      await handleServiceConfirmPaidGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_cancel_order_group_")) {
      await handleServiceCancelOrderGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_paid_")) {
      await handleServiceConfirmPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_cancel_order_")) {
      await handleServiceCancelOrder(interaction);
      return true;
    }
    if (interaction.customId === "open_play_order_form") {
      await openPlayOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("change_order_price_")) {
      await openChangeOrderPriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("confirm_order_price_adjustment_")) {
      await confirmPaidWalletPriceAdjustment(interaction);
      return true;
    }
    if (interaction.customId.startsWith("confirm_order_paid_gap_")) {
      await confirmPaidWalletPriceAdjustment(interaction);
      return true;
    }
    if (interaction.customId.startsWith("save_order_note_")) {
      await openSaveOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("saved_order_end_")) {
      await handleSavedOrderEnd(interaction);
      return true;
    }
    if (interaction.customId.startsWith("dispatch_assign_players_")) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId === "player_online") {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.customId === "player_offline") {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.customId === "player_status") {
      await playerStatus(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_note_yes_")) {
      await openNewOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_back_")) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_note_no_")) {
      await handleNewOrderNoNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_quote_price_")) {
      await openStaffQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_ai_quote_")) {
      await handleStaffAiQuote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("dispatch_assign_players_")) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_confirm_order_paid_")) {
      await handleStaffConfirmOrderPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_no_coupon_")) {
      await handleQuoteNoCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_confirm_price_")) {
      await handleOrderQuotePriceConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_use_coupon_")) {
      await handleQuoteUseCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("customer_confirm_order_")) {
      await handleCustomerConfirmOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("customer_order_wrong_")) {
      await handleCustomerOrderWrong(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_edit_order_")) {
      await openStaffEditOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_back_")) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extend_order_")) {
      await openExtendOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_extension_confirm_")) {
      await handleSalaryExtensionConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_extension_cancel_")) {
      await handleSalaryExtensionCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("confirm_extension_wallet_")) {
      await handleConfirmExtensionWallet(interaction);
      return true;
    }
    if (interaction.customId.startsWith("cancel_extension_wallet_")) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({
          flags: 64,
        });
      }
      return interaction.editReply({
        content: "已取消加時儲值卡付款，請重新選擇付款方式或聯繫客服。",
      });
    }
    if (interaction.customId.startsWith("staff_confirm_extension_paid_")) {
      await handleStaffConfirmExtensionPaid(interaction);
      return true;
    }
    //  ==== 接單 =====
    if (interaction.customId.startsWith("accept_play_order_")) {
      await acceptPlayOrder(interaction);
      return true;
    }
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("self_service_claim_submit_")) {
      await claimSelfServiceOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_quantity_submit_")) {
      await submitSelfServiceQuantity(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_requirement_")) {
      await submitSelfServiceRequirement(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_extension_submit_")) {
      await submitSelfServiceExtension(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_staff_edit_order_")) {
      await submitStaffEditOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_staff_quote_price_")) {
      await submitStaffQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_service_quote_price_")) {
      await submitServiceQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_service_order_note_")) {
      await submitServiceOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_steam_game_name_")) {
      await submitSteamGameName(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_new_order_note_")) {
      await submitNewOrderNote(interaction);
      return true;
    }
    if (interaction.customId === "submit_topup_form") {
      await submitTopupForm(interaction);
      return true;
    }
    if (interaction.customId === "submit_jkopay_topup_form") {
      await submitTopupForm(interaction, { jkopayOnly: true });
      return true;
    }
    if (interaction.customId.startsWith("submit_change_order_price_")) {
      await submitChangeOrderPrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_save_order_note_")) {
      await submitSaveOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_extend_order_")) {
      await submitExtendOrder(interaction);
      return true;
    }
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("self_customer_numbers_")) {
      await selectSelfServicePlayerNumbers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_game_")) {
      await selectSelfServiceGame(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_gender_")) {
      await openSelfServiceRequirementModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_valorant_target_")) {
      await selectSelfServiceValorantTarget(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_valorant_companion_")) {
      await selectSelfServiceValorantCompanion(interaction);
      return true;
    }
    if (interaction.customId.startsWith("self_service_delta_players_")) {
      await selectSelfServiceDeltaPlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("game_order_select_")) {
      await handleGameOrderSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("lol_style_select_")) {
      await handleLolStyleSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("other_game_style_select_")) {
      await handleOtherGameStyleSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_select_coupon_")) {
      await handleQuoteSelectCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_payment_method_")) {
      await handleQuotePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("valorant_rank_")) {
      await handleValorantRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("valorant_type_select_")) {
      await handleValorantTypeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("apex_rank_")) {
      await handleApexRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("lol_rank_")) {
      await handleLolRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_player_count_")) {
      await handleServicePlayerCountSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith("service_gender_")) {
      await handleServiceGenderSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith("service_duration_")) {
      await handleServiceDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_rounds_")) {
      await handleServiceRoundsSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_select_coupon_")) {
      await handleServiceSelectCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("steam_category_")) {
      await handleSteamCategorySelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("delta_mode_")) {
      await handleDeltaModeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_payment_method_")) {
      await handleServicePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_game_")) {
      await handleNewOrderGameSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_item_")) {
      await handleNewOrderItemSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_rank_")) {
      await handleNewOrderRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_count_")) {
      await handleNewOrderCountSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_gender_")) {
      await handleNewOrderGenderSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_duration_")) {
      await handleNewOrderDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_dispatch_players_")) {
      await submitDispatchPlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("topup_payment_method_")) {
      await handleTopupPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extension_payment_method_")) {
      await handleExtensionPaymentMethodSelect(interaction);
      return true;
    }
  }
  return false;
}

async function handleJkopayServicePaid({ payment, transaction }) {
  const ecpay = payment.provider === "ecpay";
  const paymentLabel = ecpay ? "綠界" : "街口";
  const paymentMethod = `${paymentLabel}支付`;
  const providerKey = ecpay ? "ecpay" : "jkopay";
  const paymentSourceTable = ecpay ? "ecpay_service_payments" : "jkopay_service_payments";
  const metadata = payment.metadata || {};
  const channel = payment.channel_id
    ? await client.channels.fetch(payment.channel_id).catch(() => null)
    : null;
  const paidAt = new Date().toISOString();

  if (payment.payment_kind === "order") {
    const orderIds = Array.isArray(metadata.orderIds)
      ? metadata.orderIds.map(String).filter(Boolean)
      : [String(payment.entity_key || "")].filter(Boolean);
    const serviceFlow = metadata.flow === "service";
    const selfServiceFlow = metadata.flow === "self_service";
    const selfServicePlayerIds = Array.isArray(metadata.selectedPlayerIds)
      ? metadata.selectedPlayerIds.map(String).filter(Boolean)
      : [];
    let paidOrders;
    let error;
    if (ecpay) {
      const result = await supabase.rpc("qiunai_mark_ecpay_orders_paid", {
        p_merchant_trade_no: payment.platform_order_id,
        p_guild_id: process.env.GUILD_ID,
      });
      error = result.error;
      paidOrders = result.data?.orders || [];
    } else {
      const result = await supabase.from("play_orders").update({
        payment_method: paymentMethod,
        paid: true,
        paid_at: paidAt,
        status: selfServiceFlow ? "accepted" : serviceFlow ? "pending" : "waiting_confirm",
        ...((serviceFlow || selfServiceFlow) ? { quote_status: "dispatched" } : {}),
        ...(serviceFlow
          ? { dispatch_status: "pending", dispatch_last_error: null }
          : {}),
        ...(selfServiceFlow
          ? {
              assigned_player: selfServicePlayerIds.join(","),
              preferred_player: selfServicePlayerIds.join(","),
              accepted_at: paidAt,
            }
          : {}),
        updated_at: paidAt,
      })
      .in("id", orderIds)
      .eq("paid", false)
      .select("*");
      paidOrders = result.data;
      error = result.error;
    }
    if (error) throw new Error(error.message || `更新${paymentLabel}訂單付款狀態失敗`);
    // 街口 callback 可能在「付款已入 DB、Discord 尚未送出」時中斷。
    // 重送 callback 時不再次改付款，只載入原 paid 訂單繼續補派。
    if (!ecpay && !paidOrders?.length) {
      const current = await supabase
        .from("play_orders")
        .select("*")
        .in("id", orderIds)
        .eq("paid", true);
      if (current.error) throw new Error(current.error.message || "讀取已付款街口訂單失敗");
      paidOrders = current.data || [];
    }
    if (!paidOrders.length) throw new Error(`${paymentLabel}付款成功，但找不到可恢復的已付款訂單`);
    for (const order of paidOrders) {
      await paymentHelpers.countOrderVipSpentOnce?.(order, `${paymentMethod}付款完成`);
      if (selfServiceFlow) {
        const selectedIds = selfServicePlayerIds.length
          ? selfServicePlayerIds
          : String(order.preferred_player || "").split(",").filter(Boolean);
        if (!selectedIds.length) throw new Error("自助訂單缺少已選擇的陪陪資料");
        if (channel?.isTextBased()) {
          for (const playerId of selectedIds) {
            await channel.permissionOverwrites.edit(playerId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
            });
          }
          await workReportSystem.sendForAcceptedOrder(order, selectedIds);
          await sendStaffOrderControlPanel(channel, order);
          await channel.send({
            content: `<@${order.customer_id}> ${selectedIds.map((id) => `<@${id}>`).join(" ")}`,
            embeds: [
              new EmbedBuilder()
                .setColor("#57F287")
                .setTitle(`✅ ${paymentLabel}付款核對完成，報單已發送`)
                .setDescription(
                  `訂單：${order.order_no}\n付款：NT$${Number(payment.amount).toLocaleString("zh-TW")}\n陪陪：${selectedIds.map((id) => `<@${id}>`).join("、")}\n\n系統已將陪陪加入本頻道，並發送時間填寫報單。`,
                )
                .setTimestamp(),
            ],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`self_service_extend_${order.id}`)
                  .setLabel("我要加時")
                  .setStyle(ButtonStyle.Primary),
              ),
            ],
          });
        }
        pendingSelfServiceOrders.delete(`selection:${order.id}`);
        pendingSelfServiceOrders.delete(`candidatePrompt:${order.id}`);
      } else if (serviceFlow) {
        try {
          await deliverPaidOrder(order, channel?.isTextBased() ? channel : null);
        } catch (dispatchError) {
          // 金流款項已確認入帳，派單失敗必須與付款狀態分離。
          // order 仍保留 pending/failed，背景補派排程會繼續處理；
          // 不將付款單退回 pending，也不會要求客人重付。
          console.error(
            `[${paymentLabel}付款] ${order.order_no || order.id} 已入帳，Discord 待補派`,
            dispatchError,
          );
          await channel?.send?.({
            content:
              `<@${order.customer_id}> ✅ ${paymentLabel}付款已入帳，不需要重複付款。\n` +
              `⚠️ Discord 派單訊息正在自動補發，客服不可再次扣款。`,
            allowedMentions: { users: [String(order.customer_id)] },
          }).catch(() => null);
        }
      } else if (order.quote_status === "price_confirmed" || channel?.isTextBased()) {
        await sendCustomerFinalConfirm(channel, order);
      }
    }
    await paymentHelpers.recordAccountingLedger?.({
      entry_type: `customer_order_${providerKey}`,
      entry_label: "客人消費",
      amount: Number(payment.amount),
      revenue_amount: Number(payment.amount),
      cash_amount: Number(payment.amount),
      payment_method: paymentMethod,
      customer_id: payment.user_id,
      order_id: metadata.orderGroupId || orderIds[0],
      order_no: metadata.orderNo || metadata.orderGroupId || null,
      source_table: paymentSourceTable,
      source_id: payment.platform_order_id,
      dedupe_key: `${providerKey}-service:${payment.platform_order_id}:order`,
      note: `${paymentLabel}交易 ${transaction.tradeNo}`,
      metadata: { order_ids: orderIds, trade_no: transaction.tradeNo },
    });
    if (channel?.isTextBased() && !selfServiceFlow) {
      await channel.send({
        embeds: [new EmbedBuilder().setColor("#57F287").setTitle(`✅ ${paymentLabel}訂單付款完成`).setDescription(
          `<@${payment.user_id}> 已完成${paymentMethod} NT$${Number(payment.amount).toLocaleString("zh-TW")}。\n` +
            `${paymentLabel}訂單編號：${payment.platform_order_id}\n` +
            (selfServiceFlow
              ? "系統已自動加入陪陪並發送報單。"
              : serviceFlow
                ? "系統已自動派單。"
                : order.quote_status === "price_confirmed" ? "系統已自動派單。" : "請繼續確認訂單內容。"),
        ).setTimestamp()],
      });
    }
    return;
  }

  if (payment.payment_kind === "extension") {
    const extensionId = String(metadata.extensionId || payment.entity_key || "");
    let extension;
    let error;
    if (ecpay) {
      const result = await supabase.rpc("qiunai_mark_ecpay_extension_paid", {
        p_merchant_trade_no: payment.platform_order_id,
        p_guild_id: process.env.GUILD_ID,
      });
      extension = result.data;
      error = result.error;
    } else {
      const result = await supabase.from("order_extensions").update({
        payment_method: paymentMethod,
        paid: true,
        status: "paid",
        paid_at: paidAt,
        updated_at: paidAt,
      })
      .eq("id", extensionId)
      .or("paid.eq.false,paid.is.null")
      .select("*")
      .maybeSingle();
      extension = result.data;
      error = result.error;
    }
    if (error) throw new Error(error.message || "更新街口加時付款狀態失敗");
    if (!extension) return;
    const salaryResult = extension.applied_to_salary ? null : await applyExtensionToPlayOrder(extension);
    await paymentHelpers.recordAccountingLedger?.({
      entry_type: `customer_extension_${providerKey}`,
      entry_label: "客人消費",
      amount: Number(payment.amount),
      revenue_amount: Number(payment.amount),
      cash_amount: Number(payment.amount),
      payment_method: paymentMethod,
      customer_id: payment.user_id,
      order_id: extension.order_id || extension.order_no || null,
      order_no: extension.order_no || null,
      source_table: paymentSourceTable,
      source_id: payment.platform_order_id,
      dedupe_key: `${providerKey}-service:${payment.platform_order_id}:extension`,
      note: `加時 ${extension.extension_text || ""}｜${paymentLabel}交易 ${transaction.tradeNo}`,
    });
    await paymentHelpers.recordSpendActivity?.({
      userId: payment.user_id,
      amount: Number(payment.amount),
      sourceKey: `${providerKey}-service:${payment.platform_order_id}:extension`,
      note: `加時${paymentMethod} ${extension.order_no || extension.order_id}`,
    });
    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [new EmbedBuilder().setColor("#57F287").setTitle(`✅ 加時${paymentLabel}付款完成`).setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount).toLocaleString("zh-TW")}\n` +
            `${paymentLabel}訂單編號：${payment.platform_order_id}` +
            (salaryResult ? `\n薪資網金額已更新為 NT$${salaryResult.newPrice.toLocaleString("zh-TW")}` : ""),
        ).setTimestamp()],
      });
    }
    return;
  }

  throw new Error(`不支援的街口付款類型：${payment.payment_kind}`);
}

module.exports = {
  setup,
  handleDispatchInteraction,
  sendPlayerPanel,
  sendGameOrderPanels,
  startPricingPanelScheduler,
  startPaidOrderDispatchRecovery,
  startFinancialEffectsRecovery,
  sendSelfServiceOrderPanel,
  sendJkopayTopupPanel,
  restoreSelfServiceDispatchTimers,
  sendTipOrderPanel,
  startNewOrderFlow,
  sendDailyPlayerSummary,
  getNewOrderGameOptions,
  getOrderItemOptions,
  getManualDispatchChannelId,
  getClaimDispatchChannelId,
  isManualDispatchOrder,
  getSelfServiceDispatchRoleIds,
  getSelfServiceDispatchAt,
  getSelfServiceSelectionDeadline,
  extendSelfServiceSelectionDeadline,
  getSelfServiceThreadName,
  getDispatchResultThreadName,
  getPendingClaimThreadOrderId,
  getClaimThreadOutcome,
  isSelfServiceClaimMessage,
  resolveSelfServicePlayerNumbers,
  getPaidOrderPriceAdjustment,
  getSelfServiceCancellationRefundAmount,
  requiresManualTimeoutReview,
  appendSelfServiceClaimNote,
  getSelfServiceClaimNotes,
  getSelfServiceClaimTypes,
  getSelfServiceClaimTypeLabel,
  parseSelfServiceClaimAction,
  stripSelfServiceClaimNotes,
  TOPUP_PRESET_AMOUNTS,
  parseTopupPresetAmount,
  parseJkopayTopupPresetAmount,
  shouldPreserveDispatchedOrder,
  deferReplyOnce,
  submitTopupForm,
  openTopupModal,
  openPlayOrderModal,
  openChangeOrderPriceModal,
  submitChangeOrderPrice,
  openSaveOrderNoteModal,
  submitSaveOrderNote,
  sendOrderToStaffChannel,
  openDispatchPlayerMenu,
  submitDispatchPlayers,
  handleSavedOrderEnd,
  sendWorkReportPanel: () => workReportSystem?.sendManualPanel(),
  ensureStaffReportChannel: (staff, options) =>
    workReportSystem?.ensureStaffReportChannel(staff, options),
  startCrownReminderScheduler: () =>
    workReportSystem?.startCrownReminderScheduler(),
  sendTipWorkReports: (orders, payload) =>
    workReportSystem?.sendForCompletedTipOrders(orders, payload),
  getSalaryDeductionEligibility,
  createSalaryDeductionPrompt,
  applySalaryDeductionPayment,
  handleJkopayServicePaid,
};
