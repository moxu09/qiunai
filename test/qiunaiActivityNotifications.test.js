const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildActivityAnnouncement,
  buildActivityDm,
  notificationNonce,
} = require("../events/qiunaiActivityNotifications");

const activity = {
  id: "3df7cc5b-7dbb-4c72-8d42-9d338429ea0f",
  title: "達標線下聚餐",
  description: "北部與中部場次，請依照 EIP 內容選擇。",
  location: "台北、台中",
  starts_at: "2026-11-15T04:30:00.000Z",
  response_deadline: "2026-11-10T15:59:00.000Z",
};

test("活動公告列出時間、回覆期限、分類及 EIP 入口", () => {
  const content = buildActivityAnnouncement(activity, [{ label: "北部" }, { label: "中部" }]);
  assert.match(content, /達標線下聚餐/);
  assert.match(content, /2026年11月15日/);
  assert.match(content, /北部、中部/);
  assert.match(content, /活動報名/);
  assert.match(content, /https:\/\/qiunai\.wearestilllhere\.com\/staff/);
  assert.ok(content.length < 2000);
});

test("私訊說明由小奈通知，且各對象採不同的固定 nonce", () => {
  assert.match(buildActivityDm(activity), /小奈通知你/);
  assert.equal(notificationNonce(activity.id, "123"), notificationNonce(activity.id, "123"));
  assert.notEqual(notificationNonce(activity.id, "123"), notificationNonce(activity.id, "456"));
  assert.ok(notificationNonce(activity.id, "123").length <= 25);
});
