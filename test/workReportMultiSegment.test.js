const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  canEnterWorkReportTime,
} = require("../events/workReportSystem");

test("工時輸入不限制操作者身分，開始與結束都使用正確狀態判斷", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  const start = source.indexOf(
    '(interaction.customId.startsWith("work_report_start_") ||',
  );
  const handler = source.slice(start, source.indexOf("    return false;", start));
  assert.doesNotMatch(handler, /只有這筆工時申報的陪陪本人/);
  assert.doesNotMatch(handler, /\.eq\("discord_id", interaction\.user\.id\)/);
  assert.match(handler, /canEnterWorkReportTime\(current, \{ isEnd: !isStart \}\)/);
});

test("第一個時間已存在時，待審核狀態仍可補填該段結束時間", () => {
  const pending = {
    status: "工時待審核",
    admin_note: JSON.stringify({ pendingSegmentStart: "2026-09-06T01:00:00.000Z" }),
  };
  assert.equal(canEnterWorkReportTime(pending, { isEnd: true }), true);
  assert.equal(canEnterWorkReportTime(pending, { isEnd: false }), false);
  assert.equal(
    canEnterWorkReportTime({ ...pending, admin_note: "{}" }, { isEnd: true }),
    false,
  );
  assert.equal(
    canEnterWorkReportTime({ ...pending, status: "cancelled" }, { isEnd: true }),
    false,
  );
});

test("開始與結束時間按鈕在查詢資料庫前立即開啟輸入視窗", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  const buttonStart = source.indexOf(
    'interaction.customId.startsWith("work_report_start_") ||',
  );
  const submitStart = source.indexOf(
    'interaction.customId.startsWith("submit_work_report_start_")',
    buttonStart,
  );
  const buttonBlock = source.slice(buttonStart, submitStart);
  assert.ok(buttonStart >= 0 && submitStart > buttonStart);
  assert.match(buttonBlock, /await interaction\.showModal\(modal\)/);
  assert.doesNotMatch(buttonBlock, /\.from\(salaryTable\)/);
});

test("草稿狀態可連續新增第二段，已完成狀態不可重開", () => {
  for (const status of ["work_draft", "工時待填"]) {
    assert.equal(canEnterWorkReportTime({ status }, { isEnd: false }), true);
    assert.equal(canEnterWorkReportTime({ status }, { isEnd: true }), true);
  }
  assert.equal(canEnterWorkReportTime({ status: "completed" }), false);
});
