const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { DEFAULT_CUSTOMER_SERVICE_ROLE_ID } = require("../utils/customerServicePoints");

function loadQuoteHandler() {
  const filename = path.join(__dirname, "..", "events", "dispatchSystem.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename, "utf8") + `
    module.exports.__quoteTest = {
      submitServiceQuotePrice,
      sendServiceQuoteConfirmPrompt,
      handleServiceQuoteConfirm,
      sendOrderQuotePriceConfirm,
      wire(store, effects) {
        pendingServiceOrders = store;
        sendServiceQuoteConfirmPrompt = async (channel, flowId, pending) => {
          effects.prompts.push({ flowId, pending: structuredClone(pending) });
        };
        sendServiceCouponPrompt = async (channel, flowId, pending) => {
          effects.couponPrompts = (effects.couponPrompts || 0) + 1;
        };
      },
    };
  `, filename);
  return loaded.exports.__quoteTest;
}

function fixture(api, member, fields = { price: "560" }, pending = {}) {
  const effects = { gets: 0, writes: [], prompts: [], replies: [], deferred: 0 };
  api.wire({
    async get(flowId) {
      assert.equal(flowId, "quote-flow");
      effects.gets++;
      return { category: "other", serviceTypes: [], ...pending };
    },
    async set(flowId, value) {
      effects.writes.push({ flowId, pending: structuredClone(value) });
    },
  }, effects);
  return {
    effects,
    interaction: {
      customId: "submit_service_quote_price_quote-flow",
      user: { id: "808875987034308618" },
      guild: { ownerId: "different-owner" },
      member,
      channel: {},
      fields: { getTextInputValue: key => fields[key] },
      async deferReply() { effects.deferred++; },
      async editReply(reply) { effects.replies.push(reply); return reply; },
    },
  };
}

test("客服報價實際回呼可用 cached/raw 客服角色保存報價與報價人", async () => {
  const oldStaffRole = process.env.STAFF_ROLE;
  const pointRole = process.env.CUSTOMER_SERVICE_POINT_ROLE_ID || DEFAULT_CUSTOMER_SERVICE_ROLE_ID;
  process.env.STAFF_ROLE = pointRole;
  try {
    const api = loadQuoteHandler();
    for (const roles of [[pointRole], { cache: new Map([[pointRole, {}]]) }]) {
      const { effects, interaction } = fixture(api, { roles, permissions: "0" });
      await api.submitServiceQuotePrice(interaction);
      assert.equal(effects.deferred, 1);
      assert.equal(effects.writes.length, 1);
      assert.equal(effects.prompts.length, 1);
      assert.equal(effects.writes[0].pending.quotedPrice, 560);
      assert.equal(effects.writes[0].pending.quotedBy, interaction.user.id);
      assert.equal(effects.writes[0].pending.serviceCouponRecorded, false);
      assert.equal(effects.writes[0].pending.quoteConfirmedPrice, null);
      assert.match(effects.replies[0].content, /已送出正式報價/);
    }
  } finally {
    if (oldStaffRole === undefined) delete process.env.STAFF_ROLE;
    else process.env.STAFF_ROLE = oldStaffRole;
  }
});

test("一般新訂單先顯示報價確認，不直接開放優惠券", async () => {
  const api = loadQuoteHandler();
  const sent = [];
  await api.sendOrderQuotePriceConfirm({ async send(payload) { sent.push(payload); } }, {
    id: "123", order_no: "Q-123", customer_id: "customer", original_price: 560,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components[0].toJSON().custom_id, "quote_confirm_price_123_560");
  assert.match(sent[0].embeds[0].toJSON().description, /NT\$560/);
});

test("顧客確認最新報價後才開放優惠券；舊金額與非顧客不得確認", async () => {
  const api = loadQuoteHandler();
  const effects = { prompts: [], replies: [], couponPrompts: 0 };
  let pending = { customerId: "customer", category: "other", quotedPrice: 560, originalPrice: 560, finalPrice: 560, quoteConfirmedPrice: null };
  api.wire({ async get() { return structuredClone(pending); }, async set(_id, value) { pending = structuredClone(value); } }, effects);
  const makeInteraction = (customId, userId) => ({
    customId, user: { id: userId }, channel: {}, message: { async edit() {} },
    async deferReply() {}, async editReply(reply) { effects.replies.push(reply); return reply; },
  });
  await api.handleServiceQuoteConfirm(makeInteraction("service_confirm_quote_flow_560", "someone-else"));
  await api.handleServiceQuoteConfirm(makeInteraction("service_confirm_quote_flow_500", "customer"));
  assert.equal(effects.couponPrompts, 0);
  assert.equal(pending.quoteConfirmedPrice, null);
  await api.handleServiceQuoteConfirm(makeInteraction("service_confirm_quote_flow_560", "customer"));
  assert.equal(pending.quoteConfirmedPrice, 560);
  assert.equal(effects.couponPrompts, 1);
  await api.handleServiceQuoteConfirm(makeInteraction("service_confirm_quote_flow_560", "customer"));
  assert.equal(effects.couponPrompts, 1);
});

test("管理員可報價但無客服點數角色不自動歸屬，雙人分單報價仍正確", async () => {
  const api = loadQuoteHandler();
  const { effects, interaction } = fixture(api,
    { roles: [], permissions: "8" },
    { entertain_price: "500", skill_price: "700" },
    { category: "valorant", serviceTypes: ["娛樂", "技術"] },
  );
  await api.submitServiceQuotePrice(interaction);
  assert.equal(effects.writes.length, 1);
  assert.equal(effects.writes[0].pending.quotedBy, null);
  assert.equal(effects.writes[0].pending.quotedPrice, 1200);
  assert.deepEqual(effects.writes[0].pending.quoteParts, { entertain: 500, skill: 700 });
  assert.equal(effects.prompts.length, 1);
});

test("非客服或缺成員資料仍不能讀寫報價，不因補回角色 helper 擴大權限", async () => {
  const api = loadQuoteHandler();
  for (const member of [{ roles: [], permissions: "0" }, undefined]) {
    const { effects, interaction } = fixture(api, member);
    await api.submitServiceQuotePrice(interaction);
    assert.equal(effects.gets, 0);
    assert.equal(effects.writes.length, 0);
    assert.equal(effects.prompts.length, 0);
    assert.match(effects.replies[0].content, /只有客服可以填寫報價/);
  }
});
