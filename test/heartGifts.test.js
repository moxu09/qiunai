const assert = require("node:assert/strict");
const test = require("node:test");
const { createHeartGifts, GUILD_ID, BROADCAST_CHANNEL_ID, crossedTiers } = require("../utils/heartGifts");

test("both members qualify at the exact threshold, existing roles are kept, and anonymous broadcasts omit the buyer", async () => {
  const buyer = "111111111111111111", staff = "222222222222222222";
  const [[, role]] = crossedTiers(500, 520);
  assert.deepEqual(crossedTiers(520, 550), []);
  const base = {
    event_id: 42, buyer_id: buyer, staff_id: staff, previous_total: 500, total: 550,
    points: 50, lines: [{ name: "貓咪漢堡", quantity: 1 }],
    broadcast: true, anonymous: true, opening_verified: true, attempts: 1,
  };
  const adds = [], sent = [], updates = [], imageRequests = [];
  const imageUrl = "https://cdn.discordapp.com/attachments/example/heart.png";
  const members = {
    [buyer]: { roles: { cache: new Set([role, "already-held"]), add: async id => adds.push([buyer, id]) } },
    [staff]: { roles: { cache: new Set(["other-role"]), add: async id => adds.push([staff, id]) } },
  };
  const image = Buffer.from("level image");
  let imageAvailable = false;
  let savedMessageIds = {};
  const service = createHeartGifts({
    fetchImage: async url => {
      assert.equal(url, imageUrl);
      return imageAvailable
        ? new Response(image, { headers: { "Content-Type": "image/png" } })
        : new Response(null, { status: 503 });
    },
    client: {
      guilds: { fetch: async () => ({ members: { fetch: async ({ user }) => members[user] } }) },
      channels: { fetch: async id => {
        if (id === BROADCAST_CHANNEL_ID) return {
          guildId: GUILD_ID, isTextBased: () => true,
          send: async payload => { sent.push(payload); return { id: String(sent.length) }; },
        };
        assert.equal(id, "1529591891329286246");
        return {
          guildId: "1513174069087047731", isTextBased: () => true,
          messages: { fetch: async options => {
            imageRequests.push(options);
            return { attachments: [{ contentType: "image/png", url: imageUrl }] };
          } },
        };
      } },
    },
    supabase: {
      rpc: async () => ({ data: imageAvailable
        ? [{ ...base, kind: "broadcast", message_ids: savedMessageIds }]
        : ["buyer_roles", "staff_roles", "broadcast"].map(kind => ({ ...base, kind })) }),
      from: () => ({
        update: changes => {
          if (changes.message_ids) savedMessageIds = { ...changes.message_ids };
          updates.push(changes);
          return { eq() { return this; }, gt() { return this; }, select: async () => ({ data: [{ event_id: 42 }] }) };
        },
      }),
    },
  });
  const log = console.warn;
  console.warn = () => {};
  try { await service.deliver(); } finally { console.warn = log; }
  assert.equal(sent.length, 1);
  assert.equal(updates.filter(update => update.next_attempt_at).length, 1);
  imageAvailable = true;
  await service.deliver();
  assert.deepEqual(adds, [[staff, role]]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(message => !message.content.includes(buyer) && message.enforceNonce));
  assert.ok(sent.every(message => message.allowedMentions.parse.length === 0));
  assert.match(sent[0].content, /^\*\*感謝 匿名闆闆 送給\n[\s\S]+增加心動值50.*\n累積心動值550.*\*\*$/);
  assert.equal(sent[0].files, undefined);
  assert.deepEqual(imageRequests, Array(2).fill({ message: "1529591998548545536", force: true }));
  assert.deepEqual(sent[1].files, [{ attachment: image, name: "heart-520.png" }]);
  assert.match(sent[1].content, /親密度升級[\s\S]+心動值達到520/);
  assert.equal(updates.filter(update => update.done_at).length, 3);
});
