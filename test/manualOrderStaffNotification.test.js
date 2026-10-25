const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const discord = require("discord.js");
const source = fs.readFileSync(path.join(__dirname, "../events/dispatchSystem.js"), "utf8");
const start = source.indexOf("async function createServiceTicket(");
const end = source.indexOf("async function showValorantStart(", start);
assert(start >= 0 && end > start);

async function open(serviceType, fromPanel, configuredRole = "1210642900355125288") {
  const messages = [], creates = [], saved = [], steps = [];
  const channel = {id: "1550000000000000001", send: async payload => messages.push(payload)};
  const context = {
    ...discord, process: {env: {STAFF_ROLE: configuredRole}},
    DEFAULT_CUSTOMER_SERVICE_ROLE_ID: "1210642900355125288",
    ORDER_TICKET_CATEGORY_ID: "1530875019851202851", QIUNAI_WATER_BLUE: "#7CC7FF",
    getServiceName: type => type, createFlowId: id => id + "_test",
    resolveTicketParentId: async () => "1530875019851202851",
    pendingServiceOrders: {set: async (id, data) => saved.push(data)},
    sendQuickServiceNeedPanel: async () => steps.push("panel"),
    showValorantStart: async () => steps.push("valorant"),
    showSteamStart: async () => steps.push("steam"),
    showDeltaStart: async () => steps.push("delta"),
    showSimpleServiceStart: async (_channel, _flow, type) => steps.push(type),
  };
  const run = vm.runInNewContext(source.slice(start, end) + ";createServiceTicket", context);
  const user = {id: "847840193859682304", username: "test-customer"};
  const interaction = {user, guildId: "1206138511535898654", deferred: false, replied: false,
    guild: {id: "1206138511535898654", channels: {create: async payload => {creates.push(payload);return channel;}}},
    deferReply: async () => {}, editReply: async () => {},
  };
  await run(interaction, serviceType, {fromPanel});
  return {messages, creates, saved, steps, user};
}

test("每個人工服務新舊入口只在歡迎訊息標記客服一次", async () => {
  for (const fromPanel of [true, false]) {
    for (const type of ["valorant", "steam", "delta", "chat", "emotion", "lol", "other"]) {
      const {messages, creates, saved, steps, user} = await open(type, fromPanel);
      assert.equal(messages.length, 1);
      const message = messages[0];
      assert.match(message.content, /<@&1210642900355125288>/);
      assert.match(message.content, new RegExp("<@" + user.id + ">"));
      assert.match(message.content, /客服人員正手刀衝刺/);
      assert.deepEqual(Array.from(message.allowedMentions.roles), ["1210642900355125288"]);
      assert.deepEqual(Array.from(message.allowedMentions.users), [user.id]);
      assert.equal(message.allowedMentions.parse.length, 0);
      assert.equal(creates.length, 1);
      assert.equal(saved.length, 1);
      assert.equal(creates[0].parent, "1530875019851202851");
      assert.equal(message.components[0].components[0].data.custom_id, "owner_cancel_ticket");
      assert.equal(steps.includes("panel"), fromPanel);
    }
  }
});
test("通知沿用指定客服角色；未設定時使用秋奈客服，不標記 everyone", async () => {
  for (const [role, expected] of [["1550000000000000002", "1550000000000000002"], ["", "1210642900355125288"]]) {
    const {messages} = await open("valorant", true, role);
    assert.match(messages[0].content, new RegExp("<@&" + expected + ">"));
    assert.doesNotMatch(messages[0].content, /@everyone|@here/);
  }
});
test("自助下單的獨立流程不受人工歡迎通知改動影響", () => {
  const block = source.slice(start, end);
  assert.equal((source.match(/const welcomeNotification =/g) || []).length, 1);
  assert.equal((block.match(/\.\.\.welcomeNotification/g) || []).length, 2);
  assert.match(block, /sendQuickServiceNeedPanel/);
});
