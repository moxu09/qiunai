const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmploymentSystem } = require("../events/employmentSystem");
const config = require("../config/employment");

async function startApplication(userId, pending) {
  const replies = [];
  const system = createEmploymentSystem({}, config, {});
  await system.handleInteraction({
    customId: "employment_start",
    guildId: "test-guild",
    guild: { members: { fetch: async () => ({ pending }) } },
    user: { id: userId },
    async deferReply() {},
    async editReply(payload) { replies.push(payload); },
  });
  return replies.at(-1).content;
}

test("完成伺服器驗證的顧客都可以申請入職", async () => {
  for (const userId of ["404285545024585729", "123456789012345678"])
    assert.match(await startApplication(userId, false), /是否同意陪玩共同守則/);
});

test("尚未完成成員規則驗證不得申請", async () => {
  assert.match(await startApplication("123456789012345678", true), /成員規則驗證/);
});
