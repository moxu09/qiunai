const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDispatchChannelsByName, createManualDispatchChannels } = require("../utils/manualDispatchChannels");
const { validPayload } = require("../utils/websiteOrderBridge");

const lobby = { id: "cat1", type: 4, name: "°.秋奈派單大廳°." };
const ch = (id, name, parentId = "cat1", position = 0) => ({ id, name, type: 0, parentId, position });
const channels = [
  lobby,
  ch("d", "派單｜三角洲", "cat1", 1), ch("v", "派單｜特戰", "cat1", 2), ch("a", "派單｜apex", "cat1", 3),
  ch("m", "派單｜綜合遊戲", "cat1", 4), ch("t", "派單｜語聊類", "cat1", 5), ch("o", "派單｜其他類", "cat1", 6),
  ch("old", "舊派單-三角洲", "elsewhere"),
];

test("resolves game dispatch channels by name inside 派單大廳", () => {
  assert.deepEqual(resolveDispatchChannelsByName(channels), {
    valorant: "v", delta: "d", apex: "a", voice: "t", other: "o", mixed: "m", lol: "m", arena: "m",
  });
});

test("ignores non-text channels and channels without 派單", () => {
  const found = resolveDispatchChannelsByName([ch("x", "三角洲閒聊"), { id: "y", type: 2, name: "派單｜三角洲" }]);
  assert.equal(found.delta, undefined);
});

test("ensure() overrides stale ids by name and keeps defaults otherwise", async () => {
  const cache = new Map(channels.map((c) => [c.id, c]));
  const guild = { channels: { fetch: async () => cache, cache } };
  const client = { guilds: { fetch: async () => guild } };
  const m = createManualDispatchChannels({
    defaults: { valorant: "OLD_V", delta: "OLD_D", lol: "OLD_L", apex: "OLD_A", arena: "OLD_R", voice: "OLD_T", other: "OLD_O" },
    guildId: "g", getClient: () => client, logger: { log() {}, error() {} },
  });
  await m.ensure();
  assert.equal(m.ids.delta, "d");
  assert.equal(m.ids.valorant, "v");
  assert.equal(m.ids.lol, "m");
  assert.equal(m.ids.mixed, undefined);
});

test("ensure() never throws when Discord is unavailable", async () => {
  const m = createManualDispatchChannels({ defaults: { delta: "OLD" }, guildId: "g",
    getClient: () => ({ guilds: { fetch: async () => { throw new Error("down"); } } }), logger: { log() {}, error() {} } });
  await m.ensure();
  assert.equal(m.ids.delta, "OLD");
});

test("website bridge accepts optional source app/website only", () => {
  const base = { requestId: "WEB-6D008694-CC7D-4DD6-A43A-DFD55DC23FB3", userId: "847840193859682304",
    requirements: { customerName: "小璃", game: "三角洲行動", serviceType: "娛樂", quantity: "1 小時", platform: "PC",
      targetRank: "", companionRank: "", notes: "", companionCount: 1 } };
  assert.equal(validPayload(base), true);
  assert.equal(validPayload({ ...base, source: "app" }), true);
  assert.equal(validPayload({ ...base, source: "evil" }), false);
});

test("every APP order game goes to its dispatch channel", () => {
  const { dispatchKeyForOrder } = require("../utils/manualDispatchChannels");
  const expected = {
    "特戰英豪": "valorant", "三角洲行動": "delta", "Apex 英雄": "apex", "英雄聯盟": "lol", "ARAM": "lol",
    "聯盟戰棋": "lol", "傳說對決": "arena", "Steam 多人": "mixed", "PUBG M": "mixed", "第五人格": "mixed",
    "王者榮耀": "mixed", "Minecraft": "mixed", "語音聊天": "voice", "追劇陪伴": "other", "其他項目": "other",
  };
  for (const [game, key] of Object.entries(expected)) {
    assert.equal(dispatchKeyForOrder({ game, service: `${game}｜娛樂`, order_item: "娛樂" }), key, game);
  }
  // lol / arena have no channel of their own → 派單｜綜合遊戲
  const ids = resolveDispatchChannelsByName(channels);
  assert.equal(ids.lol, "m");
  assert.equal(ids.arena, "m");
});
