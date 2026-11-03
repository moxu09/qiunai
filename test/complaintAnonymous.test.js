const test = require("node:test");
const assert = require("node:assert/strict");
const { createComplaintSystem } = require("../events/complaintSystem");
const CEO = "847840193859682304", SENDER = "985810902991388722", MESSAGE = "1564609787516289177";
function fixture({ fail = false } = {}) {
  const rows = new Map(), calls = [], delivered = [], replies = [];
  const db = { from(table) {
    assert.equal(table, "bot_service_order_flows");
    const filters = {}; let payload;
    return {
      async insert(row) { if (fail) return { error: Error("DB offline") }; rows.set(row.flow_id, structuredClone(row)); return {}; },
      update(value) { payload = value.payload; return this; }, select() { return this; },
      eq(key, value) { filters[key] = value; calls.push([key, value]); return this; },
      async maybeSingle() {
        if (fail) return { error: Error("DB offline") };
        assert.equal(filters.organization_code, "qiunai:complaints");
        const row = rows.get(filters.flow_id);
        if (!row) return { data: null };
        if (payload) row.payload = structuredClone(payload);
        return { data: structuredClone(row) };
      },
    };
  } };
  let original;
  const client = { user: { id: "bot" }, users: { fetch: async id => {
    if (id === CEO) return { send: async payload => {
      original = { id: MESSAGE, channelId: "ceo-dm", author: { id: "bot" }, embeds: payload.embeds.map(e => e.toJSON()),
        edit: async value => { original.embeds = value.embeds.map(e => e.toJSON()); } };
      delivered.push(payload); return original;
    } };
    assert.equal(id, SENDER);
    return { createDM: async () => ({ messages: { fetch: async () => [] }, send: async value => replies.push(value) }) };
  } } };
  const system = createComplaintSystem(client, { ceoUserId: CEO }, db);
  const submit = { customId: "complaint_submit_anonymous_v2", user: { id: SENDER }, isButton: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: key => key === "complaint_subject" ? "匿名主旨" : "匿名內容" }, deferReply: async () => {},
    editReply: async value => { submit.result = value; }, reply: async value => { submit.result = value; } };
  function owner(kind = "button") {
    return { customId: kind === "button" ? "complaint_mark_handled" : `complaint_reply_${MESSAGE}`, user: { id: CEO }, guildId: null,
      channelId: "ceo-dm", message: original, channel: { messages: { fetch: async () => original } },
      isButton: () => kind === "button", isModalSubmit: () => kind === "modal", fields: { getTextInputValue: () => "已收到，會協助處理。" },
      showModal: async value => { calls.push(["modal", value.toJSON()]); }, deferReply: async () => {}, reply: async () => {}, editReply: async () => {},
    };
  }
  return { system, submit, owner, rows, calls, delivered, replies, client, db, get original() { return original; } };
}
test("新匿名投訴保存私下回覆路由，執行長訊息與按鈕不含帳號", async () => {
  const f = fixture(); await f.system.handleInteraction(f.submit);
  assert.equal(f.rows.size, 1); const row = [...f.rows.values()][0];
  assert.equal(row.payload.userId, SENDER); assert.equal(row.payload.messageId, MESSAGE); assert.equal(row.payload.ceoId, CEO);
  assert.equal(row.payload.channelId, "ceo-dm"); assert.equal(row.organization_code, "qiunai:complaints");
  assert(!JSON.stringify(f.delivered).includes(SENDER)); assert.match(f.submit.result.content, /保存帳號/);
  assert.match(f.original.embeds[0].footer.text, /^投訴編號：/);
});
test("匿名投訴重啟後仍可開表單，並回覆原帳號", async () => {
  const f = fixture(); await f.system.handleInteraction(f.submit);
  const restarted = createComplaintSystem(f.client, { ceoUserId: CEO }, f.db);
  await restarted.handleInteraction(f.owner()); assert(f.calls.some(c => c[0] === "modal"));
  await restarted.handleInteraction(f.owner("modal")); assert.equal(f.replies.length, 1);
  assert.match(f.original.embeds[0].fields.find(x => x.name === "處理狀態").value, /已私訊回覆/);
  assert(!JSON.stringify(f.original.embeds).includes(SENDER));
});
test("舊匿名表單必須重新開啟告知新規則，不保存帳號、不送訊息", async () => {
  const f = fixture(); f.submit.customId = "complaint_submit_anonymous";
  await f.system.handleInteraction(f.submit);
  assert.equal(f.rows.size, 0); assert.equal(f.delivered.length, 0); assert.match(f.submit.result.content, /重新點選/);
  f.submit.customId = "complaint_open_anonymous"; f.submit.isButton = () => true; f.submit.isModalSubmit = () => false;
  let modal; f.submit.showModal = async value => { modal = value.toJSON(); };
  await f.system.handleInteraction(f.submit); assert.equal(modal.custom_id, "complaint_submit_anonymous_v2");
  assert.match(modal.title, /留存帳號/);
});
test("儲存失敗不將匿名投訴送出、不宣稱成功", async () => {
  const f = fixture({ fail: true }); await f.system.handleInteraction(f.submit);
  assert.equal(f.delivered.length, 0); assert.match(f.submit.result.content, /傳送失敗/);
});
test("回覆資料必須綁定同一則原訊息、執行長與私訊頻道", async () => {
  for (const field of ["ceoId", "messageId", "channelId"]) {
    const f = fixture(); await f.system.handleInteraction(f.submit);
    [...f.rows.values()][0].payload[field] = "other";
    await f.system.handleInteraction(f.owner("modal")); assert.equal(f.replies.length, 0);
  }
});
test("私訊送出後若路由綁定尚未完成，授權處理時可恢復綁定", async () => {
  const f = fixture(); await f.system.handleInteraction(f.submit);
  const row = [...f.rows.values()][0]; delete row.payload.messageId; delete row.payload.channelId;
  await f.system.handleInteraction(f.owner("modal")); assert.equal(f.replies.length, 1);
  assert.equal(row.payload.messageId, MESSAGE); assert.equal(row.payload.channelId, "ceo-dm");
});
