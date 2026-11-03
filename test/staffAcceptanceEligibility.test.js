const test = require("node:test");
const assert = require("node:assert/strict");
const { canStaffAcceptOrder } = require("../utils/staffAcceptanceEligibility");

const guildId = "1206138511535898654";

test("離線的在職陪陪仍可直接接單", () => {
  assert.equal(canStaffAcceptOrder({
    discord_id: "123", guild_id: guildId, status: "offline",
    is_active: true, can_take_order: true,
  }, guildId), true);
});

test("離職、停權及其他店陪陪不能接單", () => {
  const base = { discord_id: "123", guild_id: guildId, is_active: true, can_take_order: true };
  assert.equal(canStaffAcceptOrder({ ...base, is_active: false }, guildId), false);
  assert.equal(canStaffAcceptOrder({ ...base, can_take_order: false }, guildId), false);
  assert.equal(canStaffAcceptOrder({ ...base, guild_id: "1501098191813214312" }, guildId), false);
  assert.equal(canStaffAcceptOrder(null, guildId), false);
});
