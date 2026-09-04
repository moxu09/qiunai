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
  isAllowedCallbackIp,
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
  calculateSelfServicePrice,
  getValorantCompanionOptions,
  getValorantExpectedUnit,
} = require("../config/selfServicePricing");
const {
  appendSelfServiceClaimNote,
  getSelfServiceClaimNotes,
  getSelfServiceDispatchAt,
  getSelfServiceDispatchRoleIds,
  stripSelfServiceClaimNotes,
  resolveSelfServicePlayerNumbers,
  getPaidOrderPriceAdjustment,
} = require("../events/dispatchSystem");

test("自助下單依現行價目表計算多人與時數", () => {
  assert.deepEqual(
    getValorantCompanionOptions("黃金以下").map(({ value }) => value),
    ["娛樂", "超凡", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("超凡").map(({ value }) => value),
    ["娛樂", "神話", "輻能", "頂輻"],
  );
  assert.deepEqual(
    getValorantCompanionOptions("神話1至2").map(({ value }) => value),
    ["輻能", "頂輻"],
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
  assert.throws(() => buildJkopayRefundPayload("WASH-123", 100), /格式錯誤/);
  assert.throws(
    () => buildJkopayRefundPayload("QIUNAI-TOP-0000000123", 0),
    /金額錯誤/,
  );
});

test("秋奈儲值主面板與付款選單都明確顯示街口支付", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /建立儲值單｜支援街口支付/);
  assert.match(indexSource, /使用街口支付，付款完成後系統會自動核帳/);
  assert.match(dispatchSource, /label: "街口支付"/);
  assert.match(dispatchSource, /完成付款後自動儲值 ASD/);
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
  assert.match(jkopaySource, /unredeem: 0/);
  assert.match(jkopaySource, /\[JKOPAY\]\[INQUIRY\]\[REQUEST\]/);
  assert.match(jkopaySource, /\/payments\/jkopay\/gateway\/refund/);
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

test("自助派單湊足需求人數後仍持續開放扣 1，直到客人選定", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /\["self_dispatching", "self_choosing_open"\]\.includes\(order\.quote_status\)/);
  assert.match(source, /quote_status: success \? "self_choosing_open" : "self_dispatching"/);
  assert.match(source, /老闆選定前仍可繼續扣 1/);
  assert.match(source, /content: `\$\{selectedIds\.map\(\(id\) => `<@\$\{id\}>`\)\.join\(" "\)\} 接！`/);
  assert.doesNotMatch(source, /playerIds\.length >= needCount\) return interaction\.editReply\(\{ content: "❌ 這張訂單人數已滿/);
  assert.doesNotMatch(source, /只有秋奈在職陪陪可以扣 1/);
  assert.doesNotMatch(source, /你的身分組不符合這筆訂單/);
  assert.match(source, /setLabel\("接單備註（選填）"\)/);
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

test("自助派單扣 1 備註可保存、讀取並在重新派單時清除", () => {
  const note = appendSelfServiceClaimNote(
    "[SELF_SERVICE] 原始訂單內容",
    "808875987034308618",
    "可立即開始 @everyone",
  );
  assert.equal(
    getSelfServiceClaimNotes(note).get("808875987034308618"),
    "可立即開始 @everyone",
  );
  assert.equal(
    stripSelfServiceClaimNotes(note),
    "[SELF_SERVICE] 原始訂單內容",
  );
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
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(indexSource, /customId\.startsWith\("self_service_valorant_target_"\)/);
  assert.match(indexSource, /customId\.startsWith\("self_service_valorant_companion_"\)/);
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
  createHealthState,
  createNonOverlappingTask,
  createTtlSet,
  scheduleMapExpiry,
  validateEnvironment,
} = require("../utils/runtime");
const { getTaipeiScheduleParts } = require("../utils/dailySelfCheck");

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

test("Qiunai salary deduction covers quote, service, extension, and tip payments", () => {
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
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  assert.match(indexSource, /value: "員工扣薪"/);
  assert.match(indexSource, /confirm_tip_salary_/);
  assert.match(indexSource, /使用薪水打賞/);
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
