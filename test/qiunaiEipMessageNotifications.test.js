const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildMessageReminder,
  notificationNonce,
  processPendingEipMessageNotifications,
} = require("../events/qiunaiEipMessageNotifications");

const messageId = "14d3225c-1b03-4627-b91f-7ea07164df82";
const row = {
  message_id: messageId,
  sender_discord_id: "1206138511535898654",
  recipient_discord_id: "1552711165954756688",
  status: "pending",
  attempt_count: 0,
  attempted_at: null,
};

test("小奈提醒不包含員工私訊內容，且每則訊息有固定獨立 nonce", () => {
  const reminder = buildMessageReminder(row);
  assert.match(reminder, /小奈提醒你/);
  assert.match(reminder, /chat=1206138511535898654/);
  assert.match(reminder, /notice=14d3225c/);
  assert.doesNotMatch(reminder, /body|你好，同事/);
  assert.equal(notificationNonce(messageId), notificationNonce(messageId));
  assert.notEqual(notificationNonce(messageId), notificationNonce("24d3225c-1b03-4627-b91f-7ea07164df82"));
});

test("待發通知先宣告佔用，Discord DM 只送給資料列上的收件人", async () => {
  const sent = [];
  const updates = [];
  const supabase = {
    from(table) {
      assert.equal(table, "qiunai_eip_message_notifications");
      return {
        select() { return this; },
        in() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [row], error: null }); },
        update(values) { updates.push(values); return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: { message_id: messageId }, error: null }); },
        then(resolve) { resolve({ error: null }); },
      };
    },
  };
  const client = {
    users: {
      async fetch(id) {
        assert.equal(id, row.recipient_discord_id);
        return { async createDM() { return { async send(payload) { sent.push(payload); return { id: "dm-1" }; } }; } };
      },
    },
  };
  await processPendingEipMessageNotifications(supabase, client);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].nonce, notificationNonce(messageId));
  assert.equal(sent[0].enforceNonce, true);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(updates[0].status, "sending");
  assert.equal(updates.at(-1).status, "sent");
});
