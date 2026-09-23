const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const gifts = require("../config/tipGifts");
const tipBroadcasts = require("../config/tipBroadcasts");
const crownPackages = require("../config/crownPackages");
const {
  buildCrownOrderItem,
  getCrownPackageByKey,
} = require("../utils/crownOrders");
const {
  formatReviewCustomer,
  shouldPublishReview,
} = require("../utils/reviews");
const { parseAllowedServices } = require("../utils/services");
const {
  chooseHigherCommission,
  getManualCommissionRate,
  getOrderCommissionBase,
} = require("../utils/salaryCommission");
const {
  buildTopupTopic,
  getNextTopupNumber,
  getTopupNumberFromTopic,
  normalizeTopupNumber,
} = require("../utils/topupNumbers");
const {
  buildJkopayRefundPayload,
  buildPlatformOrderId,
  buildServicePlatformOrderId,
  isAllowedCallbackIp,
  normalizeJkopayInquiryOrderId,
  normalizeJkopayRefundOrderId,
  normalizeJkopayPlatformOrderId,
  parseCallbackIps,
  signJkopayPayload,
} = require("../utils/jkopay");
const {
  QIUNAI_CUSTOMER_SERVICE_IDS,
  calculateCustomerServiceReceptionPay,
  getSeptemberShiftCommissionRate,
  hasCustomerServicePointRole,
  recordCustomerServiceReception,
  recordCustomerServicePoint,
} = require("../utils/customerServicePoints");
const {
  DELTA_SERVICE_OPTIONS,
  GAME_OPTIONS,
  calculateSelfServicePrice,
  getDeltaFixedPlayerCount,
  getValorantCompanionOptions,
  getValorantExpectedUnit,
  getActiveValorantPrices,
  isOctoberValorantPricingActive,
} = require("../config/selfServicePricing");
const {
  appendSelfServiceClaimNote,
  getSelfServiceClaimNotes,
  getSelfServiceClaimTypes,
  getSelfServiceClaimTypeLabel,
  parseSelfServiceClaimAction,
  getSelfServiceDispatchAt,
  getSelfServiceSelectionDeadline,
  extendSelfServiceSelectionDeadline,
  getSelfServiceThreadName,
  getDispatchResultThreadName,
  getSelfServiceDispatchRoleIds,
  getManualDispatchChannelId,
  getClaimDispatchChannelId,
  isManualDispatchOrder,
  stripSelfServiceClaimNotes,
  resolveSelfServicePlayerNumbers,
  getPaidOrderPriceAdjustment,
  TOPUP_PRESET_AMOUNTS,
  parseTopupPresetAmount,
  parseJkopayTopupPresetAmount,
} = require("../events/dispatchSystem");
const {
  getCanonicalPaymentOptions,
} = require("../utils/paymentMethodEmojis");

test("購買星雨幣面板提供快捷金額並直接進入付款流程", () => {
  assert.deepEqual(TOPUP_PRESET_AMOUNTS, [100, 250, 500, 1000, 3000, 5000, 10000, 15000]);
  for (const amount of TOPUP_PRESET_AMOUNTS) {
    assert.equal(parseTopupPresetAmount(`order_start_topup_amount_${amount}`), amount);
  }
  assert.equal(parseTopupPresetAmount("order_start_topup_amount_999"), null);
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /\.setLabel\("建立訂單"\)/);
  assert.match(indexSource, /\[100, 250, 500, 1000\]/);
  assert.match(indexSource, /\[3000, 5000, 10000, 15000\]/);
  assert.match(indexSource, /\.setLabel\("快速金額"\)[\s\S]*?\.setDisabled\(true\)/);
  assert.match(indexSource, /components: \[row, quickAmountLabelRow, quickAmountRow, quickAmountFinalRow\]/);
  assert.match(dispatchSource, /const checkout = normalizedPreset[\s\S]*prepareTopupCheckout/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /儲值星雨幣|建立儲值單/);
});

test("街口自助購幣面板只走整合後的街口支付並支援快速購買", () => {
  for (const amount of TOPUP_PRESET_AMOUNTS) {
    assert.equal(parseJkopayTopupPresetAmount(`jkopay_topup_amount_${amount}`), amount);
  }
  assert.equal(parseJkopayTopupPresetAmount("jkopay_topup_amount_999"), null);
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(dispatchSource, /1546726352240115712/);
  assert.match(dispatchSource, /付款方式：僅限街口支付/);
  assert.match(dispatchSource, /jkopay_topup_start/);
  assert.match(dispatchSource, /jkopay_topup_amount_/);
  assert.match(dispatchSource, /createJkopayTopupPaymentMessage/);
  assert.match(indexSource, /街口自助購幣面板/);
});

test("自助下單可使用整合後的街口支付並於付款後自動發送報單", () => {
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(dispatchSource, /self_service_pay_jkopay_/);
  assert.match(dispatchSource, /flow: "self_service"/);
  assert.match(dispatchSource, /selectedPlayerIds: selectedIds/);
  assert.match(dispatchSource, /\$\{paymentLabel\}付款核對完成，報單已發送/);
  assert.match(dispatchSource, /jkopay: "街口支付"/);
  assert.match(dispatchSource, /wallet: "錢包扣款"/);
});

test("歷史互動錯誤的防護仍保留", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /ensureCompletedOrderChannelAccess/);
  assert.match(dispatchSource, /interaction\.message\.flags\?\.has\(64\)/);
  assert.match(dispatchSource, /Number\(err\?\.code\) === 10008/);
  assert.match(dispatchSource, /if \(!\/\^\\d\{16,22\}\$\/\.test\(channelId\)\) return/);
});

test("自助下單依現行價目表計算多人與時數", () => {
  assert.equal(
    GAME_OPTIONS.some(({ value, label }) => value === "voice_chat" && label === "語音聊天"),
    true,
  );
  assert.deepEqual(
    DELTA_SERVICE_OPTIONS.map(({ value }) => value),
    ["娛樂陪玩", "機密雙護", "機密雙護保底", "猛攻護航", "猛攻護航保底"],
  );
  assert.equal(getDeltaFixedPlayerCount("機密雙護"), 2);
  assert.equal(getDeltaFixedPlayerCount("機密雙護保底"), 2);
  assert.equal(getDeltaFixedPlayerCount("猛攻護航"), null);
  assert.throws(
    () => calculateSelfServicePrice({
      game: "delta",
      platformOrMode: "手機",
      serviceType: "雙護",
      rankOrMap: "航天基地",
      playerCount: "2",
      quantity: "1",
    }),
    /請輸入完整名稱/,
  );
  assert.deepEqual(
    getValorantCompanionOptions("黃金以下").map(({ value }) => value),
    ["娛樂", "黃金含以下", "白金", "鑽石", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("N/A").map(({ value }) => value),
    ["娛樂", "黃金含以下", "白金", "鑽石", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("白金").map(({ value }) => value),
    ["娛樂", "白金", "鑽石", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("鑽石").map(({ value }) => value),
    ["娛樂", "鑽石", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("超凡").map(({ value }) => value),
    ["娛樂", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("神話1至2").map(({ value }) => value),
    ["神話", "輻能", "頂輻"],
  );
  assert.throws(
    () =>
      calculateSelfServicePrice({
        game: "valorant",
        platformOrMode: "排位",
        serviceType: "鑽石",
        rankOrMap: "白金",
        playerCount: "1",
        quantity: "1",
      }),
    /不可低於要打的段位/,
  );
  assert.throws(
    () =>
      calculateSelfServicePrice({
        game: "valorant",
        platformOrMode: "排位",
        serviceType: "鑽石",
        rankOrMap: "鑽石",
        playerCount: "1",
        quantity: "1",
      }),
    /沒有這個特戰段位/,
  );
  assert.equal(
    getValorantExpectedUnit({ serviceType: "黃金以下", rankOrMap: "頂輻" }),
    "小時",
  );
  assert.equal(
    getValorantExpectedUnit({ serviceType: "超凡", rankOrMap: "娛樂" }),
    "小時",
  );
  assert.equal(
    getValorantExpectedUnit({ serviceType: "超凡", rankOrMap: "頂輻" }),
    "局",
  );
  assert.equal(
    getValorantExpectedUnit({ serviceType: "N/A", rankOrMap: "頂輻" }),
    "小時",
  );
  assert.deepEqual(
    calculateSelfServicePrice({
      game: "valorant",
      platformOrMode: "一般",
      serviceType: "未列出的娛樂段位",
      rankOrMap: "娛樂",
      playerCount: "1",
      quantity: "1",
    }),
    { unitPrice: 250, total: 250, unit: "小時", quantity: 1, playerCount: 1 },
  );
  assert.deepEqual(
    calculateSelfServicePrice({
      game: "valorant",
      platformOrMode: "排位",
      serviceType: "超凡",
      rankOrMap: "頂輻",
      playerCount: "2",
      quantity: "3",
    }),
    { unitPrice: 295, total: 1770, unit: "局", quantity: 3, playerCount: 2 },
  );
  assert.deepEqual(
    calculateSelfServicePrice({
      game: "apex",
      platformOrMode: "排位",
      serviceType: "技術",
      rankOrMap: "白金",
      playerCount: "2",
      quantity: "1.5",
    }),
    { unitPrice: 310, total: 930, unit: "小時", quantity: 1.5, playerCount: 2 },
  );
  assert.equal(
    calculateSelfServicePrice({
      game: "delta",
      platformOrMode: "手機",
      serviceType: "猛攻護航保底",
      rankOrMap: "航天基地",
      playerCount: "1",
      quantity: "2",
    }).total,
    2200,
  );
});

test("語音聊天可從自助下單填寫，並依半小時單位轉客服正式報價", () => {
  assert.throws(
    () => calculateSelfServicePrice({
      game: "voice_chat",
      platformOrMode: "Discord 語音",
      serviceType: "日常聊天",
      rankOrMap: "無",
      playerCount: "1",
      quantity: "0.25",
    }),
    /0\.5 小時/,
  );
  assert.throws(
    () => calculateSelfServicePrice({
      game: "voice_chat",
      platformOrMode: "Discord 語音",
      serviceType: "日常聊天",
      rankOrMap: "無",
      playerCount: "1",
      quantity: "1.5",
    }),
    /尚缺自動報價/,
  );
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(dispatchSource, /\["platform_mode", "聊天平台 \/ 方式"/);
  assert.match(dispatchSource, /if \(game === "voice_chat"\) return "語音聊天"/);
  assert.match(dispatchSource, /service\.includes\("語音聊天"\)[\s\S]*?CHAT_ROLE_ID/);
});

test("特戰新價目表於 2026/10/1 台灣時間自動生效", () => {
  const before = "2026-09-30T15:59:59.999Z";
  const effective = "2026-09-30T16:00:00.000Z";
  assert.equal(isOctoberValorantPricingActive(before), false);
  assert.equal(isOctoberValorantPricingActive(effective), true);
  assert.equal(getActiveValorantPrices(before).gold.entertain[0], 250);
  assert.equal(getActiveValorantPrices(effective).gold.entertain[0], 280);
  assert.deepEqual(
    calculateSelfServicePrice({
      game: "valorant",
      platformOrMode: "排位",
      serviceType: "超凡",
      rankOrMap: "頂輻",
      playerCount: "2",
      quantity: "3",
      pricingDate: effective,
    }),
    { unitPrice: 340, total: 2040, unit: "局", quantity: 3, playerCount: 2 },
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "assets", "panels", "valorant-pricing-2026-10.jpg")),
    true,
  );
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(dispatchSource, /startPricingPanelScheduler/);
  assert.match(dispatchSource, /valorant-pricing-2026-10\.jpg/);
});

test("街口支付依官方規格使用 HMAC-SHA256 簽章", () => {
  const payload =
    '{"platform_order_id":"demo-order-001","store_id":"35f12dff-1581-11e9-a054-00505684fd45","currency": "TWD","total_price":10,"final_price":10,"unredeem":10,"result_display_url":"https://display.com","result_url":"https://result-callback.xxx/xxx"}';
  const secret =
    "r0odDC1e9LHXDmxuvmOv9bgaWLf2CXB2c4gMheoFucVKNMi1K0Id9zwRHJF1r-kdtAKriKgb11VDlo7Kb8R-FQ";
  assert.equal(
    signJkopayPayload(payload, secret),
    "3577609b058ab85c2d0a00a5421a991979ed6b9f549476e9a82476dc1b70d876",
  );
});

test("街口付款單沿用唯一儲值編號並限制 callback IP", () => {
  assert.equal(buildPlatformOrderId("TOP-0000000123"), "QIUNAI-TOP-0000000123");
  assert.throws(() => buildPlatformOrderId("TOP-123"), /格式錯誤/);
  const allowed = parseCallbackIps("125.227.158.50, 35.194.172.6");
  assert.equal(isAllowedCallbackIp("::ffff:125.227.158.50", allowed), true);
  assert.equal(isAllowedCallbackIp("203.0.113.10", allowed), false);
});

test("街口訂單、加時與打賞使用可區分且穩定的付款編號", () => {
  assert.equal(buildServicePlatformOrderId("QIUNAI", "order", "abc-123"), "QIUNAI-ORD-ABC123");
  assert.equal(buildServicePlatformOrderId("QIUNAI", "extension", "ext-9"), "QIUNAI-EXT-EXT9");
  assert.equal(buildServicePlatformOrderId("DEEPNIGHT", "tip", "tip_456"), "DEEPNIGHT-TIP-TIP456");
  assert.throws(() => buildServicePlatformOrderId("QIUNAI", "unknown", "1"), /格式錯誤/);
});

test("街口查詢接受一般訂單、加時及打賞的正式付款編號", () => {
  assert.equal(
    normalizeJkopayInquiryOrderId("qiunai-ord-65df819729ee4c46ade285923af3f464"),
    "QIUNAI-ORD-65DF819729EE4C46ADE285923AF3F464",
  );
  assert.equal(
    normalizeJkopayInquiryOrderId("QIUNAI-EXT-ABC123"),
    "QIUNAI-EXT-ABC123",
  );
  assert.equal(
    normalizeJkopayInquiryOrderId("DEEPNIGHT-TIP-DEF456"),
    "DEEPNIGHT-TIP-DEF456",
  );
  assert.throws(
    () => normalizeJkopayInquiryOrderId("QIUNAI-ORD-ABC 123"),
    /格式錯誤/,
  );
});

test("街口退款接受秋奈儲值單與官網商品單並建立整筆退款 payload", () => {
  assert.equal(
    normalizeJkopayPlatformOrderId("top-0000000123"),
    "QIUNAI-TOP-0000000123",
  );
  assert.deepEqual(buildJkopayRefundPayload("QIUNAI-TOP-0000000123", 100), {
    platform_order_id: "QIUNAI-TOP-0000000123",
    refund_amount: 100,
  });
  assert.equal(
    normalizeJkopayRefundOrderId("wash-1788518426000-a1b2c3d4e5"),
    "WASH-1788518426000-A1B2C3D4E5",
  );
  assert.deepEqual(buildJkopayRefundPayload("WASH-1788518426000-A1B2C3D4E5", 490), {
    platform_order_id: "WASH-1788518426000-A1B2C3D4E5",
    refund_amount: 490,
  });
  assert.equal(
    normalizeJkopayRefundOrderId("qiunai-ord-65df819729ee4c46ade285923af3f464"),
    "QIUNAI-ORD-65DF819729EE4C46ADE285923AF3F464",
  );
  assert.deepEqual(
    buildJkopayRefundPayload("DEEPNIGHT-EXT-ABC123", 250),
    { platform_order_id: "DEEPNIGHT-EXT-ABC123", refund_amount: 250 },
  );
  assert.throws(() => buildJkopayRefundPayload("WASH-123", 100), /格式錯誤/);
  assert.throws(
    () => buildJkopayRefundPayload("QIUNAI-TOP-0000000123", 0),
    /金額錯誤/,
  );
});

test("秋奈街口支付合併串接按鈕與交易 QR Code 並保留可用性防護", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /\.setLabel\("建立訂單"\)/);
  assert.match(indexSource, /const JKOPAY_METHOD = "街口支付"/);
  assert.match(dispatchSource, /const JKOPAY_METHOD = "街口支付"/);
  assert.equal(
    getCanonicalPaymentOptions()[0].description,
    "線上付款連結與街口掃碼整合於同一選項",
  );
  assert.match(dispatchSource, /if \(payment\.qrImg\) embed\.setImage\(payment\.qrImg\)/);
  assert.match(indexSource, /if \(payment\.qrImg\) paymentEmbed\.setImage\(payment\.qrImg\)/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /街口支付線上付款|街口掃碼（可刷卡）|JKOPAY_SCAN_METHOD/);
  assert.match(dispatchSource, /ecpay \? paymentHelpers\.ecpayAvailable : paymentHelpers\.jkopayAvailable/);
  assert.match(indexSource, /\.setName\("街口退款"\)/);
  assert.match(indexSource, /refundPayment/);
  assert.match(indexSource, /1545380103675052092/);
  assert.match(indexSource, /sendJkopayRefundPanel/);
  assert.match(indexSource, /sendJkopayRefundAudit/);
  assert.match(indexSource, /\.setName\("街口查詢"\)/);
  assert.match(indexSource, /inquirePayment/);
  assert.match(indexSource, /sendJkopayInquiryAudit/);
  assert.match(indexSource, /Inquiry 結果/);
  assert.match(indexSource, /interaction\.channelId !== JKOPAY_REFUND_CHANNEL_ID/);
  const jkopaySource = fs.readFileSync(
    path.join(__dirname, "..", "utils", "jkopay.js"),
    "utf8",
  );
  assert.match(jkopaySource, /refund_reversal_pending/);
  assert.match(jkopaySource, /onValidateServiceRefund/);
  assert.match(jkopaySource, /onServiceRefunded/);
  assert.doesNotMatch(jkopaySource, /^\s*unredeem:\s*0,/m);
  assert.match(jkopaySource, /\[JKOPAY\]\[INQUIRY\]\[REQUEST\]/);
  assert.match(jkopaySource, /\/payments\/jkopay\/gateway\/refund/);
  assert.match(jkopaySource, /jkopay_service_payments/);
  assert.match(jkopaySource, /\/payments\/jkopay\/service-result/);
  assert.match(dispatchSource, /createJkopayServicePayment/);
  assert.match(dispatchSource, /kind: "order"/);
  assert.match(dispatchSource, /kind: "extension"/);
  assert.match(indexSource, /kind: "tip"/);
  assert.match(indexSource, /打賞\$\{paymentLabel\}付款完成/);
  const refundMigration = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "supabase",
      "migrations",
      "20260904_jkopay_topup_refund.sql",
    ),
    "utf8",
  );
  assert.match(refundMigration, /prepare_jkopay_topup_refund/);
  assert.match(refundMigration, /complete_jkopay_topup_refund/);
  assert.match(refundMigration, /JKOPAY_ASD_BALANCE_INSUFFICIENT/);
});

test("街口支付在各付款選單只出現一次且加時可使用月結付款", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const menuSlices = [
    ["async function sendPaymentMethodSelect", "async function handleQuotePaymentMethodSelect", "getGeneralOrderPaymentOptions"],
    ["async function sendExtensionPaymentMethodSelect", "async function handleExtensionPaymentMethodSelect", "getCanonicalPaymentOptions"],
    ["function buildTopupPaymentMethodRows", "function prepareTopupCheckout", "getCanonicalPaymentOptions"],
    ["async function sendServicePaymentMethodSelect", "function resetServiceCouponSelection", "getGeneralOrderPaymentOptions"],
  ];
  for (const [start, end, optionsBuilder] of menuSlices) {
    const source = dispatchSource.slice(dispatchSource.indexOf(start), dispatchSource.indexOf(end));
    assert.equal(source.split(`${optionsBuilder}(`).length - 1, 1);
  }
  assert.equal(
    getCanonicalPaymentOptions().filter((option) => option.label === "街口支付").length,
    1,
  );
  assert.match(dispatchSource, /extension_payment_method_[\s\S]*?getCanonicalPaymentOptions\(\{[\s\S]*?includeMonthly: true/);
  assert.match(dispatchSource, /payExtensionByMonthly[\s\S]*?customer_extension_monthly/);
  assert.match(indexSource, /const jkopayPayment = paymentMethod === "街口支付"/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /label: "刷卡"|value: "刷卡"|pcpay\.tw/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "assets", "payments", "jkopay-deepnight.png")));
});

test("自助下單拒絕價目表沒有的組合與非整數局數", () => {
  assert.throws(
    () => calculateSelfServicePrice({ game: "lol", platformOrMode: "召喚峽谷", serviceType: "娛樂", rankOrMap: "鑽石", playerCount: "1", quantity: "1" }),
    /沒有這個段位與類型/,
  );
  assert.throws(
    () => calculateSelfServicePrice({ game: "lol", platformOrMode: "聯盟戰棋", serviceType: "技術", rankOrMap: "翡翠", playerCount: "1", quantity: "1.5" }),
    /局數必須是整數/,
  );
});

test("自助派單同時標註性別與所選遊戲身分組", () => {
  assert.deepEqual(
    getSelfServiceDispatchRoleIds({
      gender_preference: "女陪",
      service: "英雄聯盟｜召喚峽谷｜娛樂",
      dispatch_service_key: "英雄聯盟娛樂陪玩",
    }),
    {
      genderRoleIds: ["1206158440280621056"],
      serviceRoleIds: ["1210652274771361812"],
    },
  );
  assert.deepEqual(
    getSelfServiceDispatchRoleIds({
      gender_preference: "不指定",
      service: "Apex｜排位｜大神",
      dispatch_service_key: "Apex大神陪玩",
    }).genderRoleIds,
    ["1206158440280621056", "1210852757972459540"],
  );
  const previousChatRoleId = process.env.CHAT_ROLE_ID;
  process.env.CHAT_ROLE_ID = "1210861802523467797";
  try {
    assert.deepEqual(
      getSelfServiceDispatchRoleIds({
        gender_preference: "女陪",
        service: "語音聊天｜Discord 語音｜日常聊天",
        dispatch_service_key: "語音聊天",
      }),
      {
        genderRoleIds: ["1206158440280621056"],
        serviceRoleIds: ["1210861802523467797"],
      },
    );
  } finally {
    if (previousChatRoleId === undefined) delete process.env.CHAT_ROLE_ID;
    else process.env.CHAT_ROLE_ID = previousChatRoleId;
  }
});

test("自助派單 15 分鐘倒數使用固定派單時間，不受後續扣 1 更新影響", () => {
  assert.equal(
    getSelfServiceDispatchAt({
      note: "[SELF_SERVICE] [DISPATCH_AT:2026-09-04T05:00:00.000Z]",
      updated_at: "2026-09-04T05:10:00.000Z",
    }),
    Date.parse("2026-09-04T05:00:00.000Z"),
  );
});

test("人工與自助派單每筆只能延長一次五分鐘，並保留原本接單資料", () => {
  const order = {
    note: "[SELF_SERVICE] [SELF_CLAIM:808875987034308618:可以接] [DISPATCH_AT:2026-09-04T05:00:00.000Z]",
    updated_at: "2026-09-04T05:10:00.000Z",
  };
  const extended = extendSelfServiceSelectionDeadline(order);
  assert.equal(extended.dispatchAtIso, "2026-09-04T05:05:00.000Z");
  assert.equal(extended.deadlineAt, Date.parse("2026-09-04T05:20:00.000Z"));
  assert.match(extended.note, /\[SELF_CLAIM:808875987034308618:可以接\]/);
  assert.match(extended.note, /\[DISPATCH_AT:2026-09-04T05:05:00\.000Z\]/);
  assert.match(extended.note, /\[DISPATCH_EXTENDED:1\]/);
  assert.equal(
    getSelfServiceSelectionDeadline({ note: extended.note }),
    Date.parse("2026-09-04T05:20:00.000Z"),
  );
  assert.throws(() => extendSelfServiceSelectionDeadline({ note: extended.note }), /最多只能延長一次/);
  assert.throws(
    () => extendSelfServiceSelectionDeadline({ note: `${extended.note} [MANUAL_DISPATCH]` }),
    /最多只能延長一次/,
  );
});

test("派單討論串依狀態使用派單中、接單成功、訂單棄單", () => {
  const order = { id: "order-1", order_no: "ORD-123", note: "[MANUAL_DISPATCH]" };
  assert.equal(getSelfServiceThreadName(order), "派單中-ORD-123-order-1");
  assert.equal(getDispatchResultThreadName(order, true), "接單成功-ORD-123");
  assert.equal(getDispatchResultThreadName(order, false), "訂單棄單-ORD-123");
});

test("自助派單湊足後依客人選擇的數字對應陪陪", () => {
  assert.deepEqual(
    resolveSelfServicePlayerNumbers(["陪陪甲", "陪陪乙", "陪陪丙"], ["2", "1"], 2),
    ["陪陪乙", "陪陪甲"],
  );
  assert.throws(
    () => resolveSelfServicePlayerNumbers(["陪陪甲", "陪陪乙"], ["1", "1"], 2),
    /數字無效或人數不符/,
  );
  assert.throws(
    () => resolveSelfServicePlayerNumbers(["陪陪甲", "陪陪乙"], ["3"], 1),
    /數字無效或人數不符/,
  );
});

test("自助派單湊足需求人數後仍持續開放兩種接單，直到客人選定", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /getClaimDispatchStatuses\(order\)\.includes\(order\.quote_status\)/);
  assert.match(source, /quote_status: success \? getClaimChoosingStatus\(order\) : getClaimDispatchingStatus\(order\)/);
  assert.match(source, /老闆選定前兩種接單仍會持續開放/);
  assert.match(source, /接單成功！/);
  assert.doesNotMatch(source, /playerIds\.length >= needCount\) return interaction\.editReply\(\{ content: "❌ 這張訂單人數已滿/);
  assert.doesNotMatch(source, /只有秋奈在職陪陪可以扣 1/);
  assert.doesNotMatch(source, /你的身分組不符合這筆訂單/);
  assert.match(source, /setLabel\("接單備註（選填）"\)/);
  assert.match(source, /setLabel\("1"\)/);
  assert.match(source, /setLabel\("PM"\)/);
  assert.match(source, /getSelfServiceClaimTypeLabel\(claimTypes\.get\(id\)\)/);
  assert.match(source, /getClaimTimeoutStatuses\(sourceOrder\)/);
  assert.doesNotMatch(source, /if \(firstReady\)/);
  assert.match(source, /選人期限內客人未完成陪陪選擇，已自動棄單/);
  assert.match(source, /self-service-timeout-refund:/);
  assert.match(source, /選人期限內未選擇陪陪，自動退款棄單/);
  assert.match(source, /頻道將於 10 秒後關閉/);
  assert.match(source, /派單開始後 15 分鐘內未完成陪陪選擇，系統將自動棄單/);
  assert.match(source, /15 分鐘內未選擇陪陪將自動棄單/);
  assert.match(source, /setLabel\("延長派單時間（\+5 分鐘，限一次）"\)/);
  assert.match(source, /setLabel\("按錯了，取消訂單"\)/);
  assert.match(source, /self_selection_extend_/);
  assert.match(source, /老闆已將選人時間延長 5 分鐘/);
  assert.match(source, /dispatchMessage\.startThread/);
  assert.match(source, /請在這個討論串內選擇「1」或「PM」並填寫接單備註/);
  assert.match(source, /setName\(getDispatchResultThreadName/);
  const selfServiceFlowSource = source.slice(
    source.indexOf("async function sendSelfServiceDispatch"),
    source.indexOf("async function sendTipOrderPanel"),
  );
  const selfServiceEmbedColors = [
    ...selfServiceFlowSource.matchAll(/\.setColor\(([^)]+)\)/g),
  ].map((match) => match[1]);
  assert.ok(selfServiceEmbedColors.length >= 9);
  assert.deepEqual([...new Set(selfServiceEmbedColors)], ["QIUNAI_WATER_BLUE"]);
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const modalButtonRoutes = indexSource.slice(
    indexSource.indexOf("// Modal 類按鈕不能 defer"),
    indexSource.indexOf("// ===== 使用者按錯建立訂單"),
  );
  assert.match(modalButtonRoutes, /customId\.startsWith\("self_service_claim_"\)/);
});

test("人工下單依遊戲分流，先報價與派單選人後才付款", () => {
  assert.equal(getManualDispatchChannelId({ game: "特戰英豪" }), "1223723419061850224");
  assert.equal(getManualDispatchChannelId({ game: "三角洲行動" }), "1336712064995037255");
  assert.equal(getManualDispatchChannelId({ game: "英雄聯盟" }), "1546494242246103090");
  assert.equal(getManualDispatchChannelId({ game: "Apex" }), "1546494309941903360");
  assert.equal(getManualDispatchChannelId({ game: "其他", order_item: "傳說對決" }), "1548732212491587634");
  assert.equal(getManualDispatchChannelId({ game: "其他", order_item: "語音聊天" }), "1548954895133053018");
  assert.equal(getManualDispatchChannelId({ game: "其他", order_item: "Minecraft" }), "1546519988901257246");
  assert.equal(getClaimDispatchChannelId({ game: "valorant", note: "[SELF_SERVICE]" }), process.env.SELF_SERVICE_DISPATCH_CHANNEL_ID || "1540653111670997092");
  assert.equal(getClaimDispatchChannelId({ game: "valorant", note: "[MANUAL_DISPATCH]" }), "1223723419061850224");
  assert.equal(getClaimDispatchChannelId({ game: "delta", note: "[MANUAL_DISPATCH]" }), "1336712064995037255");
  assert.equal(getClaimDispatchChannelId({ game: "lol", note: "[MANUAL_DISPATCH]" }), "1546494242246103090");
  assert.equal(getClaimDispatchChannelId({ game: "apex", note: "[MANUAL_DISPATCH]" }), "1546494309941903360");
  assert.equal(getClaimDispatchChannelId({ game: "voice_chat", note: "[MANUAL_DISPATCH]" }), "1548954895133053018");
  assert.equal(isManualDispatchOrder({ note: "需求 [MANUAL_DISPATCH]" }), true);

  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /setCustomId\(`manual_quote_dispatch_\$\{orderId\}`\)/);
  assert.match(source, /setLabel\("確認報價並正式派單"\)/);
  assert.match(source, /選定接單陪陪後，才會進入優惠券與付款流程/);
  assert.match(source, /已將接單方式由/);
  assert.match(source, /確認選擇 PM 陪陪/);
  assert.match(source, /files: \[\{ attachment: SELF_SERVICE_FAILED_IMAGE, name: "dispatch-failed\.png" \}\]/);
  assert.match(source, /getDispatchResultThreadName\(order, succeeded\)/);
  const confirmation = source.slice(
    source.indexOf("async function confirmSelfServicePlayers"),
    source.indexOf("async function paySelfServiceOrderByGateway"),
  );
  assert.match(confirmation, /quote_status: "price_confirmed"[\s\S]*?\.eq\("quote_status", "manual_confirming_players"\)/);
});

test("自助派單兩種接單的類型與備註可保存、讀取並清除", () => {
  const note = appendSelfServiceClaimNote(
    "[SELF_SERVICE] 原始訂單內容",
    "808875987034308618",
    "可立即開始 @everyone",
    "want",
  );
  assert.equal(
    getSelfServiceClaimNotes(note).get("808875987034308618"),
    "可立即開始 @everyone",
  );
  assert.equal(
    getSelfServiceClaimTypes(note).get("808875987034308618"),
    "want",
  );
  assert.equal(getSelfServiceClaimTypeLabel("want"), "PM");
  assert.equal(getSelfServiceClaimTypeLabel("can"), "1");
  assert.deepEqual(
    parseSelfServiceClaimAction("self_service_claim_can_order-1"),
    { claimType: "can", orderId: "order-1" },
  );
  assert.deepEqual(
    parseSelfServiceClaimAction("self_service_claim_submit_want_order-2", { submit: true }),
    { claimType: "want", orderId: "order-2" },
  );
  assert.equal(parseSelfServiceClaimAction("self_service_claim_legacy-order"), null);
  assert.equal(
    stripSelfServiceClaimNotes(note),
    "[SELF_SERVICE] 原始訂單內容",
  );
});

test("秋奈一般下單與各遊戲互動表單統一使用水藍色", () => {
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  const expectedTitles = [
    "📋 下單需求填寫",
    "🎯 特戰英豪需求",
    "🎮 Steam 下單需求",
    "🛡️ 三角洲下單需求",
    "💰 正式報價單",
    "💳 選擇付款方式",
    "📋 請確認訂單資訊",
    "➕ 加時付款",
  ];
  for (const title of expectedTitles) {
    assert.match(
      dispatchSource,
      new RegExp(`setColor\\(QIUNAI_WATER_BLUE\\)[\\s\\S]{0,120}setTitle\\(\"${title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\"\\)`),
    );
  }

  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(indexSource, /const QIUNAI_WATER_BLUE = "#7CC7FF"/);
  assert.match(indexSource, /setColor\(QIUNAI_WATER_BLUE\)\s*\.setTitle\("🌙 星雨訂單中心"\)/);
  assert.match(indexSource, /setColor\(QIUNAI_WATER_BLUE\)\s*\.setTitle\("🛒 訂單建立成功"\)/);
});

test("自助下單無價格組合會保留資料並轉客服報價", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /自助訂單無價格組合｜轉客服報價/);
  assert.match(source, /createWaitingQuoteOrder\(interaction, flowId, manualPending\)/);
  assert.match(source, /<@&\$\{process\.env\.STAFF_ROLE\}>/);
  assert.match(source, /isManualQuoteSelfServiceOrder\(order\)/);
  assert.match(source, /await sendSelfServiceDispatch\(dispatchOrder\)/);
  assert.match(source, /款項先前已完成核帳，不會重複扣款/);
  assert.match(source, /workReportSystem\.sendForAcceptedOrder\(acceptedOrder, selectedIds\)/);
  assert.match(source, /setPlaceholder\("選擇要打的段位"\)/);
  assert.match(source, /setPlaceholder\("選擇需求的陪陪段位"\)/);
  assert.match(source, /此組合只能輸入時數，請再輸入一次/);
  assert.match(source, /此組合只能輸入局數，請再輸入一次/);
  assert.match(source, /self_service_quantity_submit_/);
  assert.match(source, /self_service_valorant_target_/);
  assert.match(source, /self_service_valorant_companion_/);
  assert.match(source, /項目（請輸入完整名稱）/);
  assert.match(source, /self_service_delta_players_/);
  assert.match(source, /雙護項目會由系統自動固定為 2 位/);
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(indexSource, /customId\.startsWith\("self_service_valorant_target_"\)/);
  assert.match(indexSource, /customId\.startsWith\("self_service_valorant_companion_"\)/);
  assert.match(indexSource, /customId\.startsWith\("self_service_delta_players_"\)/);
});
const {
  buildTipAllocations,
  formatTipStaffMentions,
  getTipAllocationTotal,
  getTipGiftByKey,
  getTipStaffPage,
  getTipStaffIds,
  getTipTotalAmount,
  hasSelfTip,
  parseTipQuantityList,
} = require("../utils/tips");

test("tips cannot target the tipper", () => {
  assert.equal(hasSelfTip("100", ["200", "100"]), true);
  assert.equal(hasSelfTip("100", ["200", "300"]), false);
  assert.equal(hasSelfTip("", ["200"]), false);
});

test("tip staff choices are paged into Discord-safe groups of 25", () => {
  const options = Array.from({ length: 63 }, (_, index) => ({ value: String(index) }));
  const first = getTipStaffPage(options, 0);
  const last = getTipStaffPage(options, 99);
  assert.equal(first.page, 0);
  assert.equal(first.pageCount, 3);
  assert.equal(first.options.length, 25);
  assert.equal(last.page, 2);
  assert.equal(last.options.length, 13);
});

test("manual commission overrides and coupon salary uses the original price", () => {
  assert.equal(getManualCommissionRate("manager_95"), 95);
  assert.equal(getOrderCommissionBase({ price: 500, final_price: 400, discount_amount: 100 }), 500);
  assert.equal(getOrderCommissionBase({ final_price: 400 }), 400);
  assert.deepEqual(
    chooseHigherCommission(
      { rate: 95, level: "主管津貼 95%" },
      { rate: 90, level: "活動抽成 90%" },
    ),
    { rate: 95, level: "主管津貼 95%" },
  );
  assert.deepEqual(
    chooseHigherCommission(
      { rate: 85, level: "個人檔位 85%" },
      { rate: 90, level: "活動抽成 90%" },
    ),
    { rate: 90, level: "活動抽成 90%" },
  );
});

test("多人完成訂單會逐位補建秋奈薪資報單，不會被單一既有報單短路", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "index.js"),
    "utf8",
  );
  const blockStart = source.indexOf("// ===== 多位陪陪薪資平分 =====");
  const blockEnd = source.indexOf("await interaction.channel.send({", blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /for \(const playerId of assignedPlayers\)/);
  assert.match(block, /saveQiunaiSalaryOrder\(/);
  assert.doesNotMatch(block, /hasWorkReports/);
  assert.match(block, /if \(!salaryRow\)/);
});

test("秋奈員工 Discord 性別身分組變更會同步 EIP 官網資料", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(source, /async function syncQiunaiStaffGenderFromMember/);
  assert.match(source, /\.update\(\{ gender, updated_at:/);
  assert.match(
    source,
    /client\.on\(Events\.GuildMemberUpdate[\s\S]*handleSignedEmploymentMemberEvent\(newMember\)/,
  );
  assert.match(
    source,
    /syncQiunaiStaffGenderFromMember\(member\)[\s\S]*processSignedEmploymentReportChannels/,
  );
  assert.match(source, /QIUNAI_STAFF_FEMALE_ROLE_ID = "1513214106205950112"/);
  assert.match(source, /QIUNAI_STAFF_MALE_ROLE_ID = "1513214182093488148"/);
  assert.match(source, /async function syncAllQiunaiStaffGendersFromMembers/);
  assert.match(
    source,
    /genderUpdated = await syncAllQiunaiStaffGendersFromMembers\(members\)/,
  );
});

test("topup numbers use a validated ten-digit sequence", async () => {
  const topic = buildTopupTopic("123", "TOP-0000000001");
  assert.equal(topic, "owner:123;topup_no:TOP-0000000001");
  assert.equal(getTopupNumberFromTopic(topic), "TOP-0000000001");
  assert.equal(normalizeTopupNumber("top-10000000000"), "TOP-10000000000");
  assert.equal(normalizeTopupNumber("TOP-123"), null);
  assert.equal(
    await getNextTopupNumber({
      rpc: async (name) => ({
        data: name === "next_topup_number" ? "TOP-0000000002" : null,
        error: null,
      }),
    }),
    "TOP-0000000002",
  );
});

test("customer service points require the configured role and are idempotent per order", async () => {
  assert.equal(
    hasCustomerServicePointRole({ member: { roles: { cache: new Map([["1210642900355125288", {}]]) } } }),
    true,
  );
  assert.equal(
    hasCustomerServicePointRole({ member: { roles: { cache: new Map() } } }),
    false,
  );
  let upsertCall;
  const recorded = await recordCustomerServicePoint(
    { from: () => ({ upsert: async (row, options) => ((upsertCall = { row, options }), { error: null }) }) },
    { appKey: "qiunai", orderId: "ORD-0000000001", discordId: "staff-1", servedAt: "2026-08-22T00:00:00.000Z" },
  );
  assert.equal(recorded, true);
  assert.equal(upsertCall.row.points, 1);
  assert.deepEqual(upsertCall.options, { onConflict: "app_key,order_id", ignoreDuplicates: true });
});

test("客服接待件數只由手動指令計薪，且九月輪班客服為 85%", async () => {
  assert.equal(calculateCustomerServiceReceptionPay(3), 30);
  assert.throws(() => calculateCustomerServiceReceptionPay(0), /大於 0/);
  assert.equal(QIUNAI_CUSTOMER_SERVICE_IDS.length, 6);
  assert.equal(
    getSeptemberShiftCommissionRate(
      "808875987034308618",
      "2026-09-01T00:00:00+08:00",
    ),
    85,
  );
  assert.equal(
    getSeptemberShiftCommissionRate(
      "607493124746379274",
      "2026-09-04T00:00:00+08:00",
    ),
    null,
  );

  const calls = [];
  const supabase = {
    from(table) {
      if (table === "customer_service_order_points") {
        return {
          insert(row) {
            calls.push({ table, row });
            return {
              select: () => ({
                single: async () => ({ data: { id: 1 }, error: null }),
              }),
            };
          },
        };
      }
      return {
        insert: async (row) => {
          calls.push({ table, row });
          return { error: null };
        },
      };
    },
  };
  const result = await recordCustomerServiceReception(supabase, {
    appKey: "qiunai",
    interactionId: "interaction-1",
    discordId: "808875987034308618",
    staffName: "兜兜",
    count: 3,
    recordedBy: "admin-1",
    servedAt: "2026-09-04T00:00:00.000Z",
  });
  assert.deepEqual(result, {
    count: 3,
    amount: 30,
    orderId: "manual:interaction-1",
  });
  assert.equal(calls[0].row.points, 3);
  assert.equal(calls[0].row.order_id, "manual:interaction-1");
  assert.equal(calls[1].row.amount, 30);
});
const {
  buildTipBroadcastContent,
  splitTipBroadcastAllocations,
} = require("../utils/tipBroadcasts");
const {
  buildRedPacketShares,
  normalizeRedPacketMode,
} = require("../utils/redPackets");
const {
  buildReportAmounts,
  buildSavedWorkReportSupplement,
  canCorrectFirstSegmentStart,
  calculateCrownEndAt,
  isStaffInteraction,
  matchStaffLookup,
  normalizeStaffLookup,
  parseChannelId,
  parseTaipeiWorkTime,
  parseCrownDurationHours,
  parseDurationMinutes,
  parseMoney,
  shouldAutomaticallyFinalizeWorkReport,
  splitStaffLookupInput,
} = require("../events/workReportSystem");

test("存單補時會累加既有時段，足額後才進入完成流程", () => {
  const meta = {
    expectedDurationMinutes: 120,
    segments: [{ startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T11:00:00.000Z", minutes: 60 }],
  };
  const short = buildSavedWorkReportSupplement(meta, new Date("2026-09-21T10:00:00.000Z"), new Date("2026-09-21T10:30:00.000Z"), Date.parse("2026-09-21T11:00:00.000Z"));
  assert.equal(short.totalMinutes, 90);
  assert.equal(short.shortageMinutes, 30);
  assert.equal(short.isComplete, false);
  const complete = buildSavedWorkReportSupplement(short.meta, new Date("2026-09-22T10:00:00.000Z"), new Date("2026-09-22T10:30:00.000Z"), Date.parse("2026-09-22T11:00:00.000Z"));
  assert.equal(complete.totalMinutes, 120);
  assert.equal(complete.isComplete, true);
  assert.equal(complete.meta.segments.length, 3);
  assert.throws(() => buildSavedWorkReportSupplement(meta, new Date("2026-09-20T10:30:00.000Z"), new Date("2026-09-20T11:30:00.000Z"), Date.parse("2026-09-21T11:00:00.000Z")), /重疊/);
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /customId\.startsWith\("work_report_supplement_"\)/);
  const reportSource = fs.readFileSync(path.join(__dirname, "..", "events", "workReportSystem.js"), "utf8");
  assert.match(reportSource, /customId\.startsWith\("submit_work_report_supplement_"\)/);
});

test("work reports accept raw channel IDs and Discord channel URLs", () => {
  assert.equal(parseChannelId("1538937975629418587"), "1538937975629418587");
  assert.equal(
    parseChannelId(
      "https://discord.com/channels/1513174069087047731/1538937975629418587",
    ),
    "1538937975629418587",
  );
});

test("all completed work reports require EIP approval", () => {
  assert.equal(
    shouldAutomaticallyFinalizeWorkReport(
      "qiunai",
      { sourceKind: "bot_order" },
      true,
    ),
    false,
  );
  assert.equal(
    shouldAutomaticallyFinalizeWorkReport(
      "qiunai",
      { sourceKind: "manual" },
      true,
    ),
    false,
  );
  assert.equal(
    shouldAutomaticallyFinalizeWorkReport(
      "deepnight",
      { sourceKind: "bot_order" },
      true,
    ),
    false,
  );
});

test("customer order flows no longer route through companion designation", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /customId\.startsWith\("(?:service_assign_|service_selected_players_|new_order_player_)"\)/,
  );
});

test("冠名品項可解析時長並計算到期時間", () => {
  assert.equal(
    parseCrownDurationHours(
      "冠名單｜半日冠｜贈送還單 6hrs｜冠名時長 12hrs",
    ),
    12,
  );
  assert.equal(
    parseCrownDurationHours("冠名單｜月冠名｜冠名時長 720hrs"),
    720,
  );
  assert.equal(parseCrownDurationHours("普通打賞"), null);
  assert.equal(
    calculateCrownEndAt("2026-07-28T12:00:00.000Z", 12).toISOString(),
    "2026-07-29T00:00:00.000Z",
  );
});

test("秋奈固定打賞商品都有播報圖片與專屬文案", () => {
  const fixedGifts = gifts.filter((gift) => !gift.customPrice);
  assert.equal(fixedGifts.length, 19);
  assert.equal(Object.keys(tipBroadcasts).length, fixedGifts.length);

  for (const gift of fixedGifts) {
    const broadcast = tipBroadcasts[gift.key];
    assert.ok(broadcast, `${gift.name} 缺少播報設定`);
    assert.ok(broadcast.description, `${gift.name} 缺少播報文案`);
    assert.ok(
      fs.existsSync(
        path.join(
          __dirname,
          "..",
          "assets",
          "tip-gifts",
          broadcast.imageFile,
        ),
      ),
      `${gift.name} 缺少播報圖片`,
    );
  }
});

test("街口水果糖付款完成後保留商品 key，公開播報會附上專屬圖片", () => {
  const allocations = buildTipAllocations({
    allocations: [
      {
        staffId: "259579586453569536",
        item: "水果糖×1",
        amount: 230,
        lines: [
          {
            key: "tip_230_fruit_candy",
            name: "水果糖",
            price: 230,
            quantity: 1,
            subtotal: 230,
          },
        ],
      },
    ],
  });
  assert.equal(allocations[0].lines[0].key, "tip_230_fruit_candy");
  assert.equal(
    tipBroadcasts[allocations[0].lines[0].key].imageFile,
    "tip_230_fruit_candy.png",
  );
  const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(source, /lines: Array\.isArray\(item\.lines\)/);
});

test("打賞播報可依老闆選擇顯示帳號或匿名", () => {
  const common = {
    description: "商品介紹",
    giftName: "草莓聖代",
    staffIds: ["259579586453569536", "797833875653001238"],
    tipperId: "430903870135336962",
  };
  const publicContent = buildTipBroadcastContent({
    ...common,
    anonymous: false,
  });
  assert.match(publicContent, /<@430903870135336962>/);
  assert.match(publicContent, /<@259579586453569536>/);
  assert.match(publicContent, /<@797833875653001238>/);

  const anonymousContent = buildTipBroadcastContent({
    ...common,
    anonymous: true,
  });
  assert.match(anonymousContent, /匿名闆闆/);
  assert.doesNotMatch(anonymousContent, /<@430903870135336962>/);
});

test("多人打賞播報拆成每位陪陪各自一筆", () => {
  const jobs = splitTipBroadcastAllocations([
    { staffId: "staff-a", lines: [{ name: "煙火", quantity: 2 }] },
    { staffId: "staff-b", lines: [{ name: "煙火", quantity: 1 }] },
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.staffId, job.line.quantity]),
    [["staff-a", 2], ["staff-b", 1]],
  );
});

test("舊版儲值卡打賞付款完成後也會執行公開播報", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const start = source.indexOf('if (customId.startsWith("confirm_tip_submit_"))');
  const end = source.indexOf("// ===== 客人取消送出打賞 =====", start);
  assert.ok(start >= 0 && end > start, "找不到舊版打賞確認流程");
  assert.match(
    source.slice(start, end),
    /sendTipBroadcastSafely\(tipData\)/,
  );
});

test("多人打賞報單會逐位處理並在最後彙整失敗", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  const start = source.indexOf("async function sendForCompletedTipOrders");
  const end = source.indexOf("async function createAdditionalReport", start);
  assert.ok(start >= 0 && end > start, "找不到打賞報單發送流程");
  const block = source.slice(start, end);
  assert.match(block, /const failures = \[\]/);
  assert.match(block, /catch \(error\)/);
  assert.match(block, /if \(failures\.length\)/);
});

test("缺少填單區時會自動補建、寫回 EIP 並再送出報單", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  assert.match(source, /async function ensureStaffReportChannel/);
  assert.match(source, /自動補建 .* 的填單區/);
  assert.match(source, /channel = await ensureStaffReportChannel\(staff\)/);
  assert.doesNotMatch(source, /尚未填寫個人填單區／薪資頻道 ID/);
});
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");
const {
  isCouponInventoryItem,
  parseVipCouponReward,
  qualifiesForVipLevel,
} = require("../utils/vipRewards");
const { resolveMembershipCardImage } = require("../utils/allianceMembership");
const {
  parseChatDropReward,
  shouldCreateChatDrop,
} = require("../utils/randomEvents");
const {
  formatInventoryItemTitle,
  groupInventoryItems,
} = require("../utils/inventory");
const {
  createHealthState,
  createNonOverlappingTask,
  createTtlSet,
  scheduleMapExpiry,
  validateEnvironment,
} = require("../utils/runtime");
const { getTaipeiScheduleParts } = require("../utils/dailySelfCheck");

test("背包相同品項會合併數量，不同內容或效期維持分開", () => {
  const grouped = groupInventoryItems([
    { id: 1, item_name: "改名卡", item_type: "shop", description: "使用一次" },
    { id: 2, item_name: "改名卡", item_type: "shop", description: "使用一次" },
    { id: 3, item_name: "改名卡", item_type: "shop", description: "限定用途" },
    { id: 4, item_name: "九折券", item_type: "coupon", expires_at: "2026-09-30" },
    { id: 5, item_name: "九折券", item_type: "coupon", expires_at: "2026-10-31" },
  ]);
  assert.equal(grouped.length, 4);
  const renameCard = grouped.find((item) => item.description === "使用一次");
  assert.equal(renameCard.count, 2);
  assert.equal(formatInventoryItemTitle(renameCard), "• 改名卡 ×2");
  assert.equal(formatInventoryItemTitle({ item_name: "單張券", count: 1 }), "• 單張券");

  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /const items = groupInventoryItems\(rawItems\.filter/);
  assert.match(source, /const groupedItems = groupInventoryItems\(items\)/);
});

test("每日自動偵錯使用台北時間排程", () => {
  assert.deepEqual(getTaipeiScheduleParts(new Date("2026-08-06T20:10:00Z")), {
    date: "2026-08-07",
    hour: 4,
    minute: 10,
  });
});
const {
  commandDefinitionsMatch,
  syncApplicationCommands,
} = require("../runtime/commandRegistry");
const { runStartupGroup } = require("../runtime/startupOrchestrator");
const {
  GAMES,
  buildApprovedEmploymentDmContent,
  buildEmploymentPdfBuffer,
  buildEmploymentResultNotice,
  buildExistingCompanionResultDm,
  createEmploymentSystem,
  getCompletedThreadDeleteDelay,
  getApplicationFields,
  getConfiguredRoleNames,
  hasActiveCompanionAtStore,
  hasPaidOrderAtStore,
  normalizeRoleName,
} = require("../events/employmentSystem");
const { formatComplaintSender } = require("../events/complaintSystem");
const {
  calculateSalaryDeductionState,
} = require("../utils/salaryDeduction");
const {
  getNewOrderGameOptions,
  getOrderItemOptions,
  shouldPreserveDispatchedOrder,
  deferReplyOnce,
} = require("../events/dispatchSystem");

test("anonymous complaints never include the sender identity", () => {
  const user = { id: "123456789012345678", tag: "secret-user" };
  const anonymousText = formatComplaintSender(true, user);
  assert.equal(anonymousText, "匿名（未紀錄發送者）");
  assert.equal(anonymousText.includes(user.id), false);
  assert.equal(anonymousText.includes(user.tag), false);
  assert.match(formatComplaintSender(false, user), /123456789012345678/);
});

test("salary deduction uses net commissioned salary and caps advances at 1000", () => {
  const enough = calculateSalaryDeductionState({
    walletEntries: [{ amount: 500 }],
    withdrawRequests: [{ amount: 100, status: "approved" }],
    pendingOrders: [{ staff_salary: 700, bonus_amount: 50 }],
    pendingAdjustments: [{ amount: -50 }],
    amount: 1000,
  });
  assert.equal(enough.availableBefore, 1100);
  assert.equal(enough.shortage, 0);
  assert.equal(enough.canUse, true);

  const advance = calculateSalaryDeductionState({
    pendingOrders: [{ staff_salary: 300 }],
    amount: 900,
  });
  assert.equal(advance.shortage, 600);
  assert.equal(advance.projectedAdvance, 600);
  assert.equal(advance.canUse, true);

  const overLimit = calculateSalaryDeductionState({
    pendingAdjustments: [{ amount: -300 }],
    amount: 800,
  });
  assert.equal(overLimit.projectedAdvance, 1100);
  assert.equal(overLimit.canUse, false);
});

test("秋奈員工扣薪只對在職員工顯示且後端仍驗證身分", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );

  assert.match(source, /\.eq\("app_key", "qiunai"\)/);
  assert.match(source, /\.from\("qiunai_staff_bonus"\)/);
  assert.match(source, /salary_quote_confirm_/);
  assert.match(source, /salary_service_confirm_/);
  assert.match(source, /salary_extension_confirm_/);
  assert.match(source, /使用薪水續單/);
  assert.match(source, /setLabel\(state\.shortage \? "確認預支"/);
  assert.match(source, /setLabel\("轉帳補齊差額"\)/);
  assert.match(source, /salary_quote_split_confirm_/);
  assert.match(source, /salary_service_split_confirm_/);
  assert.match(source, /async function isActiveSalaryDeductionStaff/);
  assert.match(source, /\.eq\("is_active", true\)/);
  assert.equal((source.match(/includeSalary: salaryDeductionEnabled/g) || []).length, 1);
  assert.equal((source.match(/salaryEligible: salaryDeductionEnabled/g) || []).length, 2);
  assert.match(source, /if \(!staff\) throw new Error\("扣薪付款僅限秋奈在職員工使用"\)/);
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.ok(
    getCanonicalPaymentOptions({ includeSalary: true }).some(
      (option) => option.label === "員工扣薪" && option.value === "員工扣薪",
    ),
  );
  assert.match(indexSource, /buildTipPaymentMenu\(tipId, staff\?\.is_active === true\)/);
  assert.match(indexSource, /includeSalary: salaryDeductionEnabled/);
  assert.match(indexSource, /confirm_tip_salary_/);
  assert.match(indexSource, /使用薪水打賞/);
  assert.match(indexSource, /countReason: "員工扣薪打賞／冠名付款完成"/);
});

test("new order command categories include Apex and other service items", () => {
  const gameValues = getNewOrderGameOptions().map((option) => option.value);
  assert.deepEqual(
    ["特戰英豪", "三角洲行動", "Apex", "英雄聯盟", "STEAM", "其他"].every(
      (game) => gameValues.includes(game),
    ),
    true,
  );
  assert.deepEqual(
    getOrderItemOptions("Apex").map((option) => option.value),
    ["大神陪玩", "技術陪玩", "娛樂陪玩"],
  );
  assert.ok(
    getOrderItemOptions("其他").some((option) => option.value === "自訂需求"),
  );
  assert.ok(
    getOrderItemOptions("其他").some((option) => option.value === "傳說對決"),
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "assets", "panels", "aov-pricing.png")),
    true,
  );
});

test("edited dispatched orders keep their progress when the customer reconfirms", () => {
  assert.equal(
    shouldPreserveDispatchedOrder({
      assigned_player: "123456789012345678",
      status: "accepted",
    }),
    true,
  );
  assert.equal(
    shouldPreserveDispatchedOrder({
      assigned_player: "123456789012345678",
      status: "completed",
    }),
    true,
  );
  assert.equal(
    shouldPreserveDispatchedOrder({ assigned_player: null, status: "quoted" }),
    false,
  );
});

test("paid wallet order price edits charge or refund only the difference", () => {
  assert.deepEqual(getPaidOrderPriceAdjustment(500, 650), {
    oldAmount: 500,
    newAmount: 650,
    difference: 150,
  });
  assert.equal(getPaidOrderPriceAdjustment(500, 350).difference, -150);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /confirm_order_price_adjustment_/);
  assert.match(source, /confirm_order_paid_gap_/);
  assert.match(source, /只會調整上述差額，不會重複扣除原訂單金額/);
  assert.match(source, /changeCoins\(order\.customer_id, -difference\)/);
  assert.match(source, /hasMatchingManualPriceGapDeduction\(order, difference\)/);
  assert.match(source, /這張延遲補扣通知已作廢，不會再次扣款/);
});

test("salary deduction buttons never defer an interaction twice", async () => {
  let deferCalls = 0;
  await deferReplyOnce({
    deferred: true,
    replied: false,
    deferReply: async () => {
      deferCalls += 1;
    },
  });
  assert.equal(deferCalls, 0);

  await deferReplyOnce({
    deferred: false,
    replied: false,
    deferReply: async (payload) => {
      assert.deepEqual(payload, { flags: 64 });
      deferCalls += 1;
    },
  });
  assert.equal(deferCalls, 1);
});
const {
  claimDailyCheckinReward,
} = require("../utils/dailyCheckin");

test("concurrent daily check-ins award exactly once", async () => {
  const state = {
    user_id: "123456789012345678",
    coins: 0,
    last_checkin: null,
  };
  const readUser = async () => ({ ...state });
  const compareAndSwap = async ({
    expectedCoins,
    expectedCheckin,
    nextCoins,
    nextCheckin,
  }) => {
    if (
      state.coins !== expectedCoins ||
      state.last_checkin !== expectedCheckin
    ) {
      return null;
    }

    state.coins = nextCoins;
    state.last_checkin = nextCheckin;
    return { coins: state.coins, last_checkin: state.last_checkin };
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      claimDailyCheckinReward({
        readUser,
        compareAndSwap,
        userId: state.user_id,
        date: "2026-07-26",
        reward: 10,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => !result.claimed).length, 19);
  assert.equal(state.coins, 10);
  assert.equal(state.last_checkin, "2026-07-26");
});

test("service settings support arrays, JSON, and comma-separated values", () => {
  assert.deepEqual(parseAllowedServices(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseAllowedServices('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseAllowedServices("a, b,, "), ["a", "b"]);
  assert.deepEqual(parseAllowedServices(null), []);
});

test("custom tips require customer service pricing", () => {
  assert.deepEqual(
    gifts.find((gift) => gift.key === "tip_custom"),
    {
      key: "tip_custom",
      name: "客製打賞",
      price: 0,
      description: "價格由客服填寫",
      customPrice: true,
    },
  );
});

test("crown packages keep gifted hours separate from crown duration", () => {
  assert.deepEqual(
    crownPackages.map(({ name, price, giftedHours, durationHours }) => [
      name,
      price,
      giftedHours,
      durationHours,
    ]),
    [
      ["半日冠", 1899, 6, 12],
      ["一日冠", 3999, 12, 24],
      ["三日冠", 12888, 36, 72],
      ["周冠名", 26666, 84, 168],
      ["月冠名", 188888, 336, 720],
      ["自定冠", null, null, null],
    ],
  );
  assert.equal(getCrownPackageByKey(crownPackages, "crown_week").name, "周冠名");
  assert.equal(
    buildCrownOrderItem({
      crownName: "半日冠",
      giftedHours: 6,
      durationHours: 12,
      changeSuffixes: true,
      staffSuffix: "♡闆闆",
    }),
    "冠名單｜半日冠｜贈送還單 6hrs｜冠名時長 12hrs｜陪陪尾綴：「♡闆闆」",
  );
});

test("only four and five star reviews are published with privacy respected", () => {
  assert.equal(shouldPublishReview(5), true);
  assert.equal(shouldPublishReview(4), true);
  assert.equal(shouldPublishReview(3), false);
  assert.equal(shouldPublishReview(0), false);
  assert.equal(formatReviewCustomer("123456789", false), "<@123456789>");
  assert.equal(formatReviewCustomer("123456789", true), "匿名");
});

test("VIP upgrades accept cumulative spend or a single topup, never cumulative topup", () => {
  const level = {
    totalSpendRequired: 5000,
    singleTopupRequired: 3000,
  };

  assert.equal(qualifiesForVipLevel({ ...level, totalSpent: 5000 }), true);
  assert.equal(
    qualifiesForVipLevel({ ...level, highestSingleTopup: 3000 }),
    true,
  );
  assert.equal(
    qualifiesForVipLevel({ ...level, totalTopup: 999999 }),
    false,
  );
});

test("admin money grants never count as spend, topup, or VIP progress", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const grantStart = source.indexOf(
    'if (interaction.commandName === "發錢")',
  );
  const grantEnd = source.indexOf("// 扣錢", grantStart);
  const grantFlow = source.slice(grantStart, grantEnd);

  assert.ok(grantStart >= 0 && grantEnd > grantStart);
  assert.match(grantFlow, /"管理員發錢"/);
  assert.doesNotMatch(grantFlow, /allianceMembership\.applyActivity/);
  assert.doesNotMatch(grantFlow, /checkAndUpgradeVip/);
});

test("admin money deductions never count as spend, topup, or VIP progress", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const deductionStart = source.indexOf(
    'if (interaction.commandName === "扣錢")',
  );
  const deductionEnd = source.indexOf(
    'if (interaction.commandName === "給與身份組")',
    deductionStart,
  );
  const deductionFlow = source.slice(deductionStart, deductionEnd);

  assert.ok(deductionStart >= 0 && deductionEnd > deductionStart);
  assert.match(deductionFlow, /"管理員扣錢"/);
  assert.match(deductionFlow, /不列入累積消費或儲值/);
  assert.doesNotMatch(deductionFlow, /allianceMembership\.applyActivity/);
  assert.doesNotMatch(deductionFlow, /checkAndUpgradeVip/);
});

test("tip helpers preserve multi-staff behavior", () => {
  assert.deepEqual(getTipStaffIds({ selectedStaffIds: ["1", "2", "1", ""] }), [
    "1",
    "2",
  ]);
  assert.deepEqual(getTipStaffIds({ selectedStaffId: "1" }), ["1"]);
  assert.equal(formatTipStaffMentions(["1", "2"]), "<@1>、<@2>");
  assert.equal(getTipTotalAmount(50, ["1", "2"]), 100);
  assert.equal(getTipTotalAmount(50, []), 50);
  assert.equal(getTipGiftByKey(gifts, gifts[0].key), gifts[0]);
});

test("tip helpers calculate multi-gift and separate staff quantities", () => {
  assert.deepEqual(parseTipQuantityList("2, 3", 2), [2, 3]);
  assert.throws(() => parseTipQuantityList("2", 2), /2 個/);

  const tipData = {
    selectedStaffIds: ["1", "2"],
    gifts: [
      { key: "a", name: "禮物 A", price: 10 },
      { key: "b", name: "禮物 B", price: 20 },
    ],
    sharedQuantities: [1, 1],
    quantitiesByStaff: {
      1: [2, 1],
      2: [1, 3],
    },
  };
  assert.deepEqual(
    buildTipAllocations(tipData).map(({ staffId, item, amount }) => ({
      staffId,
      item,
      amount,
    })),
    [
      { staffId: "1", item: "禮物 A×2、禮物 B×1", amount: 40 },
      { staffId: "2", item: "禮物 A×1、禮物 B×3", amount: 70 },
    ],
  );
  assert.equal(getTipAllocationTotal(tipData), 110);
});

test("red packet shares preserve totals and stay near the average", () => {
  for (const mode of ["average", "random"]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const shares = buildRedPacketShares(1000, 10, mode);
      assert.equal(shares.length, 10);
      assert.equal(
        shares.reduce((sum, amount) => sum + amount, 0),
        1000,
      );
      assert.ok(shares.every((amount) => amount >= 80 && amount <= 120));
    }
  }
  assert.equal(normalizeRedPacketMode("average"), "average");
  assert.equal(normalizeRedPacketMode("anything-else"), "random");
});

test("work report permissions accept cached and raw Discord roles", () => {
  const roleId = "1210642900355125288";
  const base = {
    guild: { ownerId: "owner" },
    user: { id: "user" },
    memberPermissions: { has: () => false },
  };
  assert.equal(
    isStaffInteraction(
      { ...base, member: { roles: { cache: { has: (id) => id === roleId } } } },
      roleId,
    ),
    true,
  );
  assert.equal(
    isStaffInteraction({ ...base, member: { roles: [roleId] } }, roleId),
    true,
  );
  assert.equal(
    isStaffInteraction(
      { ...base, member: { roles: ["1513203868895412305"] } },
      `${roleId},1513203868895412305`,
    ),
    true,
  );
  assert.equal(
    isStaffInteraction({ ...base, member: { roles: [] } }, roleId),
    false,
  );
});

test("客服報價接受 Discord 精簡成員資料，不會拋出通用系統錯誤", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  const openQuoteSource = source.slice(
    source.indexOf("async function openServiceQuotePriceModal"),
    source.indexOf("async function submitServiceQuotePrice"),
  );
  const submitQuoteSource = source.slice(
    source.indexOf("async function submitServiceQuotePrice"),
    source.indexOf("async function sendServiceCouponPrompt"),
  );
  assert.match(openQuoteSource, /if \(!isStaffInteraction\(interaction\)\)/);
  assert.match(submitQuoteSource, /if \(!isStaffInteraction\(interaction\)\)/);
  assert.doesNotMatch(openQuoteSource, /interaction\.member\.roles\.cache/);
  assert.doesNotMatch(submitQuoteSource, /interaction\.member\.roles\.cache/);
});

test("order flows remain active for 24 hours", () => {
  assert.equal(ORDER_FLOW_TTL_MS, 24 * 60 * 60 * 1000);
});

test("manual gifts keep the full amount for every selected staff member", () => {
  assert.deepEqual(buildReportAmounts(1000, 3, false), [334, 333, 333]);
  assert.deepEqual(buildReportAmounts(1000, 3, true), [1000, 1000, 1000]);
});

test("manual work reports find staff consistently across Discord clients", () => {
  const records = [
    {
      staff: {
        id: 42,
        discord_id: "123456789012345678",
        display_name: "小 雨",
        discord_name: "rain.staff",
      },
      member: {
        nickname: "深夜小雨",
        displayName: "深夜小雨",
        user: { username: "rain930", globalName: "Rain" },
      },
    },
  ];
  for (const input of [
    "深夜小雨",
    "rain930",
    "RAIN.STAFF",
    "42",
    "123456789012345678",
    "<@123456789012345678>",
  ]) {
    assert.equal(matchStaffLookup(records, input).length, 1, input);
  }
  assert.equal(normalizeStaffLookup("＠Test User"), "test user");
  assert.deepEqual(splitStaffLookupInput("小雨，42\n<@123456789012345678>"), [
    "小雨",
    "42",
    "<@123456789012345678>",
  ]);
});

test("work report edits parse duration and formatted money", () => {
  assert.equal(parseDurationMinutes("2小時30分鐘"), 150);
  assert.equal(parseDurationMinutes("1.5"), 90);
  assert.equal(parseDurationMinutes("90分鐘"), 90);
  assert.equal(parseMoney("NT$ 12,500"), 12500);
  assert.equal(parseMoney("0"), null);
});

test("time-only work reports use the latest Taipei occurrence", () => {
  const justAfterMidnight = new Date("2026-07-14T16:30:00.000Z");
  assert.equal(
    parseTaipeiWorkTime("22:38", justAfterMidnight).toISOString(),
    "2026-07-14T14:38:00.000Z",
  );
  assert.equal(
    parseTaipeiWorkTime("00:20", justAfterMidnight).toISOString(),
    "2026-07-14T16:20:00.000Z",
  );
});

test("first work-report start time can be corrected exactly once", () => {
  const pending = {
    segments: [],
    pendingSegmentStart: "2026-07-27T12:00:00.000Z",
  };
  assert.equal(canCorrectFirstSegmentStart(pending), true);
  assert.equal(
    canCorrectFirstSegmentStart({ ...pending, startTimeEditCount: 1 }),
    false,
  );
  assert.equal(
    canCorrectFirstSegmentStart({
      ...pending,
      segments: [{ startedAt: pending.pendingSegmentStart, minutes: 60 }],
    }),
    false,
  );
  assert.equal(canCorrectFirstSegmentStart({ segments: [] }), false);
});

test("work-report correction button opens its modal before any defer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const buttonRouter = source.slice(
    source.indexOf("// ===== 一般 Button ====="),
    source.indexOf("// ===== 派單 / 陪玩狀態按鈕"),
  );
  assert.match(
    buttonRouter,
    /interaction\.customId\.startsWith\("work_report_correct_start_"\)/,
  );
});

test("所有會開啟工時表單的按鈕都在主路由 defer 前處理", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const modalRouter = source.slice(
    source.indexOf("// Modal 類按鈕不能 defer"),
    source.indexOf("// ===== 使用者按錯建立訂單", source.indexOf("// Modal 類按鈕不能 defer")),
  );
  for (const prefix of [
    "open_manual_work_report",
    "work_report_crown_start_",
    "work_report_add_",
    "work_report_edit_",
    "work_report_correct_start_",
    "work_report_start_",
    "work_report_end_",
  ]) {
    assert.match(modalRouter, new RegExp(prefix));
  }
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.equal(
    (dispatchSource.match(/async function handleServiceDurationSelect\(/g) || []).length,
    1,
  );
});

test("VIP rewards normalize suffix coupons and never auto-grant gift cards", () => {
  assert.deepEqual(
    parseVipCouponReward(
      "7折券*2,陪玩前綴一週券*2,陪玩冠名7日券*2,500元禮品卡*1",
    ),
    [
      { name: "7折券", count: 2 },
      { name: "陪玩後綴一週券", count: 2 },
      { name: "陪玩後綴7日券", count: 2 },
    ],
  );
  assert.deepEqual(parseVipCouponReward("陪玩心動值禮物加成雙倍*1"), [
    { name: "心動值禮物雙倍券", count: 1 },
  ]);
  assert.equal(isCouponInventoryItem({ item_name: "心動值禮物雙倍券" }), true);
});

test("exclusive membership cards follow the member's one-time variant", () => {
  const tier = { tier_key: "exclusive", card_image_url: "fallback" };
  assert.match(
    resolveMembershipCardImage(
      { discord_user_id: "123456789012345678", exclusive_card_variant: "white" },
      tier,
    ),
    /\/api\/membership\/card\/123456789012345678$/,
  );
  assert.match(
    resolveMembershipCardImage(
      { discord_user_id: "123456789012345678", exclusive_card_variant: "black" },
      tier,
    ),
    /\/api\/membership\/card\/123456789012345678$/,
  );
  assert.equal(resolveMembershipCardImage({}, tier), null);
});

test("chat drops use an exact 0.5% threshold and validate rewards", () => {
  assert.equal(shouldCreateChatDrop(0), true);
  assert.equal(shouldCreateChatDrop(0.004999), true);
  assert.equal(shouldCreateChatDrop(0.005), false);
  assert.equal(shouldCreateChatDrop(1), false);
  assert.equal(parseChatDropReward("claim_1"), 1);
  assert.equal(parseChatDropReward("claim_20"), 20);
  assert.equal(parseChatDropReward("claim_0"), null);
  assert.equal(parseChatDropReward("claim_999"), null);
  assert.equal(parseChatDropReward("claim_red_packet_1"), null);
});

test("runtime validation reports missing variable names without values", () => {
  assert.doesNotThrow(() => validateEnvironment({ TOKEN: "set" }, ["TOKEN"]));
  assert.throws(
    () => validateEnvironment({ TOKEN: "" }, ["TOKEN", "GUILD_ID"]),
    /TOKEN, GUILD_ID/,
  );
});

test("runtime health records degraded startup without exposing messages", () => {
  const health = createHealthState("test-bot");
  health.addFailure("optional panel", new Error("private detail"));
  health.markReady();
  assert.deepEqual(health.snapshot().startupFailures[0].name, "optional panel");
  assert.equal(health.snapshot().status, "degraded");
  assert.equal(JSON.stringify(health.snapshot()).includes("private detail"), false);
});

test("runtime guards duplicate events and overlapping scheduler runs", async () => {
  const dedupe = createTtlSet(1000);
  assert.equal(dedupe.add("interaction-1"), true);
  assert.equal(dedupe.add("interaction-1"), false);
  assert.equal(dedupe.delete("interaction-1"), true);
  assert.equal(dedupe.add("interaction-1"), true);

  let release;
  let runs = 0;
  const firstRun = new Promise((resolve) => {
    release = resolve;
  });
  const task = createNonOverlappingTask("test", async () => {
    runs += 1;
    await firstRun;
  });
  const pending = task();
  await task();
  assert.equal(runs, 1);
  release();
  await pending;
});

test("runtime map expiry only removes the value it scheduled", async () => {
  const map = new Map();
  const first = { value: 1 };
  const replacement = { value: 2 };
  map.set("flow", first);
  scheduleMapExpiry(map, "flow", first, 5);
  map.set("flow", replacement);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(map.get("flow"), replacement);
});

test("command registry skips unchanged Discord definitions and syncs changes", async () => {
  const local = [{ name: "ping", description: "測試", options: [] }];
  const remote = [
    {
      id: "server-id",
      application_id: "app-id",
      version: "1",
      type: 1,
      name: "ping",
      description: "測試",
      options: [],
    },
  ];
  assert.equal(commandDefinitionsMatch(remote, local), true);
  assert.equal(
    commandDefinitionsMatch(
      [{ ...remote[0], description: "已變更" }],
      local,
    ),
    false,
  );

  const calls = [];
  const rest = {
    async get() {
      calls.push("get");
      return remote;
    },
    async put() {
      calls.push("put");
    },
  };
  const logger = { log() {}, warn() {} };
  const unchanged = await syncApplicationCommands({
    token: "test",
    applicationId: "app",
    commands: local,
    rest,
    logger,
  });
  assert.deepEqual(unchanged, { changed: false, count: 1 });
  assert.deepEqual(calls, ["get"]);
});

test("startup orchestrator limits concurrency and preserves every task result", async () => {
  let active = 0;
  let maxActive = 0;
  const completed = [];
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    name: `task-${index}`,
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(index);
      active -= 1;
    },
  }));

  const summary = await runStartupGroup(tasks, {
    concurrency: 2,
    runner: async (name, run) => {
      await run();
      return name !== "task-5";
    },
  });

  assert.equal(maxActive, 2);
  assert.equal(completed.length, 6);
  assert.equal(summary.total, 6);
  assert.equal(summary.succeeded, 5);
  assert.equal(summary.failed, 1);
});

test("employment applications expose ten games and complete field schemas", () => {
  assert.equal(GAMES.length, 10);
  assert.equal(getApplicationFields("valorant").length, 14);
  assert.equal(getApplicationFields("delta").length, 14);
  assert.equal(getApplicationFields("naraka").length, 7);
  assert.equal(getApplicationFields("cs2").length, 13);
  assert.equal(getApplicationFields("honor_of_kings").length, 9);
  assert.equal(getApplicationFields("other").length, 9);
  assert.equal(normalizeRoleName("｜｜・遊戲審核官"), "遊戲審核官");
});

test("employment applications mention only the examiner role matching game, track, platform, or item", () => {
  const config = require("../config/employment");
  assert.deepEqual(
    getConfiguredRoleNames(config, "valorant", "technical"),
    ["〢・Valorant技術審核官"],
  );
  assert.deepEqual(
    getConfiguredRoleNames(config, "delta", "entertainment", "mobile"),
    ["〢・三角洲M審核官"],
  );
  assert.deepEqual(
    getConfiguredRoleNames(config, "other", "other", null, "傳說對決陪玩"),
    ["〢・傳說審核官"],
  );
  assert.deepEqual(
    getConfiguredRoleNames(config, "other", "other", null, "PUBG M 娛樂"),
    ["〢・PUBG娛樂審核官"],
  );
});

test("employment applications block only customers with paid orders in the same store", async () => {
  const filters = [];
  const supabase = {
    from(table) {
      assert.equal(table, "play_orders");
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async limit() { return { data: [{ id: "paid-order" }], error: null }; },
      };
    },
  };

  assert.equal(await hasPaidOrderAtStore({
    supabase,
    discordUserId: "123456789012345678",
    guildId: "qiunai-guild",
  }), true);
  assert.deepEqual(filters, [
    ["guild_id", "qiunai-guild"],
    ["customer_id", "123456789012345678"],
    ["paid", true],
  ]);
});

test("paid customers receive the owner restriction when starting an application", async () => {
  const replies = [];
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async limit() {
          return {
            data: table === "play_orders" ? [{ id: "paid-order" }] : [],
            error: null,
          };
        },
      };
    },
  };
  const system = createEmploymentSystem(
    {},
    { brandName: "秋奈電競", organization: "qiunai" },
    supabase,
  );
  const handled = await system.handleInteraction({
    customId: "employment_start",
    guildId: "qiunai-guild",
    user: { id: "123456789012345678" },
    async deferReply(payload) { replies.push(["defer", payload]); },
    async editReply(payload) { replies.push(["edit", payload]); },
  });

  assert.equal(handled, true);
  assert.equal(replies[0][1].flags, 64);
  assert.equal(
    replies[1][1].content,
    "老闆身分不給予申請陪陪，別間店消費則不受影響",
  );
});

test("paid active companions can still start an employment assessment", async () => {
  const replies = [];
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async limit() {
          return {
            data:
              table === "play_orders"
                ? [{ id: "paid-order" }]
                : [{ discord_id: "123456789012345678" }],
            error: null,
          };
        },
      };
    },
  };
  assert.equal(
    await hasActiveCompanionAtStore({
      supabase,
      discordUserId: "123456789012345678",
      guildId: "qiunai-guild",
      organization: "qiunai",
    }),
    true,
  );
  const system = createEmploymentSystem(
    {},
    { brandName: "秋奈電競", organization: "qiunai" },
    supabase,
  );
  await system.handleInteraction({
    customId: "employment_start",
    guildId: "qiunai-guild",
    user: { id: "123456789012345678" },
    async deferReply(payload) { replies.push(["defer", payload]); },
    async editReply(payload) { replies.push(["edit", payload]); },
  });
  assert.match(replies[1][1].content, /是否同意陪玩共同守則/);
});

test("completed employment threads delete after 24 hours of inactivity", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(getCompletedThreadDeleteDelay(0, 23 * hour), hour);
  assert.equal(getCompletedThreadDeleteDelay(0, 24 * hour), 0);
  assert.equal(getCompletedThreadDeleteDelay(10 * hour, 25 * hour), 9 * hour);
});

test("employment result notice does not reveal pass or fail", () => {
  const notice = buildEmploymentResultNotice("幽語", "123456789012345678");
  assert.equal(
    notice,
    "已發送面試結果\n" +
      "審核官：幽語（<@123456789012345678>）\n" +
      "通過面試者會額外收到入職相關資訊，若未收到面試結果請於此通知審核官。此討論串閒置 24 小時後會自動刪除。",
  );
  assert.doesNotMatch(notice, /結果：通過|結果：不通過/);
});

test("existing companions taking a new assessment only receive the result", () => {
  const passed = buildExistingCompanionResultDm("通過", "Apex");
  const rejected = buildExistingCompanionResultDm("不通過", "英雄聯盟");
  assert.equal(passed, "你申請的「Apex」加考結果：通過。");
  assert.equal(rejected, "你申請的「英雄聯盟」加考結果：不通過。");
  assert.doesNotMatch(`${passed}\n${rejected}`, /工作群|新人|簽署|入職/);
});

test("approved employment DM includes deadlines and online signing link", () => {
  const content = buildApprovedEmploymentDmContent(
    {
      brandName: "深夜不關燈",
      workGuildInvite: "https://discord.gg/example",
      newcomerChannelId: "123456789012345678",
    },
    "https://salary.example/employment-sign/test-token",
  );
  assert.match(content, /48小時內入群報到/);
  assert.match(content, /新人入職必看頻道/);
  assert.match(content, /線上入職契約/);
  assert.match(content, /salary\.example\/employment-sign\/test-token/);
  assert.match(content, /第一次登入 EIP 才會正式啟用/);
  const contract = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "assets",
      "employment",
      "陪陪承攬合作契約書_v1.1.pdf",
    ),
  );
  assert.equal(contract.subarray(0, 4).toString(), "%PDF");
  assert.ok(contract.length > 300_000);
});

test("既有員工與跨店已簽署人員不會收到重複簽署連結", () => {
  const config = {
    brandName: "秋奈電競",
    workGuildInvite: "https://discord.gg/example",
    newcomerChannelId: "123456789012345678",
  };
  const crossStore = buildApprovedEmploymentDmContent(config, {
    required: false,
    reason: "already_signed",
  });
  const legacy = buildApprovedEmploymentDmContent(config, {
    required: false,
    reason: "legacy_staff",
  });
  assert.match(crossStore, /任一店完成入職文件簽署/);
  assert.match(legacy, /2026 年 9 月 1 日前已有公司員工資料/);
  assert.doesNotMatch(`${crossStore}\n${legacy}`, /employment-sign\//);
});

test("employment PDF generation returns a valid Chinese PDF", async () => {
  const buffer = await buildEmploymentPdfBuffer({
    brandName: "秋奈電競",
    applicantId: "123456789012345678",
    gameKey: "valorant",
    track: "technical",
    fields: [
      { name: "填寫日期", value: "2026/07/26 21:00:00" },
      { name: "填寫人", value: "測試申請人" },
      { name: "是否同意陪玩共同守則", value: "同意" },
    ],
    result: "通過",
    reviewer: "測試審核官",
    reviewedAt: "2026/07/26 21:10:00",
  });

  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
  assert.ok(buffer.length > 20_000);
});
