const test = require("node:test");
const assert = require("node:assert/strict");
const { deleteChannelIfPresent, scheduleChannelDeletion } = require("../utils/channelCleanup");

test("延遲刪除捕捉頻道 ID，不再讀取已失效的 interaction.channel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cachedChannel = { id: "ticket" };
  let getterReads = 0;
  const fetched = [], deleted = [], errors = [];
  const interaction = {
    channelId: "ticket",
    get channel() { getterReads += 1; return cachedChannel; },
    client: { channels: { async fetch(id) {
      fetched.push(id);
      return { async delete(reason) { deleted.push(reason); } };
    } } },
  };
  scheduleChannelDeletion(interaction, 10000, {
    reason: "訂單紀錄已儲存",
    onError: (error) => errors.push(error),
  });
  cachedChannel = null;
  t.mock.timers.tick(9999);
  assert.deepEqual(fetched, []);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(getterReads, 1);
  assert.deepEqual(fetched, ["ticket"]);
  assert.deepEqual(deleted, ["訂單紀錄已儲存"]);
  assert.deepEqual(errors, []);
});

test("已刪除或找不到頻道的清理是無害操作", async () => {
  for (const fetch of [
    async () => null,
    async () => { throw { code: 10003 }; },
    async () => ({ async delete() { throw { code: "10003" }; } }),
  ]) {
    assert.equal(await deleteChannelIfPresent({
      client: { channels: { fetch } }, channelId: "ticket",
    }), false);
  }
  assert.equal(await deleteChannelIfPresent({ channelId: null, channel: null }), false);
});

test("同一頻道兩次關閉只刪除一次，不產生失敗", async () => {
  let deletes = 0;
  const target = {
    channelId: "ticket",
    client: { channels: { async fetch() {
      if (deletes) throw { code: 10003 };
      return { async delete() { deletes += 1; } };
    } } },
  };
  assert.equal(await deleteChannelIfPresent(target), true);
  assert.equal(await deleteChannelIfPresent(target), false);
  assert.equal(deletes, 1);
});

test("刪除權限錯誤仍回報，不把所有 404 或錯誤吞掉", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const permissionError = Object.assign(new Error("Missing Permissions"), { code: 50013 });
  const errors = [];
  const interaction = {
    channelId: "ticket", channel: null,
    client: { channels: { async fetch() {
      return { async delete() { throw permissionError; } };
    } } },
  };
  await assert.rejects(deleteChannelIfPresent(interaction), permissionError);
  scheduleChannelDeletion(interaction, 3000, { onError: (error) => errors.push(error) });
  t.mock.timers.tick(3000);
  await new Promise(setImmediate);
  assert.deepEqual(errors, [permissionError]);
  await assert.rejects(deleteChannelIfPresent({
    channelId: "ticket", client: { channels: { async fetch() { throw { status: 404, code: 99999 }; } } },
  }), (error) => error.code === 99999);
});
