const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkReportSystem } = require("../events/workReportSystem");

function fixture(kind, { value = "2026-10-08 11:00", readError = null, status = "工時待填", conflict = false, deferred = false } = {}) {
  const calls = [];
  const row = { id: "report", status, admin_note: JSON.stringify({
    pendingSegmentStart: "2026-10-08T02:00:00.000Z", expectedDurationMinutes: 120,
  }) };
  let updating = false;
  const query = {
    select() { return this; }, eq() { return this; },
    update(payload) { calls.push("update"); updating = true; this.payload = payload; return this; },
    async maybeSingle() {
      assert.ok(calls.includes("defer") || deferred, "資料庫查詢前必須先確認互動");
      calls.push("database");
      return updating ? { data: conflict ? null : { ...row, ...this.payload }, error: null }
        : { data: readError ? null : row, error: readError };
    },
  };
  const system = createWorkReportSystem({
    supabase: { from() { return query; } }, client: {}, appKey: "qiunai", salaryTable: "play_orders",
  });
  const interaction = {
    customId: `submit_work_report_${kind}_report`, deferred, replied: false,
    isButton: () => false, isModalSubmit: () => true, isUserSelectMenu: () => false,
    fields: { getTextInputValue: () => value },
    async deferReply(options) { assert.equal(options.flags, 64); calls.push("defer"); this.deferred = true; },
    async reply() { assert.fail("已確認的表單不可再次 reply"); },
    async editReply(payload) { calls.push("editReply"); this.result = payload.content; },
    message: { embeds: [], async edit() { calls.push("messageEdit"); } },
  };
  return { system, interaction, calls };
}

for (const kind of ["start", "end"]) {
  test(`${kind} 表單先確認互動再查詢及儲存`, async () => {
    const f = fixture(kind);
    await f.system.handleInteraction(f.interaction);
    assert.equal(f.calls[0], "defer");
    assert.ok(f.calls.includes("update"));
    assert.match(f.interaction.result, /已儲存/);
  });
}

for (const options of [
  { value: "bad", pattern: /時間格式/ },
  { readError: { message: "timeout" }, pattern: /讀取工時/ },
  { status: "completed", pattern: /已送出/ },
  { value: "2026-10-08 09:00", pattern: /結束時間必須晚於/ },
  { conflict: true, pattern: /剛被更新/ },
]) {
  test(`結束表單錯誤可透過 editReply 回覆：${options.pattern}`, async () => {
    const f = fixture("end", options);
    await f.system.handleInteraction(f.interaction);
    assert.match(f.interaction.result, options.pattern);
  });
}

test("外層已確認的表單不重複 defer", async () => {
  const f = fixture("end", { deferred: true });
  await f.system.handleInteraction(f.interaction);
  assert.equal(f.calls.includes("defer"), false);
  assert.match(f.interaction.result, /已儲存/);
});
