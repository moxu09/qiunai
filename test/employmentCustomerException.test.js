const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmploymentSystem } = require("../events/employmentSystem");
const config = require("../config/employment");

async function startApplication(userId, applicationConfig) {
  const replies = [];
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        async limit() {
          return { data: table === "play_orders" ? [{ id: "paid" }] : [], error: null };
        },
      };
    },
  };
  const system = createEmploymentSystem({}, applicationConfig, supabase);
  await system.handleInteraction({
    customId: "employment_start",
    guildId: "test-guild",
    user: { id: userId },
    async deferReply() {},
    async editReply(payload) { replies.push(payload); },
  });
  return replies.at(-1).content;
}

test("only the approved Qiunai customer bypasses the customer restriction", async () => {
  assert.match(await startApplication("404285545024585729", config), /是否同意陪玩共同守則/);
  assert.match(await startApplication("123456789012345678", config), /老闆身分不給予申請/);
});

test("the customer exception does not apply without the store configuration", async () => {
  assert.match(await startApplication("404285545024585729", { organization: "deepnight" }), /老闆身分不給予申請/);
});
