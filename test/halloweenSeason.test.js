const test = require("node:test"), assert = require("node:assert/strict");
const { HALLOWEEN_END, THEME_AUTHOR, isHalloweenActive, seasonalMessageBody, installSeasonalMessages } = require("../utils/halloweenSeason");
const { buildChatDropPayload, chatDropClaimText } = require("../utils/chatDropTheme");
const { createHalloweenLifecycle } = require("../utils/halloweenLifecycle");
const ACTIVE = Date.parse("2026-10-30T12:00:00+08:00");
test("台灣10/31整天有效，11/1 00:00立即停止，與主機時區無關", () => {
  assert.equal(isHalloweenActive(Date.parse("2026-10-31T23:59:59.999+08:00")), true);
  assert.equal(isHalloweenActive(Date.parse("2026-11-01T00:00:00+08:00")), false);
  assert.equal(isHalloweenActive(Date.parse("2026-10-28T23:59:59+08:00")), false);
  assert.equal(HALLOWEEN_END, Date.parse("2026-10-31T16:00:00Z"));
});
test("裝飾訊息保留投訴識別標題、回覆去重footer、金額與付款按鈕", () => {
  const body = { content: "<@123> 應付300", embeds: [{ title: "👤 收到實名投訴", description: "原文", fields: [{ name: "金額", value: "NT$300" }], footer: { text: "投訴回覆：123" } }], components: [{ type: 1, components: [{ type: 2, custom_id: "pay_300", label: "付款", style: 1 }] }], flags: 64 };
  const before = JSON.stringify(body), result = seasonalMessageBody(body, ACTIVE);
  assert.equal(JSON.stringify(body), before); assert.equal(result.embeds[0].author.name, THEME_AUTHOR);
  assert.equal(result.embeds[0].title, body.embeds[0].title); assert.deepEqual(result.embeds[0].fields, body.embeds[0].fields);
  assert.deepEqual(result.embeds[0].footer, body.embeds[0].footer); assert.deepEqual(result.components, body.components); assert.equal(result.flags, 64);
  assert.equal(result.content, body.content);
  assert.equal(seasonalMessageBody(result, ACTIVE).embeds[0].author.name, THEME_AUTHOR);
  assert.equal(seasonalMessageBody(result, HALLOWEEN_END).embeds[0].author, undefined);
});
test("錯誤與成功顏色保持語意，作者帳號不被取代；字數上限不超標", () => {
  for (const color of [0xdc2626, 0x57f287]) assert.equal(seasonalMessageBody({ embeds: [{ color, title: "狀態" }] }, ACTIVE).embeds[0].color, color);
  const author = seasonalMessageBody({ embeds: [{ author: { name: "陪陪A", icon_url: "https://example.com/a.png" } }] }, ACTIVE).embeds[0].author;
  assert.match(author.name, /^陪陪A/); assert.equal(author.icon_url, "https://example.com/a.png");
  const full = seasonalMessageBody({ embeds: [{ description: "a".repeat(4000), fields: [{ name: "欄", value: "a".repeat(999) }, { name: "欄", value: "a".repeat(999) }] }] }, ACTIVE);
  assert.equal(full.embeds[0].author, undefined);
});
test("REST攔截僅處理訊息，不改付款請求、modal或API驗證資料", async () => {
  const calls = [], rest = { request: async options => { calls.push(options); return {}; } };
  let now = ACTIVE; installSeasonalMessages(rest, { now: () => now }); installSeasonalMessages(rest);
  const base = { embeds: [{ title: "標題" }] };
  await rest.request({ fullRoute: "/channels/123/messages", method: "POST", body: base, files: ["attachment"] });
  assert.equal(calls[0].body.embeds[0].author.name, THEME_AUTHOR); assert.deepEqual(calls[0].files, ["attachment"]);
  await rest.request({ fullRoute: "/interactions/123/token/callback", method: "POST", body: { type: 4, data: base } });
  assert.equal(calls[1].body.data.embeds[0].author.name, THEME_AUTHOR);
  const modal = { type: 9, data: { custom_id: "form", components: [] } };
  await rest.request({ fullRoute: "/interactions/123/token/callback", method: "POST", body: modal }); assert.deepEqual(calls[2].body, modal);
  await rest.request({ fullRoute: "/users/@me", method: "PATCH", body: { avatar: "original" } }); assert.equal(calls[3].body.avatar, "original");
  now = HALLOWEEN_END;
  await rest.request({ fullRoute: "/channels/123/messages", method: "POST", body: base }); assert.equal(calls[4].body.embeds[0].author, undefined);
});
test("聊天掉落到期回到原卡片，領取ID與獎勵不變", () => {
  const active = buildChatDropPayload(18, { now: ACTIVE }), expired = buildChatDropPayload(18, { now: HALLOWEEN_END });
  assert(active.files.length); assert.equal(expired.files, undefined);
  assert.equal(expired.embeds[0].data.title, "☔ 星雨幣掉落");
  assert.equal(expired.components[0].components[0].data.custom_id, active.components[0].components[0].data.custom_id);
  assert.equal(chatDropClaimText({ embeds: active.embeds.map(e => e.toJSON()) }, 18, HALLOWEEN_END), "☔ 成功領取 18 星雨幣");
});
function lifecycleFixture() {
  let payload = { botId: "bot", avatar: "original-avatar", nicknames: { shop: null, staff: "小奈" }, applied: false, restored: false };
  let now = ACTIVE; const calls = [];
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { payload: structuredClone(payload) } }; },
    update(value) { payload = structuredClone(value.payload); return this; }, then(resolve) { resolve({}); } }) };
  const client = { user: { id: "bot", setAvatar: async value => calls.push(["avatar", Buffer.isBuffer(value) ? "halloween" : value]) },
    rest: { patch: async (route, opts) => calls.push([route, opts.body.nick]) } };
  const options = { client, db, guildIds: ["shop", "staff"], now: () => now, refreshPanels: async () => calls.push(["panels", "restore"]) };
  return { calls, options, setNow: value => { now = value; }, get state() { return payload; } };
}
test("保存備份後套用頭像與兩群暱稱，到期還原一次並刷新所有面板", async () => {
  const f = lifecycleFixture(); const service = createHalloweenLifecycle(f.options);
  await service.tick(); assert.equal(f.state.applied, true); assert.equal(f.calls[0][1], "halloween");
  await service.tick(); assert.equal(f.calls.length, 3);
  f.setNow(HALLOWEEN_END); await service.tick(); assert.equal(f.state.restored, true);
  assert(f.calls.some(c => c[1] === "original-avatar")); assert(f.calls.some(c => c[1] === null)); assert(f.calls.some(c => c[0] === "panels"));
  const count = f.calls.length; await service.tick(); assert.equal(f.calls.length, count);
});
test("跨重啟仍用原始備份還原；面板恢復失敗可重試，不假裝完成", async () => {
  const f = lifecycleFixture(); await createHalloweenLifecycle(f.options).tick(); f.setNow(HALLOWEEN_END);
  let fail = true;
  const options = { ...f.options, refreshPanels: async () => { if (fail) { fail = false; throw Error("temporary"); } } };
  const restarted = createHalloweenLifecycle(options); await assert.rejects(restarted.tick(), /temporary/); assert.equal(f.state.restored, false);
  await restarted.tick(); assert.equal(f.state.restored, true);
});
test("暱稱變更暫時失敗時不會重複更換頭像，保留各步驟進度", async () => {
  const f = lifecycleFixture(); let fail = true;
  const original = f.options.client.rest.patch;
  f.options.client.rest.patch = async (...args) => { if (fail) { fail = false; throw Error("temporary"); } return original(...args); };
  const service = createHalloweenLifecycle(f.options);
  await assert.rejects(service.tick(), /temporary/); assert.equal(f.state.avatarApplied, true); assert.equal(f.state.applied, false);
  await service.tick(); assert.equal(f.state.applied, true);
  assert.equal(f.calls.filter(c => c[0] === "avatar").length, 1);
});
test("首次啟用先用實際bot ID讀取暱稱並保存原始資料，才修改頭像", async () => {
  let state = null;
  const db = { from: () => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: state ? { payload: structuredClone(state) } : null }; },
    async insert(row) { state = structuredClone(row.payload); return {}; },
    update(row) { state = structuredClone(row.payload); return this; }, then(resolve) { resolve({}); },
  }) };
  const gets = [];
  const client = { user: { id: "1502587084563812453", displayAvatarURL: () => "https://example.com/avatar.png",
    setAvatar: async () => { assert(state?.avatar); assert.deepEqual(state.nicknames, { shop: null, staff: "原始小奈" }); },
  }, rest: { get: async route => { gets.push(route); assert(route.endsWith("/members/1502587084563812453")); return { nick: route.includes("/shop/") ? null : "原始小奈" }; }, patch: async () => {} } };
  const lifecycle = createHalloweenLifecycle({ client, db, guildIds: ["shop", "staff"], refreshPanels: async () => {}, now: () => ACTIVE,
    fetchAvatar: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer }),
  });
  await lifecycle.tick(); assert.equal(state.applied, true); assert.equal(gets.length, 2);
});
