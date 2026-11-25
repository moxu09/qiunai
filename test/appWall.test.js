const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const { createAppWall, APPROVE_PREFIX, REJECT_PREFIX } = require("../utils/appWall");

const TOKEN = "test-bot-token";
const OWNER = "847840193859682304";
const OTHER = "223456789012345678";
const AUTHOR = "123456789012345678";
const STRANGER = "323456789012345678";
const POST = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

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

const postRow = (extra = {}) => ({
  id: POST, brand: "qiunai", user_id: AUTHOR, display_name: "小星", anonymous: false,
  body: "陪陪超可愛 💜", status: "pending", created_at: "2026-11-26T00:00:00Z", reviewed_by: null, reviewed_at: null, ...extra,
});

function fakeDb({ posts = [], updateError = null, loadError = null } = {}) {
  const updates = [];
  return {
    posts, updates,
    from(table) {
      assert.equal(table, "app_wall_posts");
      const filters = [];
      let patch = null;
      const matching = () => posts.filter(row => filters.every(([key, value]) => String(row[key]) === String(value)));
      const query = {
        select() {
          if (!patch) return query;
          if (updateError) return Promise.resolve({ data: null, error: updateError });
          const rows = matching();
          for (const row of rows) Object.assign(row, patch);
          updates.push({ patch, filters: [...filters], count: rows.length });
          return Promise.resolve({ data: rows.map(row => ({ ...row })), error: null });
        },
        update(value) { patch = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        async maybeSingle() {
          if (loadError) return { data: null, error: loadError };
          return { data: matching()[0] || null, error: null };
        },
      };
      return query;
    },
  };
}

function fakeClient({ failIds = [] } = {}) {
  const sent = [];
  const edited = [];
  let next = 1000;
  return {
    sent, edited,
    users: {
      async fetch(id) {
        return {
          id,
          async send(payload) {
            if (failIds.includes(id)) { const error = new Error("Cannot send"); error.code = 50007; throw error; }
            next += 1;
            const message = { id: `90000000000000${next}`, channelId: `80000000000000${next}` };
            sent.push({ id, payload, message });
            return message;
          },
        };
      },
    },
    rest: { async patch(route, { body }) { edited.push({ route, body }); } },
  };
}

const json = item => (typeof item?.toJSON === "function" ? item.toJSON() : item);
const embedOf = payload => json(payload.embeds[0]);
const field = (embed, name) => embed.fields.find(item => item.name === name)?.value;

function fakeButton({ customId, userId = OWNER, messageId = "900000000000001001" }) {
  const calls = { replies: [], deferred: 0, edits: [], followUps: [] };
  return {
    calls, customId,
    user: { id: userId },
    message: { id: messageId },
    isButton: () => true,
    isModalSubmit: () => false,
    async reply(payload) { calls.replies.push(payload); },
    async deferUpdate() { calls.deferred += 1; },
    async editReply(payload) { calls.edits.push(payload); },
    async followUp(payload) { calls.followUps.push(payload); },
  };
}

function quiet(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(run).finally(() => Object.assign(console, original));
}

test("notify route: unsigned 401, unknown post 404, bad uuid 400, missing service 503", async () => {
  const wall = createAppWall({ db: fakeDb({ posts: [postRow()] }), client: fakeClient() });
  const bridge = createAppBridge({ token: TOKEN, wall });
  assert.equal((await call(bridge, "POST", "/app/wall/notify", { postId: POST }, { signed: false })).status, 401);
  const unknown = await call(bridge, "POST", "/app/wall/notify", { postId: UNKNOWN });
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /[一-鿿]/);
  const bad = await call(bridge, "POST", "/app/wall/notify", { postId: "not-a-uuid" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /[一-鿿]/);
  assert.equal((await call(bridge, "GET", "/app/wall/notify", undefined)).status, 405);
  const none = await call(createAppBridge({ token: TOKEN }), "POST", "/app/wall/notify", { postId: POST });
  assert.equal(none.status, 503);
  assert.match(none.json.error, /[一-鿿]/);
});

test("notify DMs every recipient: escaped body, brand, nickname, real author, buttons, no mentions", async () => {
  const client = fakeClient();
  const body = "[點我](https://evil.example) **粗體** @everyone";
  const wall = createAppWall({ db: fakeDb({ posts: [postRow({ body, display_name: "*星*" })] }), client, recipientIds: `${OWNER},${OTHER}` });
  const result = await call(createAppBridge({ token: TOKEN, wall }), "POST", "/app/wall/notify", { postId: POST });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, sent: 2 });
  assert.deepEqual(client.sent.map(item => item.id), [OWNER, OTHER]);
  const payload = client.sent[0].payload;
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const embed = embedOf(payload);
  assert.equal(embed.title, "📝 APP 留言牆待審核");
  assert.equal(field(embed, "店別"), "秋奈");
  assert.equal(field(embed, "顯示"), "\\*星\\*");
  assert.equal(field(embed, "作者"), `<@${AUTHOR}>`);
  const text = field(embed, "留言");
  assert.ok(text.startsWith("\\[點我]"));
  assert.ok(text.includes("\\*\\*粗體\\*\\*"));
  const [row] = payload.components.map(json);
  assert.deepEqual(row.components.map(item => [item.custom_id, item.label]),
    [[`${APPROVE_PREFIX}${POST}`, "通過"], [`${REJECT_PREFIX}${POST}`, "不通過"]]);
});

test("anonymous post on 深夜 shows 匿名老闆 but still names the real author for moderation", async () => {
  const client = fakeClient();
  const wall = createAppWall({ db: fakeDb({ posts: [postRow({ brand: "deepnight", anonymous: true })] }), client });
  assert.equal((await wall.notify({ postId: POST })).status, 200);
  const embed = embedOf(client.sent[0].payload);
  assert.equal(field(embed, "店別"), "深夜不關燈");
  assert.equal(field(embed, "顯示"), "匿名老闆");
  assert.equal(field(embed, "作者"), `<@${AUTHOR}>`);
  assert.ok(!JSON.stringify(embed).includes("小星"));
});

test("Discord failure for every recipient is 503 in Chinese; load failure is 503", async () => {
  const wall = createAppWall({ db: fakeDb({ posts: [postRow()] }), client: fakeClient({ failIds: [OWNER] }) });
  const result = await quiet(() => wall.notify({ postId: POST }));
  assert.equal(result.status, 503);
  assert.match(result.body.error, /[一-鿿]/);
  const broken = createAppWall({ db: fakeDb({ loadError: { code: "x" } }), client: fakeClient() });
  const loadResult = await quiet(() => broken.notify({ postId: POST }));
  assert.equal(loadResult.status, 503);
  assert.match(loadResult.body.error, /[一-鿿]/);
});

test("already reviewed post is not DMed again", async () => {
  const client = fakeClient();
  const wall = createAppWall({ db: fakeDb({ posts: [postRow({ status: "approved" })] }), client });
  const result = await wall.notify({ postId: POST });
  assert.deepEqual(result, { status: 200, body: { ok: true, sent: 0 } });
  assert.equal(client.sent.length, 0);
});

test("non-allowlisted press is refused and nothing changes", async () => {
  const db = fakeDb({ posts: [postRow()] });
  const wall = createAppWall({ db, client: fakeClient() });
  const interaction = fakeButton({ customId: `${APPROVE_PREFIX}${POST}`, userId: STRANGER });
  assert.equal(await wall.handleInteraction(interaction), true);
  assert.equal(interaction.calls.replies[0].content, "你沒有權限審核");
  assert.equal(interaction.calls.replies[0].flags, 64);
  assert.equal(db.updates.length, 0);
  assert.equal(db.posts[0].status, "pending");
});

test("approve sets status once, edits every recipient's DM copy and removes the buttons", async () => {
  const db = fakeDb({ posts: [postRow()] });
  const client = fakeClient();
  const wall = createAppWall({ db, client, recipientIds: `${OWNER},${OTHER}` });
  await wall.notify({ postId: POST });
  const [mine, theirs] = client.sent.map(item => item.message);
  const interaction = fakeButton({ customId: `${APPROVE_PREFIX}${POST}`, messageId: mine.id });
  assert.equal(await wall.handleInteraction(interaction), true);
  assert.equal(db.posts[0].status, "approved");
  assert.equal(db.posts[0].reviewed_by, OWNER);
  assert.ok(!Number.isNaN(Date.parse(db.posts[0].reviewed_at)));
  assert.deepEqual(db.updates[0].filters, [["id", POST], ["status", "pending"]]);
  assert.equal(interaction.calls.deferred, 1);
  const edit = interaction.calls.edits[0];
  assert.deepEqual(edit.components, []);
  assert.deepEqual(edit.allowedMentions, { parse: [] });
  assert.match(field(embedOf(edit), "審核結果"), /已通過/);
  // The other recipient's copy is edited too; the pressed one is not double-edited.
  assert.equal(client.edited.length, 1);
  assert.ok(client.edited[0].route.includes(theirs.channelId) && client.edited[0].route.includes(theirs.id));
  assert.deepEqual(client.edited[0].body.components, []);
});

test("reject, then a second press says 這則已經審核過了 and keeps the first result", async () => {
  const db = fakeDb({ posts: [postRow()] });
  const wall = createAppWall({ db, client: fakeClient(), recipientIds: `${OWNER},${OTHER}` });
  const first = fakeButton({ customId: `${REJECT_PREFIX}${POST}` });
  await wall.handleInteraction(first);
  assert.equal(db.posts[0].status, "rejected");
  assert.match(field(embedOf(first.calls.edits[0]), "審核結果"), /不通過/);
  const second = fakeButton({ customId: `${APPROVE_PREFIX}${POST}`, userId: OTHER });
  await wall.handleInteraction(second);
  assert.equal(db.posts[0].status, "rejected");
  assert.equal(db.posts[0].reviewed_by, OWNER);
  assert.equal(second.calls.followUps[0].content, "這則已經審核過了");
  assert.equal(second.calls.followUps[0].flags, 64);
  // Its stale buttons are removed and it shows the real (first) result.
  assert.deepEqual(second.calls.edits[0].components, []);
  assert.match(field(embedOf(second.calls.edits[0]), "審核結果"), /不通過/);
});

test("bad uuid press is refused; update failure answers in Chinese; unrelated customIds are ignored", async () => {
  const db = fakeDb({ posts: [postRow()] });
  const wall = createAppWall({ db, client: fakeClient() });
  const bad = fakeButton({ customId: `${APPROVE_PREFIX}not-a-uuid` });
  assert.equal(await wall.handleInteraction(bad), true);
  assert.match(bad.calls.replies[0].content, /[一-鿿]/);
  assert.equal(db.updates.length, 0);
  for (const customId of ["app_claim_reply_x", "app_wall_approve_", "app_wall_approve_a b", "other"]) {
    assert.equal(await wall.handleInteraction(fakeButton({ customId })), false);
  }
  assert.equal(await wall.handleInteraction({ customId: `${APPROVE_PREFIX}${POST}`, isButton: () => false }), false);
  const failing = createAppWall({ db: fakeDb({ posts: [postRow()], updateError: { code: "x" } }), client: fakeClient() });
  const interaction = fakeButton({ customId: `${APPROVE_PREFIX}${POST}` });
  await quiet(() => failing.handleInteraction(interaction));
  assert.match(interaction.calls.followUps[0].content, /[一-鿿]/);
});
