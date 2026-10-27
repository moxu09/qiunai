const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const discord = require("discord.js");
const policy = require("../utils/inChannelOrder");
const source = fs.readFileSync(require.resolve("../events/dispatchSystem"), "utf8");
const index = fs.readFileSync(require.resolve("../index"), "utf8");
const privateOrder = { id: "order", channel_id: "vip", customer_id: "customer", note: "需求 [MANUAL_DISPATCH] [IN_CHANNEL_ORDER]", player_count: 2, preferred_player: "a,b", price: 600, original_price: 600, final_price: 600, status: "quoted", quote_status: "quoted", payment_method: "未選擇", paid: false };
function fn(name, globals = {}) {
  const start = source.indexOf(`async function ${name}(`);
  assert(start >= 0, name);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function /) + 1;
  return vm.runInNewContext(`(${end ? tail.slice(0, end) : tail}\n)`, {
    ...discord, ...policy, QIUNAI_WATER_BLUE: "#9ddfff", process: { env: {} }, console, ...globals,
  });
}
function db(order) {
  const calls = [];
  let inserted;
  const query = {
    select() { return this; }, eq(...args) { calls.push(["eq", ...args]); return this; },
    in(...args) { calls.push(["in", ...args]); return this; },
    update(value) { calls.push(["update", value]); Object.assign(order, value); return this; },
    insert(value) { inserted = value; return this; },
    async single() { return { data: inserted ? { id: "order", ...inserted } : { ...order } }; },
    async maybeSingle() { return { data: { ...order } }; },
  };
  return { from: () => query, calls, get inserted() { return inserted; } };
}
test("原房付款要求同頻道且選齊陪陪，遺失目的地不可退回公開頻道", () => {
  assert.doesNotThrow(() => policy.assertInChannelSelection(privateOrder, "vip"));
  assert.throws(() => policy.assertInChannelSelection(privateOrder, "public"), /原本/);
  for (const preferred_player of [null, "a", "a,a"]) assert.throws(() => policy.assertInChannelSelection({ ...privateOrder, preferred_player }), /選齊/);
  assert.equal(policy.staffOrderChannelId(privateOrder, "public"), "vip");
  assert.throws(() => policy.staffOrderChannelId({ ...privateOrder, channel_id: null }, "public"), /停止/);
  assert.equal(policy.staffOrderChannelId({ note: "[MANUAL_DISPATCH]" }, "public"), "public");
});
test("新增訂單草稿保留原房模式，其他下單入口維持原流程", async () => {
  for (const inChannelOnly of [true, false]) {
    let saved; const messages = [];
    await fn("startNewOrderFlow", { pendingNewOrders: { set: async (_, value) => { saved = value; } },
      NEW_ORDER_GAME_OPTIONS: [{ value: "特戰" }], buildNewOrderItemMenu: () => new discord.StringSelectMenuBuilder().setCustomId("game").addOptions({ label: "娛樂", value: "fun" }),
    })({ id: "vip", guildId: "guild", send: async m => messages.push(m) }, { id: "customer", username: "name" }, "特戰", { inChannelOnly });
    assert.equal(saved.inChannelOnly, inChannelOnly); assert.equal(saved.channelId, "vip"); assert.equal(messages.length, 1);
  }
  const command = index.slice(index.indexOf('if (interaction.commandName==="新增訂單")') >= 0 ? index.indexOf('if (interaction.commandName==="新增訂單")') : index.indexOf('if (interaction.commandName === "新增訂單")'));
  assert.match(command.slice(0, 2400), /inChannelOnly: true/);
});
test("自動報價建立原房訂單並保留金額，不呼叫外部派單", async () => {
  const database = db({}); let panel; let prompt;
  const pending = { userId: "customer", channelId: "vip", guildId: "guild", game: "特戰", item: "娛樂", duration: "2h", playerCount: 2, inChannelOnly: true };
  const interaction = { channel: { id: "vip" }, user: { id: "staff" }, deferred: true,
    isModalSubmit: () => true, editReply: async value => { panel = value; } };
  await fn("createWaitingQuoteOrder", { supabase: database, getNextPlayOrderNumber: async () => "QN1",
    getGeneralOrderAutoQuote: () => ({ ok: true, quote: { total: 1200 } }), pendingNewOrders: { delete: async () => {} },
    sendManualQuoteDispatchPrompt: async (channel, order) => { prompt = order; assert.equal(channel.id, "vip"); },
  })(interaction, "draft", pending);
  assert.equal(database.inserted.price, 1200); assert.equal(database.inserted.channel_id, "vip");
  assert(policy.isInChannelOrder(prompt)); assert.match(panel.embeds[0].data.description, /本頻道/);
});
test("原房報價僅顯示本地客服面板，未選人不進付款", async () => {
  let panels = 0; let confirms = 0;
  const prompt = fn("sendManualQuoteDispatchPrompt", { sendStaffQuotePanel: async () => panels++, sendOrderQuotePriceConfirm: async () => confirms++ });
  await prompt({}, { ...privateOrder, preferred_player: null }); assert.equal(panels, 1); assert.equal(confirms, 0);
  await prompt({}, privateOrder); assert.equal(confirms, 1);
  const forbidden = fn("sendSelfServiceDispatch", { client: { channels: { fetch() { throw Error("不應讀公開頻道"); } } } });
  await assert.rejects(forbidden(privateOrder), /不可送到外部/);
});
test("付款成功與恢復查找均只使用原房，不送公開派單區", async () => {
  const destinations = []; const sent = [];
  const client = { channels: { fetch: async id => { destinations.push(id); return { send: async message => { sent.push(message); return { id: "message" }; } }; } } };
  const globals = { client, isManualDispatchOrder: () => true, getManualDispatchChannelId: () => "public", buildPreferredPlayerText: () => "陪陪", isManualQuoteSelfServiceOrder: () => false, getPublicOrderNote: () => "需求", findMessageByButton: async () => null };
  await fn("sendOrderToStaffChannel", globals)({ ...privateOrder, paid: true });
  await fn("findExistingStaffOrderMessage", globals)(privateOrder);
  assert.deepEqual(destinations, ["vip", "vip"]); assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components[0].data.disabled, true);
});
test("客服選齊後本地確認報價；付款中、錯誤頻道與無效人選不更新", async () => {
  for (const variant of ["ok", "checkout", "wrong-channel", "invalid", "missing"]) {
    const order = { ...privateOrder, preferred_player: null, ...(variant === "checkout" ? { quote_status: "price_confirmed" } : {}) };
    const database = db(order); let confirms = 0;
    const interaction = { customId: "submit_dispatch_players_order", channelId: variant === "wrong-channel" ? "public" : "vip", channel: {}, values: variant === "invalid" ? ["a", "outsider"] : variant === "missing" ? ["a"] : ["a", "b"], deferred: true, editReply: async () => {} };
    await fn("submitDispatchPlayers", { supabase: database, canCustomerOrStaffSubmit: () => true,
      getAvailablePlayerOptions: async () => [{ value: "a" }, { value: "b" }], sendOrderQuotePriceConfirm: async () => confirms++,
    })(interaction);
    assert.equal(database.calls.filter(c => c[0] === "update").length, variant === "ok" ? 1 : 0);
    assert.equal(confirms, variant === "ok" ? 1 : 0);
  }
});
test("未選齊不會確認報價或顯示付款選項", async () => {
  const database = db({ ...privateOrder, preferred_player: null }); let reply;
  await fn("handleOrderQuotePriceConfirm", { supabase: database, deferReplyOnce: async () => {} })({
    customId: "quote_confirm_price_order_600", user: { id: "customer" }, channelId: "vip", editReply: async value => { reply = value; },
  });
  assert.match(reply.content, /選齊/); assert.equal(database.calls.filter(c => c[0] === "update").length, 0);
});
test("舊正式派單按鈕無法把原房單送出去", async () => {
  let reply;
  await fn("confirmManualQuoteAndDispatch", { supabase: db({ ...privateOrder }), deferReplyOnce: async () => {}, isManualDispatchOrder: () => true })({
    customId: "manual_quote_dispatch_order", editReply: async value => { reply = value; },
  });
  assert.match(reply.content, /原頻道內選人/);
});
test("已付款原房單加入選定陪陪、發報單及管理面板，其他頻道不可接手", async () => {
  const database = db({ ...privateOrder, paid: true }); const permissions = []; const reports = []; const messages = [];
  const send = fn("sendStaffOrderControlPanel", { supabase: database, isManualDispatchOrder: () => true,
    workReportSystem: { sendForAcceptedOrder: async (order, ids) => reports.push({ order, ids: Array.from(ids) }) },
  });
  const channel = { id: "vip", isTextBased: () => true, permissionOverwrites: { edit: async id => permissions.push(id) }, send: async value => { messages.push(value); return { id: "panel" }; } };
  await send(channel, { ...privateOrder, paid: true });
  assert.deepEqual(permissions, ["a", "b"]); assert.deepEqual(reports[0].ids, ["a", "b"]);
  assert.equal(reports[0].order.assigned_player, "a,b"); assert.equal(reports[0].order.status, "accepted");
  assert.equal(messages.length, 2); assert.equal(messages[1].components[1].components[0].data.custom_id, "complete_order_order");
  await assert.rejects(send({ ...channel, id: "public" }, { ...privateOrder, paid: true }), /原本/);
  assert.equal(messages.length, 2);
});
test("舊關閉與存檔刪除按鈕遇原房訂單停止，查詢失敗亦不刪房", async () => {
  const start = index.indexOf('if (["owner_cancel_ticket", "close_ticket",');
  const end = index.indexOf('\n      if (', start + 5);
  const guard = index.slice(start, end);
  assert(start > 0 && end > start);
  for (const customId of ["owner_cancel_ticket", "close_ticket", "customer_confirm_close_order", "delete_order_now", "save_order_log"]) {
    for (const error of [null, Error("DB unavailable")]) {
      let reply;
      const query = { select() { return this; }, eq() { return this; }, like() { return this; }, limit() { return this; }, async maybeSingle() { return { data: error ? null : { id: "order" }, error }; } };
      await vm.runInNewContext(`(async()=>{${guard}; throw Error("不應繼續刪房");})()`, { customId, supabase: { from: () => query }, interaction: { channel: { id: "vip" }, reply: async value => { reply = value; } } });
      assert(reply.content);
    }
  }
  assert.match(index, /remainingOrderError \|\| isInChannelOrder\(order\)/);
  assert.match(index, /if \(isInChannelOrder\(order\)\) \{\s*await interaction.channel.send\([\s\S]*?原房會持續保留/);
});
