const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createTipWalletConfirmationRunner } = require("../utils/tipWalletConfirmation");

test("同筆打賞並行確認只執行一次付款與通知，不同打賞不互相阻塞", async () => {
  const run = createTipWalletConfirmationRunner();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let debits = 0, notices = 0;
  const first = run("guild:tip", async () => { debits++; await gate; notices++; return "done"; });
  assert.equal(await run("guild:tip", () => { debits++; notices++; }, () => "busy"), "busy");
  assert.equal(await run("guild:other", () => "other"), "other");
  release();
  assert.equal(await first, "done");
  assert.equal(debits, 1);
  assert.equal(notices, 1);
});

test("付款或通知失敗會釋放流程鎖，允許透過既有冪等交易重試", async () => {
  const run = createTipWalletConfirmationRunner();
  await assert.rejects(run("tip", async () => { throw new Error("temporary"); }), /temporary/);
  assert.equal(await run("tip", () => "retried"), "retried");
});

test("實際錢包確認分支鎖住完整流程，成功通知與關閉按鈕使用固定nonce", () => {
  const source = fs.readFileSync(require.resolve("../index"), "utf8");
  const block = source.slice(source.indexOf('if (customId.startsWith("confirm_tip_wallet_"))'), source.indexOf('if (customId.startsWith("cancel_tip_wallet_"))'));
  assert.match(block, /return await runTipWalletConfirmation/);
  assert.ok(block.indexOf("runTipWalletConfirmation") < block.indexOf("payTipAllocationsWithWalletAtomic"));
  assert.match(block, /tipData, "wallet-paid"/);
  assert.match(block, /tipData, "wallet-completed"/);
  assert.match(block, /sendTipCloseButtons\(interaction.channel, tipData\)/);
  assert.doesNotMatch(block, /interaction.channel.send\(/);
});
