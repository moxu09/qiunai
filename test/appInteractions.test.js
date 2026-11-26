const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require("discord.js");
const { createAppBridge } = require("../utils/appBridge");
const { createAppInteractions, CUSTOMER_INTERACTIONS, allowedEntry } = require("../utils/appInteractions");
const dispatchSystem = require("../events/dispatchSystem");

const TOKEN = "test-bot-token";
const GUILD = "1206138511535898654";
const BOT = "900000000000000001";
const OWNER = "123456789012345678";
const OTHER = "223456789012345678";
const CHANNEL = "300000000000000001";
const OTHER_CHANNEL = "300000000000000002";
const ORDER_ID = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";

function quiet(run) {
  if (process.env.DEBUG_APP_TEST) return Promise.resolve().then(run);
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(run).finally(() => Object.assign(console, original));
}

// ---------- fake Supabase ----------
function fakeDb(tables = {}, rpcs = {}) {
  const calls = { rpc: [], updates: [] };
  const rowsOf = (table) => (tables[table] ||= []);
  const db = {
    tables, calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      const handler = rpcs[name];
      return handler ? handler(args, db) : { data: null, error: null };
    },
    from(table) {
      const filters = [];
      let patch = null;
      let insert = null;
      let limit = Infinity;
      const value = (row, key) => {
        const json = /^payload->>(.+)$/.exec(key);
        return json ? row.payload?.[json[1]] : row[key];
      };
      const matching = () => rowsOf(table).filter((row) => filters.every((f) => f(row))).slice(0, limit);
      const finish = () => {
        if (insert) { rowsOf(table).push(...[].concat(insert)); return [].concat(insert); }
        const hits = matching();
        if (patch) { hits.forEach((row) => Object.assign(row, patch)); calls.updates.push({ table, patch }); }
        return hits.map((row) => ({ ...row }));
      };
      const query = {
        select() { return query; },
        update(next) { patch = next; return query; },
        insert(next) { insert = next; return query; },
        upsert(next) { insert = next; return query; },
        delete() { return query; },
        eq(key, v) { filters.push((row) => String(value(row, key)) === String(v)); return query; },
        neq(key, v) { filters.push((row) => String(value(row, key)) !== String(v)); return query; },
        in(key, list) { filters.push((row) => list.map(String).includes(String(value(row, key)))); return query; },
        is(key, v) { filters.push((row) => (value(row, key) ?? null) === v); return query; },
        or() { return query; }, gt() { return query; }, gte() { return query; }, lt() { return query; }, lte() { return query; },
        like() { return query; }, ilike() { return query; }, not() { return query; }, order() { return query; }, range() { return query; },
        limit(n) { limit = n; return query; },
        async maybeSingle() { return { data: finish()[0] ?? null, error: null }; },
        async single() { const row = finish()[0]; return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } }; },
        then(resolve, reject) { try { resolve({ data: finish(), error: null }); } catch (e) { reject(e); } },
      };
      return query;
    },
  };
  return db;
}

// ---------- fake Discord ----------
class Collection extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
  some(fn) { return Boolean(this.find(fn)); }
  filter(fn) { return new Collection([...this].filter(([, v]) => fn(v))); }
}

function fakeDiscord({ members = [OWNER, OTHER], canView = [OWNER], topic = "" } = {}) {
  const sent = [];
  const edits = [];
  const messages = new Map();
  const user = (id) => ({ id, username: `u${id.slice(-3)}`, bot: false, toString: () => `<@${id}>` });
  const memberOf = (id) => ({ id, user: user(id), roles: { cache: new Map() }, permissions: { has: () => false } });
  const makeMessage = (id, payload, authorId = BOT) => {
    const message = {
      id, author: { id: authorId, bot: authorId === BOT }, channelId: CHANNEL,
      content: payload.content || "", embeds: payload.embeds || [], components: payload.components || [],
      flags: { has: () => false },
      async edit(next) { edits.push({ id, payload: next }); if (next.components !== undefined) message.components = next.components; if (next.content !== undefined) message.content = next.content; return message; },
      async delete() { messages.delete(id); },
    };
    messages.set(id, message);
    return message;
  };
  let nextId = 500000000000000000n;
  const channel = {
    id: CHANNEL, guildId: GUILD, topic, type: 0,
    isTextBased: () => true, isThread: () => false,
    permissionsFor: (member) => ({ has: (flag) => flag === PermissionFlagsBits.ViewChannel && canView.includes(member.id) }),
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") return messages.get(arg) || Promise.reject(new Error("Unknown Message"));
        return new Collection([...messages]);
      },
    },
    async send(payload) {
      const body = typeof payload === "string" ? { content: payload } : payload;
      sent.push(body);
      nextId += 1n;
      return makeMessage(String(nextId), body);
    },
    permissionOverwrites: { edit: async () => {} },
  };
  const otherChannel = { ...channel, id: OTHER_CHANNEL, guildId: "999999999999999999" };
  const guild = {
    id: GUILD, ownerId: "1", preferredLocale: "zh-TW",
    members: { async fetch(id) { if (members.includes(id)) return memberOf(id); throw new Error("Unknown Member"); } },
    roles: { cache: new Map() },
    channels: { cache: new Map(), async fetch() { return new Collection(); } },
  };
  const client = {
    user: { id: BOT }, application: { id: BOT },
    isReady: () => true, once() {}, on() {},
    guilds: { cache: new Map([[GUILD, guild]]), async fetch(id) { if (id === GUILD) return guild; throw new Error("Unknown Guild"); } },
    channels: { async fetch(id) { if (id === CHANNEL) return channel; if (id === OTHER_CHANNEL) return otherChannel; return null; } },
    users: { async fetch(id) { return user(id); } },
  };
  return { client, channel, guild, sent, edits, messages, makeMessage };
}

const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (customId, label = "按鈕", disabled = false) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary).setDisabled(disabled);

function setupBridge({ discord, db, route, tokenTtlMs, now } = {}) {
  return createAppInteractions({ getClient: () => discord.client, db, guildId: GUILD, route, tokenTtlMs, now });
}

function ownerDb(extra = {}) {
  return fakeDb({ play_orders: [{ id: "owned", channel_id: CHANNEL, customer_id: OWNER }], ...extra });
}

// ---------- 1. allowlist ----------
test("allowlist: customer prefixes only; staff／客服／陪陪 buttons never match", () => {
  for (const id of [
    `manual_quote_dispatch_${ORDER_ID}`, `manual_quote_cancel_${ORDER_ID}`, `self_selection_extend_${ORDER_ID}`,
    `self_service_prepare_wallet_${ORDER_ID}`, `self_service_pay_wallet_${ORDER_ID}`, `quote_use_coupon_${ORDER_ID}`,
    `self_service_cancel_refund_${ORDER_ID}`, "payment_review_back", "owner_cancel_ticket",
  ]) assert.ok(allowedEntry(id, "button"), id);
  assert.ok(allowedEntry(`self_customer_numbers_${ORDER_ID}`, "select"));
  assert.ok(allowedEntry(`quote_select_coupon_${ORDER_ID}`, "select"));
  assert.ok(allowedEntry(`submit_order_review_5_${ORDER_ID}_anon`, "modal"));
  // Wrong kind, a bare prefix, or exact ids with a suffix are refused.
  assert.equal(allowedEntry(`self_customer_numbers_${ORDER_ID}`, "button"), null);
  assert.equal(allowedEntry("manual_quote_dispatch_", "button"), null);
  assert.equal(allowedEntry("payment_review_back_x", "button"), null);
  assert.equal(allowedEntry(`manual_quote_dispatch_${ORDER_ID}`, "modal"), null);
  for (const id of [
    `staff_confirm_order_paid_${ORDER_ID}`, `service_confirm_paid_${ORDER_ID}`, `service_confirm_paid_group_x1`,
    `service_cancel_order_${ORDER_ID}`, `service_cancel_order_group_x1`, `self_service_bank_confirm_${ORDER_ID}`,
    `salary_quote_confirm_${ORDER_ID}`, `salary_service_confirm_x`, `accept_play_order_${ORDER_ID}`,
    `dispatch_assign_players_${ORDER_ID}`, `change_order_price_${ORDER_ID}`, `confirm_order_price_adjustment_${ORDER_ID}`,
    `confirm_order_paid_gap_${ORDER_ID}`, `self_service_claim_can_${ORDER_ID}`, `extend_order_${ORDER_ID}`,
    `service_quote_price_x`, `staff_quote_price_${ORDER_ID}`, `staff_edit_order_${ORDER_ID}`, `save_order_note_${ORDER_ID}`,
    `saved_order_end_${ORDER_ID}`, `staff_confirm_extension_paid_x`, `work_report_start_x`, `manual_work_confirm_x`,
    "close_ticket", "delete_order_now", "save_order_log", "player_online", `submit_dispatch_players_${ORDER_ID}`,
    `staff_ai_quote_${ORDER_ID}`, `manual_review_5_${OWNER}_x`,
  ]) {
    for (const kind of ["button", "select", "modal"]) assert.equal(allowedEntry(id, kind), null, `${id} (${kind})`);
  }
});

test("allowlist: every entry is routed by a real handler in the bot source", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "..", "utils", "ecpayDiscord.js"), "utf8") +
    fs.readFileSync(path.join(__dirname, "..", "utils", "ecpayInquiry.js"), "utf8");
  for (const entry of CUSTOMER_INTERACTIONS) {
    assert.ok(source.includes(entry.id), entry.id);
    assert.match(entry.label, /[一-鿿]/);
    assert.match(entry.why, /[一-鿿]/);
  }
  const ids = CUSTOMER_INTERACTIONS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate entries");
});

// ---------- 2. bridge route ----------
function sign(method, url, body) {
  const time = String(Date.now());
  const signature = createHmac("sha256", TOKEN).update(`qiunai-website-v1\n${time}\n${method}\n${url}\n${body}`).digest("hex");
  return { "x-website-time": time, "x-website-signature": signature };
}
async function call(bridge, method, url, data, { signed = true, raw } = {}) {
  const body = raw ?? (data === undefined ? "" : JSON.stringify(data));
  const request = { method, url, headers: signed ? sign(method, url, body) : {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  const response = { status: null, text: "", writeHead(s) { this.status = s; }, end(t) { this.text = t || ""; }, get json() { return JSON.parse(this.text); } };
  await bridge.handleHttpRequest(request, response);
  return response;
}

test("bridge: /app/interactions is signed, POST only, 503 without the service, bad JSON 400; allowlist GET", async () => {
  const discord = fakeDiscord();
  const interactions = setupBridge({ discord, db: ownerDb(), route: async () => {} });
  const bridge = createAppBridge({ token: TOKEN, interactions });
  assert.equal((await call(bridge, "POST", "/app/interactions", {}, { signed: false })).status, 401);
  assert.equal((await call(bridge, "GET", "/app/interactions", undefined)).status, 405);
  assert.equal((await call(bridge, "POST", "/app/interactions", undefined, { raw: "{" })).status, 400);
  const none = await call(createAppBridge({ token: TOKEN }), "POST", "/app/interactions", {});
  assert.equal(none.status, 503);
  assert.match(none.json.error, /[一-鿿]/);
  const list = await call(bridge, "GET", "/app/interactions/allowlist", undefined);
  assert.equal(list.status, 200);
  assert.ok(list.json.entries.some((e) => e.id === "manual_quote_dispatch_" && e.kinds.includes("button")));
  assert.ok(list.json.entries.every((e) => !("why" in e)));
  const bad = await call(bridge, "POST", "/app/interactions", { userId: "x", channelId: CHANNEL, messageId: "1", customId: "a" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid_request");
});

// ---------- 3. anti-forgery ----------
test("refuses: staff button even when shown in the customer's channel, before touching Discord", () => quiet(async () => {
  const discord = fakeDiscord();
  discord.makeMessage("600000000000000001", { components: [row(button(`staff_confirm_order_paid_${ORDER_ID}`, "確認收款"))] });
  let routed = 0;
  const interactions = setupBridge({ discord, db: ownerDb(), route: async () => { routed += 1; } });
  const r = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `staff_confirm_order_paid_${ORDER_ID}` });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "not_allowed");
  assert.equal(routed, 0);
}));

test("refuses: not owner, not a member, cannot view, wrong guild, non-bot message, missing/disabled component, bad select values", () => quiet(async () => {
  const id = `manual_quote_dispatch_${ORDER_ID}`;
  let routed = 0;
  const route = async () => { routed += 1; };
  const discord = fakeDiscord({ members: [OWNER, OTHER], canView: [OWNER, OTHER] });
  discord.makeMessage("600000000000000001", { components: [row(button(id))] });
  discord.makeMessage("600000000000000002", { components: [row(button(id))] }, OTHER);
  discord.makeMessage("600000000000000003", { components: [row(button(id, "x", true))] });
  discord.makeMessage("600000000000000004", {
    components: [row(new StringSelectMenuBuilder().setCustomId(`self_customer_numbers_${ORDER_ID}`).setMinValues(1).setMaxValues(1)
      .addOptions({ label: "1", value: "1" }, { label: "2", value: "2" }))],
  });
  const db = ownerDb();
  const interactions = setupBridge({ discord, db, route });
  const press = (body) => interactions.handle({ userId: OWNER, channelId: CHANNEL, ...body });

  assert.equal((await interactions.handle({ userId: OTHER, channelId: CHANNEL, messageId: "600000000000000001", customId: id })).body.code, "not_owner");
  const outsider = setupBridge({ discord: fakeDiscord({ members: [] }), db, route });
  assert.equal((await outsider.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: id })).body.code, "not_member");
  const blind = setupBridge({ discord: fakeDiscord({ canView: [] }), db, route });
  assert.equal((await blind.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: id })).body.code, "not_owner");
  assert.equal((await press({ channelId: OTHER_CHANNEL, messageId: "600000000000000001", customId: id })).body.code, "channel_not_found");
  assert.equal((await press({ messageId: "600000000000000002", customId: id })).body.code, "not_bot_message");
  assert.equal((await press({ messageId: "600000000000000009", customId: id })).body.code, "message_not_found");
  assert.equal((await press({ messageId: "600000000000000001", customId: `manual_quote_cancel_${ORDER_ID}` })).body.code, "component_not_found");
  assert.equal((await press({ messageId: "600000000000000003", customId: id })).body.code, "component_disabled");
  const select = `self_customer_numbers_${ORDER_ID}`;
  assert.equal((await press({ messageId: "600000000000000004", customId: select, values: ["3"] })).body.code, "invalid_values");
  assert.equal((await press({ messageId: "600000000000000004", customId: select, values: ["1", "2"] })).body.code, "invalid_values");
  assert.equal((await press({ messageId: "600000000000000004", customId: select, values: [] })).body.code, "invalid_values");
  // A select pressed as a button (no values) is refused too.
  assert.equal((await press({ messageId: "600000000000000004", customId: select })).body.code, "not_allowed");
  assert.equal(routed, 0);

  // Ownership by the channel topic (owner:<id>) also counts.
  const topicDiscord = fakeDiscord({ topic: `owner:${OWNER};proxy:x` });
  topicDiscord.makeMessage("600000000000000001", { components: [row(button(id))] });
  const byTopic = setupBridge({ discord: topicDiscord, db: fakeDb(), route });
  assert.equal((await byTopic.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: id })).status, 200);
  assert.equal(routed, 1);
}));

// ---------- 4. fake interaction capture + ephemeral tokens ----------
test("fake interaction: ephemeral reply with components gets a token; only that user, only those components", () => quiet(async () => {
  const discord = fakeDiscord({ canView: [OWNER, OTHER] });
  discord.makeMessage("600000000000000001", { components: [row(button(`quote_use_coupon_${ORDER_ID}`))] });
  const seen = [];
  const route = async (interaction) => {
    seen.push(interaction);
    if (interaction.customId.startsWith("quote_use_coupon_")) {
      await interaction.deferReply({ flags: 64 });
      return interaction.editReply({
        content: "🎟️ 請選擇要使用的優惠券：",
        components: [row(new StringSelectMenuBuilder().setCustomId(`quote_select_coupon_${ORDER_ID}`).addOptions({ label: "9折券", value: "7" }))],
      });
    }
    if (interaction.customId.startsWith("quote_select_coupon_")) {
      return interaction.update({ content: `已選 ${interaction.values[0]}`, components: [] });
    }
  };
  const db = fakeDb({ play_orders: [{ id: "a", channel_id: CHANNEL, customer_id: OWNER }, { id: "b", channel_id: CHANNEL, customer_id: OTHER }] });
  const interactions = setupBridge({ discord, db, route });
  const first = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `quote_use_coupon_${ORDER_ID}` });
  assert.equal(first.status, 200);
  assert.equal(seen[0].user.id, OWNER);
  assert.equal(seen[0].member.id, OWNER);
  assert.equal(seen[0].isButton(), true);
  assert.equal(seen[0].message.id, "600000000000000001");
  assert.equal(first.body.replies.length, 1);
  const [reply] = first.body.replies;
  assert.match(reply.content, /優惠券/);
  assert.equal(reply.components[0].components[0].custom_id, `quote_select_coupon_${ORDER_ID}`);
  assert.equal(discord.sent.length, 0, "ephemeral reply never posted to the channel");

  // Another customer of the same channel cannot use the token; a forged value or component is refused.
  const stolen = await interactions.handle({ userId: OTHER, channelId: CHANNEL, replyToken: reply.token, customId: `quote_select_coupon_${ORDER_ID}`, values: ["7"] });
  assert.equal(stolen.body.code, "token_expired");
  const forgedValue = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `quote_select_coupon_${ORDER_ID}`, values: ["8"] });
  assert.equal(forgedValue.body.code, "invalid_values");
  const forgedButton = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `self_service_pay_wallet_${ORDER_ID}` });
  assert.equal(forgedButton.body.code, "component_not_found");

  const second = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `quote_select_coupon_${ORDER_ID}`, values: ["7"] });
  assert.equal(second.status, 200);
  assert.equal(seen.at(-1).message.flags.has(64), true, "handler sees an ephemeral message");
  assert.deepEqual(seen.at(-1).values, ["7"]);
  assert.equal(second.body.sourceReplyToken, reply.token);
  assert.equal(second.body.replies[0].token, reply.token);
  assert.equal(second.body.replies[0].content, "已選 7");
  assert.deepEqual(second.body.replies[0].components, []);
  // The select is gone from the updated reply, so it cannot be pressed again.
  const again = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `quote_select_coupon_${ORDER_ID}`, values: ["7"] });
  assert.equal(again.body.code, "component_not_found");
}));

test("ephemeral tokens expire", () => quiet(async () => {
  let clock = 1_000_000;
  const discord = fakeDiscord();
  discord.makeMessage("600000000000000001", { components: [row(button(`quote_use_coupon_${ORDER_ID}`))] });
  const route = async (interaction) => interaction.reply({ flags: 64, content: "x", components: [row(button(`quote_no_coupon_${ORDER_ID}`))] });
  const interactions = setupBridge({ discord, db: ownerDb(), route, tokenTtlMs: 1000, now: () => clock });
  const first = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `quote_use_coupon_${ORDER_ID}` });
  clock += 1001;
  const late = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: first.body.replies[0].token, customId: `quote_no_coupon_${ORDER_ID}` });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "token_expired");
}));

test("fake interaction: public reply/update/followUp go to Discord; showModal returns the form; modal submit carries fields", () => quiet(async () => {
  const discord = fakeDiscord();
  discord.makeMessage("600000000000000001", { components: [row(button(`order_review_5_${ORDER_ID}_public`), button(`new_order_note_no_${ORDER_ID}`))] });
  const seen = [];
  const route = async (interaction) => {
    seen.push(interaction);
    if (interaction.customId.startsWith("order_review_")) {
      return interaction.showModal(new ModalBuilder().setCustomId(`submit_order_review_5_${ORDER_ID}_public`).setTitle("填寫訂單評價")
        .addComponents(row(new TextInputBuilder().setCustomId("comment").setLabel("想給這次服務什麼回饋？").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500))));
    }
    if (interaction.customId.startsWith("submit_order_review_")) {
      await interaction.reply({ content: `✅ 感謝評價：${interaction.fields.getTextInputValue("comment")}`, flags: 64 });
      await interaction.channel.send({ content: "💬 已收到訂單評價" });
      return;
    }
    if (interaction.customId.startsWith("new_order_note_no_")) {
      await interaction.update({ content: "已送出", components: [] });
      await interaction.followUp({ content: "公開通知" });
    }
  };
  const interactions = setupBridge({ discord, db: ownerDb(), route });
  const opened = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `order_review_5_${ORDER_ID}_public` });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.modal.title, "填寫訂單評價");
  assert.deepEqual(opened.body.modal.inputs, [{ id: "comment", label: "想給這次服務什麼回饋？", style: "paragraph", required: false, minLength: 0, maxLength: 500, placeholder: "", value: "" }]);

  const tooLong = await interactions.handle({ userId: OWNER, channelId: CHANNEL, modalToken: opened.body.modal.token, fields: { comment: "x".repeat(501) } });
  assert.equal(tooLong.body.code, "invalid_fields");
  const unknown = await interactions.handle({ userId: OWNER, channelId: CHANNEL, modalToken: opened.body.modal.token, fields: { price: "1" } });
  assert.equal(unknown.body.code, "invalid_fields");
  const other = await interactions.handle({ userId: OTHER, channelId: CHANNEL, modalToken: opened.body.modal.token, fields: { comment: "讚" } });
  assert.equal(other.body.code, "token_expired");

  const submitted = await interactions.handle({ userId: OWNER, channelId: CHANNEL, modalToken: opened.body.modal.token, fields: { comment: "很好玩" } });
  assert.equal(submitted.status, 200);
  const modalInteraction = seen.at(-1);
  assert.equal(modalInteraction.isModalSubmit(), true);
  assert.equal(modalInteraction.customId, `submit_order_review_5_${ORDER_ID}_public`, "customId comes from the issued modal, not the client");
  assert.equal(modalInteraction.message.id, "600000000000000001");
  assert.match(submitted.body.replies[0].content, /很好玩/);
  assert.ok(discord.sent.some((m) => m.content === "💬 已收到訂單評價"));
  // A modal token is single use.
  const reused = await interactions.handle({ userId: OWNER, channelId: CHANNEL, modalToken: opened.body.modal.token, fields: { comment: "再一次" } });
  assert.equal(reused.body.code, "token_expired");

  const updated = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `new_order_note_no_${ORDER_ID}` });
  assert.equal(updated.body.messageUpdated, true);
  assert.ok(discord.edits.some((e) => e.id === "600000000000000001" && e.payload.content === "已送出"));
  assert.ok(discord.sent.some((m) => m.content === "公開通知"));
  assert.equal(updated.body.replies.length, 0);
}));

test("a modal with a non-allowlisted custom id is not handed to the APP", () => quiet(async () => {
  const discord = fakeDiscord();
  discord.makeMessage("600000000000000001", { components: [row(button(`self_service_extend_${ORDER_ID}`))] });
  const route = async (interaction) => interaction.showModal(new ModalBuilder().setCustomId(`submit_staff_quote_price_${ORDER_ID}`).setTitle("x")
    .addComponents(row(new TextInputBuilder().setCustomId("price").setLabel("金額").setStyle(TextInputStyle.Short))));
  const interactions = setupBridge({ discord, db: ownerDb(), route });
  const r = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `self_service_extend_${ORDER_ID}` });
  assert.equal(r.body.modal, null);
  assert.equal(r.body.discordOnly, true);
}));

test("one press at a time per customer", () => quiet(async () => {
  const discord = fakeDiscord();
  discord.makeMessage("600000000000000001", { components: [row(button(`quote_no_coupon_${ORDER_ID}`))] });
  let release;
  const route = () => new Promise((resolve) => { release = resolve; });
  const interactions = setupBridge({ discord, db: ownerDb(), route });
  const body = { userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `quote_no_coupon_${ORDER_ID}` };
  const first = interactions.handle(body);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal((await interactions.handle(body)).body.code, "in_progress");
  release();
  assert.equal((await first).status, 200);
}));

// ---------- 5. real handlers through dispatchSystem ----------
function realSetup(rows, rpcs = {}) {
  const discord = fakeDiscord();
  const db = fakeDb(rows, rpcs);
  dispatchSystem.setup(db, discord.client, { ecpayAvailable: true, jkopayAvailable: true });
  const interactions = setupBridge({ discord, db, route: (interaction) => dispatchSystem.handleDispatchInteraction(interaction) });
  return { discord, db, interactions };
}

test("real handler: manual_quote_dispatch_ goes through confirmManualQuoteAndDispatch (owner, quoted, rollback on dispatch failure)", () => quiet(async () => {
  const order = { id: ORDER_ID, order_no: "QN-1", customer_id: OWNER, channel_id: CHANNEL, guild_id: GUILD, quote_status: "quoted", status: "quoted",
    paid: false, price: 1000, final_price: 1000, note: "[MANUAL_DISPATCH]", service: "特戰英豪", player_count: 1, service_flow_key: "website:WEB-1" };
  const { discord, db, interactions } = realSetup({ play_orders: [order] });
  discord.makeMessage("600000000000000001", { components: [row(button(`manual_quote_dispatch_${ORDER_ID}`, "確認報價並正式派單"), button(`manual_quote_cancel_${ORDER_ID}`, "取消"))] });
  const r = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `manual_quote_dispatch_${ORDER_ID}` });
  assert.equal(r.status, 200);
  // The fake Discord has no 派單 channel: the real handler flips to manual_dispatching, fails to dispatch and rolls back.
  assert.match(r.body.replies[0].content, /正式派單失敗/);
  assert.ok(db.calls.updates.some((u) => u.patch.quote_status === "manual_dispatching"));
  assert.equal(db.tables.play_orders[0].quote_status, "quoted");
  assert.equal(discord.sent.length, 0, "the failure is told only to the customer");

  // Already paid: the handler itself refuses.
  db.tables.play_orders[0].paid = true;
  const paid = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `manual_quote_dispatch_${ORDER_ID}` });
  assert.match(paid.body.replies[0].content, /已經付款/);
}));

test("real handler: self_customer_numbers_ select picks the companion and posts the confirm buttons", () => quiet(async () => {
  const P1 = "700000000000000001";
  const P2 = "700000000000000002";
  const order = { id: ORDER_ID, order_no: "QN-2", customer_id: OWNER, channel_id: CHANNEL, guild_id: GUILD, quote_status: "self_choosing_open", status: "pending",
    paid: false, price: 500, final_price: 500, preferred_player: `${P1},${P2}`, player_count: 1, service: "特戰英豪",
    note: `[SELF_SERVICE] [DISPATCH_AT:${new Date(Date.now() - 60_000).toISOString()}]` };
  const { discord, db, interactions } = realSetup({ play_orders: [order] });
  discord.makeMessage("600000000000000001", {
    components: [row(new StringSelectMenuBuilder().setCustomId(`self_customer_numbers_${ORDER_ID}`).setMinValues(1).setMaxValues(1)
      .addOptions({ label: "1 號", value: "1" }, { label: "2 號", value: "2" }))],
  });
  const r = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `self_customer_numbers_${ORDER_ID}`, values: ["2"] });
  assert.equal(r.status, 200);
  assert.match(r.body.replies[0].content, /已依數字找到對應陪陪/);
  assert.equal(db.tables.play_orders[0].preferred_player, P2);
  assert.equal(db.tables.play_orders[0].quote_status, "confirming_players");
  const confirm = discord.sent.find((m) => /你選擇的編號：2/.test(m.content || ""));
  assert.ok(confirm, "public confirm message posted");
  const ids = confirm.components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, [`self_players_confirm_${ORDER_ID}`, `self_players_reselect_${ORDER_ID}`, `self_service_cancel_refund_${ORDER_ID}`]);
  assert.ok(discord.edits.some((e) => e.id === "600000000000000001" && Array.isArray(e.payload.components) && e.payload.components.length === 0), "number menu removed");
}));

test("real handler: 自助付款方式 (self_service_prepare_) → confirm screen in-app; only the shown 確認 button is pressable", () => quiet(async () => {
  const order = { id: ORDER_ID, order_no: "QN-3", customer_id: OWNER, channel_id: CHANNEL, guild_id: GUILD, quote_status: "waiting_payment", status: "pending",
    paid: false, price: 800, final_price: 800, preferred_player: "700000000000000001", player_count: 1, note: "[SELF_SERVICE]", service: "特戰英豪" };
  const { discord, interactions } = realSetup({ play_orders: [order, { id: "older", channel_id: CHANNEL, customer_id: OWNER }] });
  const methods = ["jkopay", "card", "atm", "barcode", "cvs", "wallet"];
  discord.makeMessage("600000000000000001", { components: [row(...methods.slice(0, 3).map((m) => button(`self_service_prepare_${m}_${ORDER_ID}`, m))), row(...methods.slice(3).map((m) => button(`self_service_prepare_${m}_${ORDER_ID}`, m)))] });
  const r = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `self_service_prepare_card_${ORDER_ID}` });
  assert.equal(r.status, 200);
  const [reply] = r.body.replies;
  assert.match(reply.content, /請確認使用「線上刷卡」付款/);
  const ids = reply.components[0].components.map((c) => c.custom_id);
  assert.deepEqual(ids, [`self_service_pay_ecpay_card_${ORDER_ID}`, `self_service_payment_back_${ORDER_ID}`, `self_service_cancel_order_${ORDER_ID}`]);
  assert.equal(discord.sent.length, 0);
  // A forged 錢包扣款 confirm (never shown for this choice) cannot be pressed through the token.
  const forged = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `self_service_pay_wallet_${ORDER_ID}` });
  assert.equal(forged.body.code, "component_not_found");
  // 返回付款方式 (deferUpdate + editReply) rewrites the same in-app reply.
  const back = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: reply.token, customId: `self_service_payment_back_${ORDER_ID}` });
  assert.equal(back.status, 200);
  assert.equal(back.body.replies[0].token, reply.token);
  assert.match(back.body.replies[0].content, /已返回付款方式/);
  assert.deepEqual(back.body.replies[0].components, []);
  // Someone else's order: the handler refuses even though the button is on the message.
  order.customer_id = OTHER;
  const notMine = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `self_service_prepare_wallet_${ORDER_ID}` });
  assert.match(notMine.body.replies[0].content, /找不到你的自助訂單/);
}));

test("real handler: 優惠券 quote_use_coupon_ → in-app select → quote_select_coupon_ applies via RPC → general payment buttons → review", () => quiet(async () => {
  const order = { id: ORDER_ID, order_no: "QN-4", customer_id: OWNER, channel_id: CHANNEL, guild_id: GUILD, quote_status: "price_confirmed", status: "pending",
    paid: false, price: 700, final_price: 700, original_price: null, note: "", service: "特戰英豪", player_count: 1 };
  const coupon = { id: 7, user_id: OWNER, item_type: "coupon", item_name: "9折優惠券", description: "測試" };
  const { discord, db, interactions } = realSetup({ play_orders: [order], user_items: [coupon] }, {
    qiunai_apply_quote_coupon: (args) => ({ data: { ...order, final_price: 630, discount_amount: 70, original_price: 700, coupon_item_id: args.p_item_id }, error: null }),
    qiunai_reserve_vip_points: (args) => ({ data: { points: 0, amount_due: args.p_coupon_amount, checkout_key: null }, error: null }),
  });
  discord.makeMessage("600000000000000001", { components: [row(button(`quote_use_coupon_${ORDER_ID}`, "使用優惠券"), button(`quote_no_coupon_${ORDER_ID}`, "不使用優惠券"))] });
  const list = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: "600000000000000001", customId: `quote_use_coupon_${ORDER_ID}` });
  assert.equal(list.status, 200);
  const [picker] = list.body.replies;
  assert.match(picker.content, /請選擇要使用的優惠券/);
  const select = picker.components[0].components[0];
  assert.equal(select.custom_id, `quote_select_coupon_${ORDER_ID}`);
  assert.deepEqual(select.options.map((o) => o.value), ["7"]);

  const applied = await interactions.handle({ userId: OWNER, channelId: CHANNEL, replyToken: picker.token, customId: `quote_select_coupon_${ORDER_ID}`, values: ["7"] });
  assert.equal(applied.status, 200);
  assert.ok(applied.body.replies.some((reply) => /優惠券已套用/.test(reply.content)));
  const rpc = db.calls.rpc.find((c) => c.name === "qiunai_apply_quote_coupon");
  assert.equal(rpc.args.p_user_id, OWNER);
  assert.equal(rpc.args.p_item_id, 7);
  const pay = discord.sent.find((m) => /請選擇付款方式/.test(m.content || ""));
  assert.ok(pay, "payment buttons posted to the order channel");

  // Press a general payment method on that real message: review screen first (no charge).
  const payMessage = [...discord.messages.values()].find((m) => /請選擇付款方式/.test(m.content));
  const payIds = payMessage.components.flatMap((r) => r.toJSON().components).filter((c) => !c.disabled).map((c) => c.custom_id);
  const walletId = payIds.find((id) => id.startsWith(`quote_payment_method_${ORDER_ID}`));
  assert.ok(walletId);
  const review = await interactions.handle({ userId: OWNER, channelId: CHANNEL, messageId: payMessage.id, customId: walletId });
  assert.equal(review.status, 200);
  assert.match(review.body.replies[0].content, /確認使用「.+」？/);
  const reviewIds = review.body.replies[0].components[0].components.map((c) => c.custom_id);
  assert.deepEqual(reviewIds, [walletId.replace(/__review$/, ""), "payment_review_back"]);
  assert.equal(db.tables.play_orders[0].paid, false, "nothing charged by the review step");
}));

test("index.js routes Discord events and APP presses through the same handleInteractionEvent", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /async function handleInteractionEvent\(interaction\) \{\n  if \(!handledInteractionIds\.add\(interaction\.id\)\)/);
  assert.match(source, /client\.on\(Events\.InteractionCreate, handleInteractionEvent\);/);
  assert.match(source, /createAppInteractions\(\{getClient:\(\)=>client,db:supabase,guildId:process\.env\.GUILD_ID,route:handleInteractionEvent\}\)/);
});
