const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const { createAppPrizeClaims, parseRecipientIds, DEFAULT_RECIPIENT_ID } = require("../utils/appPrizeClaims");

const TOKEN = "test-bot-token";
const OWNER = "847840193859682304";
const OTHER = "223456789012345678";
const CUSTOMER = "123456789012345678";
const CLAIM = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";
const MESSAGE = "9a14e45f-ceea-4b67-8a2c-4f1b2a3c4d5f";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const CONTACT = { name: "王小明", phone: "0912345678", address: "台北市信義區松仁路 100 號", email: "ming@example.com" };

function sign(method, url, body, time = String(Date.now()), token = TOKEN) {
  const signature = createHmac("sha256", token)
    .update(`qiunai-website-v1\n${time}\n${method}\n${url}\n${body}`)
    .digest("hex");
  return { "x-website-time": time, "x-website-signature": signature };
}

async function call(bridge, method, url, data, { signed = true } = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  const request = {
    method, url, headers: signed ? sign(method, url, body) : {},
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); },
  };
  const response = {
    status: null, text: "",
    writeHead(status) { this.status = status; },
    end(text) { this.text = text || ""; },
    get json() { return JSON.parse(this.text); },
  };
  await bridge.handleHttpRequest(request, response);
  return response;
}

function fakeDb({ claims = [], messages = [], insertError = null } = {}) {
  const inserted = [];
  const db = {
    inserted,
    from(table) {
      const filters = [];
      const rows = () => (table === "app_prize_claims" ? claims : messages)
        .filter(row => filters.every(([key, value]) => String(row[key]) === String(value)));
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        async maybeSingle() { return { data: rows()[0] || null, error: null }; },
        async insert(row) {
          if (insertError) return { error: insertError };
          inserted.push({ table, row });
          return { error: null };
        },
      };
      return query;
    },
  };
  return db;
}

function fakeClient({ failIds = [] } = {}) {
  const sent = [];
  return {
    sent,
    users: {
      async fetch(id) {
        return {
          id,
          async send(payload) {
            if (failIds.includes(id)) { const error = new Error("Cannot send messages to this user"); error.code = 50007; throw error; }
            sent.push({ id, payload });
          },
        };
      },
    },
  };
}

const claimRow = (extra = {}) => ({
  id: CLAIM, user_id: CUSTOMER, guild_id: "1206138511535898654", source_type: "ichiban", source_id: "42",
  prize_name: "S賞 限定公仔", contact: CONTACT, status: "pending", created_at: "2026-11-25T00:00:00Z", ...extra,
});

const embedOf = payload => {
  const embed = payload.embeds[0];
  return typeof embed.toJSON === "function" ? embed.toJSON() : embed;
};
const componentsOf = payload => payload.components.map(row => (typeof row.toJSON === "function" ? row.toJSON() : row));

function captureConsole(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const key of Object.keys(original)) console[key] = (...args) => lines.push(args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  return Promise.resolve().then(run).finally(() => Object.assign(console, original)).then(result => ({ result, lines }));
}

test("recipients come from env with the owner as default", () => {
  assert.equal(DEFAULT_RECIPIENT_ID, OWNER);
  assert.deepEqual(parseRecipientIds(undefined), [OWNER]);
  assert.deepEqual(parseRecipientIds(""), [OWNER]);
  assert.deepEqual(parseRecipientIds(`${OWNER}, ${OTHER} ,bad`), [OWNER, OTHER]);
  assert.deepEqual(parseRecipientIds(`${OTHER},${OTHER}`), [OTHER]);
});

test("notify route: unsigned 401, unknown claim 404, bad uuid 400, missing service 503", async () => {
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()] }), client: fakeClient() });
  const bridge = createAppBridge({ token: TOKEN, prizeClaims });
  const unsigned = await call(bridge, "POST", "/app/prize-claims/notify", { claimId: CLAIM }, { signed: false });
  assert.equal(unsigned.status, 401);
  const unknown = await call(bridge, "POST", "/app/prize-claims/notify", { claimId: UNKNOWN });
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /[一-鿿]/);
  const bad = await call(bridge, "POST", "/app/prize-claims/notify", { claimId: "not-a-uuid" });
  assert.equal(bad.status, 400);
  const badMessage = await call(bridge, "POST", "/app/prize-claims/notify", { claimId: CLAIM, messageId: "x" });
  assert.equal(badMessage.status, 400);
  const get = await call(bridge, "GET", "/app/prize-claims/notify", undefined);
  assert.equal(get.status, 405);
  const none = await call(createAppBridge({ token: TOKEN }), "POST", "/app/prize-claims/notify", { claimId: CLAIM });
  assert.equal(none.status, 503);
  assert.match(none.json.error, /[一-鿿]/);
});

test("new claim DMs every recipient with full contact summary and reply button; no contact data logged", async () => {
  const client = fakeClient();
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()] }), client, recipientIds: `${OWNER},${OTHER}` });
  const bridge = createAppBridge({ token: TOKEN, prizeClaims });
  const { result, lines } = await captureConsole(() => call(bridge, "POST", "/app/prize-claims/notify", { claimId: CLAIM }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, sent: 2 });
  assert.deepEqual(client.sent.map(item => item.id), [OWNER, OTHER]);
  const embed = embedOf(client.sent[0].payload);
  assert.equal(embed.title, "📦 APP 領獎申請");
  const field = name => embed.fields.find(item => item.name === name)?.value;
  assert.equal(field("獎品"), "S賞 限定公仔");
  assert.equal(field("來源"), "一番賞");
  assert.equal(field("申請人"), `<@${CUSTOMER}>`);
  const summary = field("收件資料摘要");
  assert.match(summary, /王小明/);
  // Owner decision 2026-11-25: full phone number in the DM (logs still never get it).
  assert.match(summary, /0912345678/);
  assert.match(summary, /台北市信義區松仁路 100 號/);
  assert.match(summary, /ming@example\.com/);
  const [row] = componentsOf(client.sent[0].payload);
  assert.equal(row.components[0].custom_id, `app_claim_reply_${CLAIM}`);
  assert.equal(row.components[0].label, "回覆");
  const logged = lines.join("\n");
  for (const secret of ["王小明", "0912345678", "松仁路", "ming@example.com"]) assert.ok(!logged.includes(secret));
});

test("gacha claim with store shows 扭蛋 and the store", async () => {
  const client = fakeClient();
  const contact = { name: "林", phone: "0987654321", store: "7-11 信義門市" };
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow({ source_type: "gacha", contact })] }), client });
  const result = await prizeClaims.notify({ claimId: CLAIM });
  assert.equal(result.status, 200);
  const embed = embedOf(client.sent[0].payload);
  assert.equal(embed.fields.find(item => item.name === "來源").value, "扭蛋");
  assert.match(embed.fields.find(item => item.name === "收件資料摘要").value, /7-11 信義門市/);
  assert.deepEqual(client.sent.map(item => item.id), [OWNER]);
});

test("customer reply DM includes the reply text; unknown or staff message is 404", async () => {
  const client = fakeClient();
  const messages = [
    { id: MESSAGE, claim_id: CLAIM, sender: "customer", staff_id: null, body: "請問什麼時候寄出？", created_at: "2026-11-25T01:00:00Z" },
    { id: UNKNOWN, claim_id: CLAIM, sender: "staff", staff_id: OWNER, body: "明天", created_at: "2026-11-25T02:00:00Z" },
  ];
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()], messages }), client });
  const ok = await prizeClaims.notify({ claimId: CLAIM, messageId: MESSAGE });
  assert.equal(ok.status, 200);
  const embed = embedOf(client.sent[0].payload);
  assert.equal(embed.title, "💬 領獎申請新回覆");
  assert.ok(embed.fields.some(item => item.value === "請問什麼時候寄出？"));
  assert.equal(componentsOf(client.sent[0].payload)[0].components[0].custom_id, `app_claim_reply_${CLAIM}`);
  const staffMessage = await prizeClaims.notify({ claimId: CLAIM, messageId: UNKNOWN });
  assert.equal(staffMessage.status, 404);
});

test("Discord failure for all recipients is 503 in Chinese; partial success counts sent", async () => {
  const allFail = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()] }), client: fakeClient({ failIds: [OWNER] }) });
  const { result, lines } = await captureConsole(() => allFail.notify({ claimId: CLAIM }));
  assert.equal(result.status, 503);
  assert.match(result.body.error, /[一-鿿]/);
  assert.ok(!lines.join("\n").includes("王小明"));
  const partial = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()] }), client: fakeClient({ failIds: [OTHER] }), recipientIds: `${OWNER},${OTHER}` });
  const { result: partialResult } = await captureConsole(() => partial.notify({ claimId: CLAIM }));
  assert.deepEqual(partialResult, { status: 200, body: { ok: true, sent: 1 } });
});

function fakeInteraction({ kind, customId, userId = OWNER, body = "" }) {
  const calls = { replies: [], modals: [], edits: [], deferred: null };
  return {
    calls,
    id: "999",
    customId,
    user: { id: userId },
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isStringSelectMenu: () => false,
    fields: { getTextInputValue: key => (key === "body" ? body : "") },
    async reply(payload) { calls.replies.push(payload); },
    async showModal(modal) { calls.modals.push(typeof modal.toJSON === "function" ? modal.toJSON() : modal); },
    async deferReply(payload) { calls.deferred = payload; },
    async editReply(payload) { calls.edits.push(payload); },
  };
}

const text = payload => (typeof payload === "string" ? payload : payload.content);

test("handleInteraction ignores unrelated customIds", async () => {
  const prizeClaims = createAppPrizeClaims({ db: fakeDb(), client: fakeClient() });
  for (const customId of ["tip_quantity_modal_1", "prize_redeem:page:1", "app_claim_other", `app_claim_reply_${CLAIM}:x`]) {
    assert.equal(await prizeClaims.handleInteraction(fakeInteraction({ kind: "button", customId })), false);
    assert.equal(await prizeClaims.handleInteraction(fakeInteraction({ kind: "modal", customId })), false);
  }
  assert.equal(await prizeClaims.handleInteraction({ isButton: () => false, isModalSubmit: () => false, customId: `app_claim_reply_${CLAIM}` }), false);
});

test("button: unauthorized user refused, recipient gets the reply modal, bad uuid rejected", async () => {
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()] }), client: fakeClient() });
  const stranger = fakeInteraction({ kind: "button", customId: `app_claim_reply_${CLAIM}`, userId: OTHER });
  assert.equal(await prizeClaims.handleInteraction(stranger), true);
  assert.equal(text(stranger.calls.replies[0]), "你沒有權限回覆這張申請");
  assert.equal(stranger.calls.replies[0].flags, 64);
  assert.equal(stranger.calls.modals.length, 0);

  const owner = fakeInteraction({ kind: "button", customId: `app_claim_reply_${CLAIM}` });
  assert.equal(await prizeClaims.handleInteraction(owner), true);
  const modal = owner.calls.modals[0];
  assert.equal(modal.custom_id, `app_claim_reply_modal_${CLAIM}`);
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, "body");
  assert.equal(input.style, 2);
  assert.equal(input.max_length, 1000);
  assert.equal(input.required, true);

  const bad = fakeInteraction({ kind: "button", customId: "app_claim_reply_not-a-uuid" });
  assert.equal(await prizeClaims.handleInteraction(bad), true);
  assert.equal(bad.calls.modals.length, 0);
  assert.match(text(bad.calls.replies[0]), /[一-鿿]/);
});

test("modal submit inserts a staff message and confirms; unauthorized, bad uuid, blank and unknown claim refused", async () => {
  const db = fakeDb({ claims: [claimRow()] });
  const prizeClaims = createAppPrizeClaims({ db, client: fakeClient() });
  const submit = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: "  明天寄出，請留意簡訊  " });
  assert.equal(await prizeClaims.handleInteraction(submit), true);
  assert.deepEqual(db.inserted, [{ table: "app_prize_claim_messages", row: { claim_id: CLAIM, sender: "staff", staff_id: OWNER, body: "明天寄出，請留意簡訊" } }]);
  assert.equal(text(submit.calls.edits.at(-1) ?? submit.calls.replies.at(-1)), "已送出，客人會在 APP 看到");

  const stranger = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, userId: OTHER, body: "hi" });
  await prizeClaims.handleInteraction(stranger);
  assert.equal(text(stranger.calls.replies[0] ?? stranger.calls.edits[0]), "你沒有權限回覆這張申請");

  const bad = fakeInteraction({ kind: "modal", customId: "app_claim_reply_modal_123", body: "hi" });
  assert.equal(await prizeClaims.handleInteraction(bad), true);
  const blank = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: "   " });
  await prizeClaims.handleInteraction(blank);
  const tooLong = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: "字".repeat(1001) });
  await prizeClaims.handleInteraction(tooLong);
  const unknown = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${UNKNOWN}`, body: "hi" });
  await prizeClaims.handleInteraction(unknown);
  for (const interaction of [bad, blank, tooLong, unknown]) {
    const message = text(interaction.calls.edits.at(-1) ?? interaction.calls.replies.at(-1));
    assert.match(message, /[一-鿿]/);
    assert.notEqual(message, "已送出，客人會在 APP 看到");
  }
  assert.equal(db.inserted.length, 1);
});

test("modal submit DB failure answers in Chinese without claiming success", async () => {
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow()], insertError: { message: "boom" } }), client: fakeClient() });
  const submit = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: "hi" });
  await captureConsole(() => prizeClaims.handleInteraction(submit));
  const message = text(submit.calls.edits.at(-1) ?? submit.calls.replies.at(-1));
  assert.match(message, /[一-鿿]/);
  assert.notEqual(message, "已送出，客人會在 APP 看到");
});

test("index.js routes prize-claim interactions first and passes prizeClaims to the app bridge", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatch = source.indexOf("client.on(Events.InteractionCreate");
  const routed = source.indexOf("if (await appPrizeClaims.handleInteraction(interaction)) return;", dispatch);
  const complaint = source.indexOf("if (await complaintSystem.handleInteraction(interaction)) return;", dispatch);
  assert.ok(routed > dispatch && routed < complaint);
  assert.match(source, /createAppBridge\(\{[^]*?prizeClaims:appPrizeClaims/);
  assert.match(source, /APP_PRIZE_CLAIM_NOTIFY_USER_IDS/);
});

test("customer-supplied text in the DM is markdown-escaped (no fake masked links)", async () => {
  const client = fakeClient();
  const link = "[點我確認](https://evil.example/x)";
  const contact = { name: `**${link}**`, phone: "0912345678", address: link, email: "a_b_c@example.com" };
  const messages = [{ id: MESSAGE, claim_id: CLAIM, sender: "customer", staff_id: null, body: `請看 ${link}`, created_at: "2026-11-25T01:00:00Z" }];
  const prizeClaims = createAppPrizeClaims({ db: fakeDb({ claims: [claimRow({ prize_name: `~~${link}~~`, contact })], messages }), client });
  assert.equal((await prizeClaims.notify({ claimId: CLAIM, messageId: MESSAGE })).status, 200);
  const embed = embedOf(client.sent[0].payload);
  for (const name of ["獎品", "收件資料摘要", "客人回覆"]) {
    const value = embed.fields.find(item => item.name === name).value;
    assert.doesNotMatch(value, /(^|[^\\])\[點我確認\]\(/, name);
    assert.match(value, /\\\[點我確認\]/, name);
  }
  const summary = embed.fields.find(item => item.name === "收件資料摘要").value;
  assert.doesNotMatch(summary, /(^|[^\\])\*\*/);
  assert.match(summary, /0912345678/);
  assert.equal(embed.fields.find(item => item.name === "申請人").value, `<@${CUSTOMER}>`);
});

test("modal reply length counts code points: 1000 emoji are accepted, 1001 refused with the typed text kept", async () => {
  const db = fakeDb({ claims: [claimRow()] });
  const prizeClaims = createAppPrizeClaims({ db, client: fakeClient() });
  const ok = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: "😀".repeat(1000) });
  await prizeClaims.handleInteraction(ok);
  assert.equal(text(ok.calls.edits.at(-1) ?? ok.calls.replies.at(-1)), "已送出，客人會在 APP 看到");
  assert.equal(db.inserted.length, 1);
  const typed = `${"好".repeat(1000)}尾`;
  const tooLong = fakeInteraction({ kind: "modal", customId: `app_claim_reply_modal_${CLAIM}`, body: typed });
  await prizeClaims.handleInteraction(tooLong);
  const message = text(tooLong.calls.edits.at(-1) ?? tooLong.calls.replies.at(-1));
  assert.match(message, /1000/);
  assert.ok(message.includes(typed), "typed text must be returned so it is not lost");
  assert.ok(message.length <= 2000);
  assert.equal(db.inserted.length, 1);
});
