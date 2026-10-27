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
test("原房付款要求同頻道，不強制選人，遺失目的地不可退回公開頻道", () => {
  assert.doesNotThrow(() => policy.assertInChannelSelection(privateOrder, "vip"));
  assert.throws(() => policy.assertInChannelSelection(privateOrder, "public"), /原本/);
  assert.doesNotThrow(() => policy.assertInChannelSelection({ ...privateOrder, preferred_player: null }));
  for (const preferred_player of ["a", "a,a"]) assert.throws(() => policy.assertInChannelSelection({ ...privateOrder, preferred_player }), /選齊/);
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
    sendStaffQuotePanel: async order => { prompt = order; }, sendOrderQuotePriceConfirm: async channel => assert.equal(channel.id, "vip"),
  })(interaction, "draft", pending);
  assert.equal(database.inserted.price, 1200); assert.equal(database.inserted.channel_id, "vip");
  assert(policy.isInChannelOrder(prompt)); assert.match(panel.embeds[0].data.description, /本頻道/);
});
test("客服填完金額只送顧客確認，不再重複客服面板，無指定陪陪也可付款", async () => {
  let panels = 0; let confirms = 0;
  const prompt = fn("sendManualQuoteDispatchPrompt", { sendStaffQuotePanel: async () => panels++, sendOrderQuotePriceConfirm: async () => confirms++ });
  await prompt({}, { ...privateOrder, preferred_player: null }); assert.equal(panels, 0); assert.equal(confirms, 1);
  await prompt({}, privateOrder); assert.equal(confirms, 2);
  const forbidden = fn("sendSelfServiceDispatch", { client: { channels: { fetch() { throw Error("不應讀公開頻道"); } } } });
  await assert.rejects(forbidden(privateOrder), /不可送到外部/);
});
test("已指定陪陪的原房單保留原房通知，不重複公開接單", async () => {
  const destinations = []; const sent = [];
  const client = { channels: { fetch: async id => { destinations.push(id); return { send: async message => { sent.push(message); return { id: "message" }; } }; } } };
  const globals = { client, isManualDispatchOrder: () => true, getManualDispatchChannelId: () => "public", buildPreferredPlayerText: () => "陪陪", isManualQuoteSelfServiceOrder: () => false, getPublicOrderNote: () => "需求", findMessageByButton: async () => null };
  await fn("sendOrderToStaffChannel", globals)({ ...privateOrder, paid: true });
  await fn("findExistingStaffOrderMessage", globals)(privateOrder);
  assert.deepEqual(destinations, ["vip", "vip"]); assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components[0].data.disabled, true);
});
test("未指定陪陪的原房加單付款後送接單專區，附可用接單按鈕，恢復查找使用同一目的地", async () => {
  const destinations = [], sent = [], searched = [];
  const order = { ...privateOrder, paid: true, preferred_player: null };
  const globals = {
    process: { env: { PLAYER_ORDER_CHANNEL: "acceptance", PLAYER_ROLE_ID: "player-role" } },
    client: { channels: { fetch: async id => { destinations.push(id); return { send: async value => { sent.push(value); return { id: "new-message" }; } }; } } },
    isManualDispatchOrder: () => true, getManualDispatchChannelId: () => "old-game-dispatch",
    buildPreferredPlayerText: () => "不指定", isManualQuoteSelfServiceOrder: () => false, getPublicOrderNote: () => "需求",
    findMessageByButton: async (_, id) => { searched.push(id); return null; },
  };
  await fn("sendOrderToStaffChannel", globals)(order);
  await fn("findExistingStaffOrderMessage", globals)(order);
  assert.deepEqual(destinations, ["acceptance", "acceptance"]);
  assert.equal(sent[0].components[0].components[0].data.custom_id, "accept_play_order_order");
  assert.notEqual(sent[0].components[0].components[0].data.disabled, true);
  assert.deepEqual(searched, ["accept_play_order_order"]); assert.match(sent[0].content, /接單/);
  assert.equal(order.channel_id, "vip");
  assert.equal(policy.staffOrderChannelId(order, "game-dispatch", "acceptance"), "acceptance");
  assert.throws(() => policy.staffOrderChannelId(order, "game-dispatch", null), /未設定接單專區/);
});
test("原房加單接單限已付款本店訂單，同時接單只允許一個成功並發送一份報單", async () => {
  async function runCase({ paid = true, guild = "shop", concurrent = false } = {}) {
    const order = { ...privateOrder, preferred_player: null, assigned_player: null, player_count: 1, paid, guild_id: guild, status: "pending" };
    let assignments = 0, reports = 0, permissionEdits = 0;
    const db = { from(table) {
      if (table === "qiunai_staff") {
        const q = { select() { return this; }, eq() { return this; }, async limit() { return { data: [{ discord_id: "a", status: "available" }] }; } }; return q;
      }
      let value; const filters = [];
      const query = {
        select() { return this; }, update(v) { value = v; return this; }, eq(k,v) { filters.push([k,v]); return this; },
        is(k,v) { filters.push([k,v]); return this; }, in() { return this; },
        async maybeSingle() {
          if (!value) return { data: { ...order } };
          if (filters.some(([k,v]) => order[k] !== v)) return { data: null };
          Object.assign(order, value); if (value.assigned_player) assignments++; return { data: { ...order } };
        },
        then(resolve) { resolve({}); },
      }; return query;
    } };
    const channel = { id: "vip", send: async () => {}, permissionOverwrites: { edit: async () => permissionEdits++ } };
    const accept = fn("acceptPlayOrder", { supabase: db, process: { env: { GUILD_ID: "shop" } }, applyStaffGuildFilter: x => x,
      workReportSystem: { sendForAcceptedOrder: async () => reports++ }, client: { channels: { fetch: async id => { assert.equal(id, "vip"); return channel; } } }, sendPlayLog: async () => {},
    });
    const replies = [];
    const interaction = id => ({ customId: "accept_play_order_order", user: { id }, editReply: async value => replies.push(value) });
    if (concurrent) await Promise.all([accept(interaction("a")), accept(interaction("b"))]); else await accept(interaction("a"));
    return { order, assignments, reports, permissionEdits, replies };
  }
  for (const opts of [{ paid: false }, { guild: "other-shop" }]) {
    const r = await runCase(opts); assert.equal(r.assignments, 0); assert.equal(r.reports, 0); assert.match(r.replies[0].content, /無法接單/);
  }
  const r = await runCase({ concurrent: true }); assert.equal(r.assignments, 1); assert.equal(r.reports, 1); assert.equal(r.permissionEdits, 1);
  assert.equal(r.order.status, "accepted"); assert.equal(r.order.channel_id, "vip");
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
test("未指定陪陪也能確認報價並進入優惠券及付款流程", async () => {
  const database = db({ ...privateOrder, preferred_player: null }); let reply; const messages = [];
  await fn("handleOrderQuotePriceConfirm", { supabase: database, deferReplyOnce: async () => {}, isVipPointsActive: () => false, pointsPromptText: async () => "" })({
    customId: "quote_confirm_price_order_600", user: { id: "customer" }, channelId: "vip", channel: { send: async value => messages.push(value) }, editReply: async value => { reply = value; },
  });
  assert.match(reply.content, /已確認報價/); assert.equal(database.calls.filter(c => c[0] === "update").length, 1);
  assert.equal(messages[0].components[0].components[0].data.custom_id, "quote_use_coupon_order");
});
test("原房客服面板移除選陪陪，重送時更新原訊息，首次送出有去重nonce", async () => {
  const messages = []; let existing = null; let edits = 0;
  const channel = { send: async value => { messages.push(value); existing = { edit: async v => { edits++; messages[0] = v; } }; } };
  const send = fn("sendStaffQuotePanel", { client: { channels: { fetch: async () => channel } }, require,
    isManualDispatchOrder: () => true, isManualQuoteSelfServiceOrder: () => false, getPublicOrderNote: () => "測試",
    findMessageByButton: async () => existing,
  });
  await send(privateOrder); assert.equal(messages.length, 1); assert.equal(messages[0].enforceNonce, true);
  const buttons = messages[0].components[0].components.map(b => b.data.custom_id);
  assert.deepEqual(buttons, ["staff_quote_price_order", "staff_edit_order_order", "manual_quote_cancel_order"]);
  await send(privateOrder); assert.equal(messages.length, 1); assert.equal(edits, 1);
});
test("無指定陪陪的原房訂單保留客服面板，尚未接單不捏造報單", async () => {
  const messages = [];
  const send = fn("sendStaffOrderControlPanel", { isManualDispatchOrder: () => true });
  await send({ id: "vip", isTextBased: () => true, send: async value => messages.push(value) }, { ...privateOrder, preferred_player: null, paid: true });
  assert.equal(messages.length, 1); assert.equal(messages[0].components[1].components[0].data.custom_id, "complete_order_order");
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
