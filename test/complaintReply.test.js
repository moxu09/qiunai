const test = require("node:test");
const assert = require("node:assert/strict");
const { createComplaintSystem } = require("../events/complaintSystem");
const CEO = "847840193859682304", SENDER = "985810902991388722", MESSAGE = "1564609787516289177";

function fixture({ anonymous = false, sendError = false, editError = false, previous = false, db = null } = {}) {
  const sent = []; const edits = []; const original = { id: MESSAGE, author: { id: "bot" }, embeds: [{
    title: anonymous ? "🕶️ 收到匿名投訴" : "👤 收到實名投訴", description: "私密投訴內容",
    fields: [{ name: "主旨", value: "測試事項" }, { name: "投訴者", value: anonymous ? "匿名（未紀錄發送者）" : `<@${SENDER}>（原帳號）` },
      { name: "處理狀態", value: "⏳ 尚未處理" }],
  }], edit: async payload => { if (editError) { editError = false; throw Error("temporary"); } edits.push(payload); original.embeds = payload.embeds.map(e => e.toJSON()); } };
  const history = previous ? [{ author: { id: "bot" }, embeds: [{ footer: { text: `投訴回覆：${MESSAGE}` }, description: "上次已送出的回覆" }] }] : [];
  const dm = { messages: { fetch: async () => history }, send: async payload => {
    if (sendError) throw Object.assign(Error("DM closed"), { code: 50007 });
    sent.push(payload); history.push({ author: { id: "bot" }, embeds: payload.embeds.map(e => e.toJSON()) });
  } };
  const client = { user: { id: "bot" }, users: { fetch: async id => { assert.equal(id, SENDER); return { createDM: async () => dm }; } } };
  const system = createComplaintSystem(client, { ceoUserId: CEO }, db);
  function interaction(kind = "button", user = CEO) {
    const replies = [];
    return { user: { id: user }, message: original, guildId: null, channelId: "ceo-dm", customId: kind === "button" ? "complaint_mark_handled" : `complaint_reply_${MESSAGE}`,
      channel: { messages: { fetch: async id => { assert.equal(id, MESSAGE); return original; } } },
      isButton: () => kind === "button", isModalSubmit: () => kind === "modal",
      showModal: async modal => { replies.push(modal.toJSON()); }, reply: async payload => replies.push(payload),
      update: async payload => edits.push(payload), deferReply: async () => {}, editReply: async payload => replies.push(payload),
      fields: { getTextInputValue: () => "已確認此事，會安排後續處理。" }, replies,
    };
  }
  return { system, interaction, sent, edits, original, dm, client };
}
test("舊實名投訴已處理按鈕開啟回覆表單，尚未送出不改狀態", async () => {
  const f = fixture(); const i = f.interaction(); assert.equal(await f.system.handleInteraction(i), true);
  assert.equal(i.replies[0].custom_id, `complaint_reply_${MESSAGE}`); assert.equal(f.edits.length, 0); assert.equal(f.sent.length, 0);
});
test("回覆送到原投訴人，成功才記錄回覆與處理狀態並移除按鈕", async () => {
  const f = fixture(); const i = f.interaction("modal"); await f.system.handleInteraction(i);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].embeds[0].data.description, "已確認此事，會安排後續處理。");
  assert.equal(f.sent[0].embeds[0].data.fields[0].value, "測試事項");
  assert.equal(f.sent[0].embeds[0].data.description.includes("私密投訴內容"), false);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] }); assert.equal(f.sent[0].enforceNonce, true);
  assert.match(f.original.embeds[0].fields.find(x => x.name === "處理狀態").value, /已私訊回覆/);
  assert.deepEqual(f.edits[0].components, []); assert.match(i.replies[0].content, /已私訊回覆/);
  await f.system.handleInteraction(f.interaction("modal")); assert.equal(f.sent.length, 1);
});
test("非執行長、公頻及偽造訊息無法回覆", async () => {
  for (const kind of ["button", "modal"]) {
    const f = fixture(); const other = f.interaction(kind, SENDER); await f.system.handleInteraction(other);
    assert.equal(f.sent.length, 0); assert.match(other.replies[0].content, /只有執行長/);
    const publicInteraction = f.interaction(kind); publicInteraction.guildId = "guild"; await f.system.handleInteraction(publicInteraction);
    assert.equal(f.sent.length, 0); assert.match(publicInteraction.replies[0].content, /只有執行長/);
    f.original.author.id = "other-bot";
    await f.system.handleInteraction(f.interaction(kind)); assert.equal(f.sent.length, 0); assert.equal(f.edits.length, 0);
  }
});
test("舊匿名投訴沒有留存帳號，僅標記已處理，不嘗試推測身分", async () => {
  const f = fixture({ anonymous: true }); const i = f.interaction(); await f.system.handleInteraction(i);
  assert.equal(f.sent.length, 0); assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].embeds[0].data.fields.find(x => x.name === "投訴者").value, "匿名（未紀錄發送者）");
});
test("關閉私訊或傳送失敗時保留未處理，可重試", async () => {
  const f = fixture({ sendError: true }); const i = f.interaction("modal"); await f.system.handleInteraction(i);
  assert.equal(f.edits.length, 0); assert.match(i.replies[0].content, /尚未標記已處理/);
});
test("已傳送但狀態更新失敗，重試找回原回覆而非重複私訊", async () => {
  const f = fixture({ editError: true }); const i = f.interaction("modal"); await f.system.handleInteraction(i);
  assert.equal(f.sent.length, 1); assert.match(i.replies[0].content, /回覆已傳送/);
  await f.system.handleInteraction(f.interaction("modal")); assert.equal(f.sent.length, 1); assert.equal(f.edits.length, 1);
  const restarted = fixture({ previous: true }); await restarted.system.handleInteraction(restarted.interaction("modal"));
  assert.equal(restarted.sent.length, 0); assert.equal(restarted.original.embeds[0].fields.find(x => x.name === "處理回覆").value, "上次已送出的回覆");
});
test("同一投訴同時送出只傳一份回覆，空白回覆不發送", async () => {
  const f = fixture(); await Promise.all([f.system.handleInteraction(f.interaction("modal")), f.system.handleInteraction(f.interaction("modal"))]);
  assert.equal(f.sent.length, 1);
  const empty = fixture(); const i = empty.interaction("modal"); i.fields.getTextInputValue = () => "   ";
  await empty.system.handleInteraction(i); assert.equal(empty.sent.length, 0); assert.equal(empty.edits.length, 0);
});
