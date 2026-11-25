const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAppPrizeClaims, PURGED_CONTACT } = require("../utils/appPrizeClaims");

const OWNER = "847840193859682304";
const OTHER = "223456789012345678";
const CUSTOMER = "123456789012345678";
const QIUNAI = "1206138511535898654";
const NOW = new Date("2026-12-20T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();
const CONTACT = { name: "王小明", phone: "0912345678", address: "台北市信義區松仁路 100 號", email: "ming@example.com" };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (n, channelId = "300000000000000001") => ({ channelId, messageId: String(400000000000000000n + BigInt(n)) });

const claim = (n, extra = {}) => ({
  id: uuid(n), user_id: CUSTOMER, guild_id: QIUNAI, source_type: "ichiban", source_id: `draw-${n}`,
  prize_name: "S賞 限定公仔", contact: CONTACT, status: "pending", created_at: ago(20),
  dm_refs: [], contact_purged_at: null, ...extra,
});
const redemption = (sourceId, days, extra = {}) => ({
  guild_id: QIUNAI, source_type: "ichiban_draw", source_id: sourceId, redeemed_at: ago(days), ...extra,
});

// Minimal PostgREST-like fake: eq (jsonb compared by JSON text), in, lt, the purge's or-filter,
// order/limit, maybeSingle, update(...).filters.select(), and awaiting the builder.
function fakeDb({ claims = [], redemptions = [], messages = [], failUpdate = false, beforeUpdate } = {}) {
  const tables = { app_prize_claims: claims, bot_prize_redemptions: redemptions, app_prize_claim_messages: messages };
  const db = {
    tables, updates: [], selects: [], inserted: [],
    from(table) {
      const filters = [];
      let patch = null;
      let selected = "*";
      let orderKey = null;
      let limitN = Infinity;
      const match = row => filters.every(fn => fn(row));
      const run = () => {
        let rows = tables[table].filter(match);
        if (orderKey) rows = [...rows].sort((a, b) => String(a[orderKey]).localeCompare(String(b[orderKey])));
        rows = rows.slice(0, limitN);
        if (!patch) return { data: rows.map(row => ({ ...row })), error: null };
        if (failUpdate) return { data: null, error: { code: "XX000", message: "boom" } };
        beforeUpdate?.(table, patch);
        const hit = tables[table].filter(match);
        if (table === "app_prize_claims") {
          // Mirrors the app migration's check constraints (whole update rejected, like Postgres).
          for (const row of hit) {
            const next = { ...row, ...patch };
            if (!Array.isArray(next.dm_refs)) return { data: null, error: { code: "23514", message: "app_prize_claims_dm_refs_chk" } };
            if (next.contact == null && next.contact_purged_at == null) return { data: null, error: { code: "23514", message: "app_prize_claims_contact_purged_chk" } };
          }
        }
        for (const row of hit) Object.assign(row, structuredClone(patch));
        db.updates.push({ table, patch: structuredClone(patch), count: hit.length });
        return { data: hit.map(row => ({ id: row.id })), error: null };
      };
      const query = {
        select(columns) { selected = columns; if (!patch) db.selects.push({ table, columns }); return query; },
        eq(key, value) {
          filters.push(row => (row[key] !== null && typeof row[key] === "object"
            ? JSON.stringify(row[key]) === value : String(row[key]) === String(value)));
          return query;
        },
        in(key, values) { filters.push(row => values.map(String).includes(String(row[key]))); return query; },
        gt(key, value) { filters.push(row => String(row[key]) > String(value)); return query; },
        neq(key, value) { filters.push(row => String(row[key]) !== String(value)); return query; },
        lt(key, value) { filters.push(row => String(row[key]) < String(value)); return query; },
        or(expression) {
          assert.equal(expression, "contact.not.is.null,dm_refs.neq.[]");
          filters.push(row => row.contact != null || (Array.isArray(row.dm_refs) && row.dm_refs.length > 0));
          return query;
        },
        order(key) { orderKey = key; return query; },
        limit(n) { limitN = n; return query; },
        update(value) { patch = value; return query; },
        async maybeSingle() { const { data } = run(); return { data: data[0] || null, error: null }; },
        async insert(row) { db.inserted.push({ table, row }); return { error: null }; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      void selected;
      return query;
    },
  };
  return db;
}

function fakeClient({ deleteErrors = {}, channelTypes = {}, failSendIds = [] } = {}) {
  const deleted = [];
  const sent = [];
  let next = 1;
  return {
    deleted, sent,
    channels: {
      async fetch(id) { return { id, type: channelTypes[id] ?? 1 }; }, // 1 = ChannelType.DM
    },
    rest: {
      async delete(route) {
        if (deleteErrors[route]) throw deleteErrors[route];
        deleted.push(route);
      },
    },
    users: {
      async fetch(id) {
        return {
          id,
          async send(payload) {
            if (failSendIds.includes(id)) throw Object.assign(new Error("cannot dm"), { code: 50007 });
            sent.push({ id, payload });
            return { id: String(500000000000000000n + BigInt(next++)), channelId: `6000000000000000${id.slice(-2)}` };
          },
        };
      },
    },
  };
}

const discordError = code => Object.assign(new Error(`discord ${code}`), { code });
const route = r => `/channels/${r.channelId}/messages/${r.messageId}`;

function captureConsole(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const key of Object.keys(original)) console[key] = (...args) => lines.push(args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  return Promise.resolve().then(run).finally(() => Object.assign(console, original)).then(result => ({ result, lines }));
}
const assertNoContact = lines => {
  for (const value of Object.values(CONTACT)) assert.ok(!lines.join("\n").includes(value), `log leaked ${value}`);
};

test("notify records every sent DM in dm_refs (new claim and customer reply)", async () => {
  const row = claim(1);
  const db = fakeDb({ claims: [row], messages: [{ id: uuid(99), claim_id: row.id, sender: "customer", body: "請寄週末", created_at: ago(1) }] });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client, recipientIds: `${OWNER},${OTHER}` });
  assert.equal((await claims.notify({ claimId: row.id })).status, 200);
  assert.equal((await claims.notify({ claimId: row.id, messageId: uuid(99) })).status, 200);
  assert.equal(row.dm_refs.length, 4);
  for (const item of row.dm_refs) {
    assert.match(item.channelId, /^\d{17,20}$/);
    assert.match(item.messageId, /^\d{17,20}$/);
  }
  assert.equal(new Set(row.dm_refs.map(item => item.messageId)).size, 4);
});

test("dm_refs append failure is tolerated: DM still counts, log has claimId + code only", async () => {
  const row = claim(2);
  const db = fakeDb({ claims: [row], failUpdate: true });
  const claims = createAppPrizeClaims({ db, client: fakeClient(), recipientIds: OWNER });
  const { result, lines } = await captureConsole(() => claims.notify({ claimId: row.id }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, sent: 1 });
  assert.ok(lines.some(line => line.includes(row.id) && line.includes("XX000")));
  assertNoContact(lines);
});

test("dm_refs append is compare-and-set: a concurrent append is not overwritten", async () => {
  const row = claim(3, { dm_refs: [ref(1)] });
  let raced = false;
  const db = fakeDb({
    claims: [row],
    beforeUpdate(table, patch) {
      if (!raced && table === "app_prize_claims" && patch.dm_refs) { raced = true; row.dm_refs = [ref(1), ref(2)]; }
    },
  });
  const claims = createAppPrizeClaims({ db, client: fakeClient(), recipientIds: OWNER });
  await claims.notify({ claimId: row.id });
  assert.equal(row.dm_refs.length, 3);
  assert.deepEqual(row.dm_refs.slice(0, 2), [ref(1), ref(2)]);
});

test("purge selects only claims redeemed more than 7 days ago, deletes their DMs, then nulls contact", async () => {
  const old = claim(10, { dm_refs: [ref(1), ref(2)] });
  const recent = claim(11, { dm_refs: [ref(3)] });
  const unredeemed = claim(12, { dm_refs: [ref(4)] });
  const otherGuild = claim(13, { dm_refs: [ref(5)] });
  const gacha = claim(14, { source_type: "gacha", source_id: "777", dm_refs: [ref(6)] });
  const db = fakeDb({
    claims: [old, recent, unredeemed, otherGuild, gacha],
    redemptions: [
      redemption(old.source_id, 8), redemption(recent.source_id, 6),
      redemption(otherGuild.source_id, 30, { guild_id: "1501098191813214312" }),
      redemption("777", 9, { source_type: "gacha_item" }),
      redemption(unredeemed.source_id, 30, { source_type: "gacha_item" }), // wrong type: not this prize
    ],
  });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client });
  const { result, lines } = await captureConsole(() => claims.purgeExpired({ now: NOW }));
  assert.deepEqual(result, { purged: 2, deferred: 0, failed: 0 });
  assert.deepEqual(client.deleted, [route(ref(1)), route(ref(2)), route(ref(6))]);
  for (const row of [old, gacha]) {
    assert.equal(row.contact, null);
    assert.equal(row.contact_purged_at, NOW.toISOString());
    assert.deepEqual(row.dm_refs, []);
  }
  for (const row of [recent, unredeemed, otherGuild]) {
    assert.deepEqual(row.contact, CONTACT);
    assert.equal(row.contact_purged_at, null);
    assert.equal(row.dm_refs.length, 1);
  }
  // DMs are deleted before contact is nulled; the purge never reads contact.
  assert.ok(db.selects.every(item => !String(item.columns).split(",").includes("contact")));
  assertNoContact(lines);
});

test("purge rerun is idempotent: nothing left to delete or update", async () => {
  const row = claim(20, { dm_refs: [ref(1)] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 10)] });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client });
  await claims.purgeExpired({ now: NOW });
  const purgedAt = row.contact_purged_at;
  const updates = db.updates.length;
  const second = await claims.purgeExpired({ now: new Date(NOW.getTime() + DAY) });
  assert.deepEqual(second, { purged: 0, deferred: 0, failed: 0 });
  assert.equal(client.deleted.length, 1);
  assert.equal(db.updates.length, updates);
  assert.equal(row.contact_purged_at, purgedAt);
});

test("unknown message (10008) counts as deleted; other errors keep the ref for retry but still null contact", async () => {
  const gone = ref(1);
  const flaky = ref(2);
  const fine = ref(3);
  const row = claim(30, { dm_refs: [gone, flaky, fine] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 10)] });
  const client = fakeClient({ deleteErrors: { [route(gone)]: discordError(10008), [route(flaky)]: Object.assign(new Error("server"), { status: 500 }) } });
  const claims = createAppPrizeClaims({ db, client });
  const { result, lines } = await captureConsole(() => claims.purgeExpired({ now: NOW }));
  assert.equal(result.purged, 1);
  assert.deepEqual(client.deleted, [route(fine)]);
  assert.equal(row.contact, null);
  assert.deepEqual(row.dm_refs.map(({ channelId, messageId }) => ({ channelId, messageId })), [flaky]);
  assert.equal(row.dm_refs[0].failures, 1);
  assert.ok(lines.some(line => line.includes(row.id) && line.includes("500")));
  assertNoContact(lines);

  // Next run retries only the leftover DM and keeps the original purge time.
  delete client.rest;
  const later = fakeClient();
  const retry = createAppPrizeClaims({ db, client: later });
  await retry.purgeExpired({ now: new Date(NOW.getTime() + DAY) });
  assert.deepEqual(later.deleted, [route(flaky)]);
  assert.deepEqual(row.dm_refs, []);
  assert.equal(row.contact_purged_at, NOW.toISOString());
});

test("DMs recorded after the purge (customer reply) are deleted on the next run", async () => {
  const row = claim(40, { contact: null, contact_purged_at: ago(3), dm_refs: [ref(9)] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 12)] });
  const client = fakeClient();
  await createAppPrizeClaims({ db, client }).purgeExpired({ now: NOW });
  assert.deepEqual(client.deleted, [route(ref(9))]);
  assert.deepEqual(row.dm_refs, []);
  assert.equal(row.contact_purged_at, ago(3));
});

test("rejected claims are purged at created_at + 30 days, not before", async () => {
  const oldRejected = claim(50, { status: "rejected", created_at: ago(31), dm_refs: [ref(1)] });
  const newRejected = claim(51, { status: "rejected", created_at: ago(29), dm_refs: [ref(2)] });
  const db = fakeDb({ claims: [oldRejected, newRejected] });
  const client = fakeClient();
  await createAppPrizeClaims({ db, client }).purgeExpired({ now: NOW });
  assert.deepEqual(client.deleted, [route(ref(1))]);
  assert.equal(oldRejected.contact, null);
  assert.deepEqual(newRejected.contact, CONTACT);
});

test("purge is bounded to 100 claims per run", async () => {
  const rows = Array.from({ length: 130 }, (_, i) => claim(1000 + i));
  const db = fakeDb({ claims: rows, redemptions: rows.map(row => redemption(row.source_id, 10)) });
  const claims = createAppPrizeClaims({ db, client: fakeClient() });
  assert.equal((await claims.purgeExpired({ now: NOW })).purged, 100);
  assert.equal(rows.filter(row => row.contact === null).length, 100);
  assert.equal((await claims.purgeExpired({ now: NOW })).purged, 30);
});

test("a DM appended during the purge is not lost (purge update is compare-and-set)", async () => {
  const row = claim(60, { dm_refs: [ref(1)] });
  let raced = false;
  const db = fakeDb({
    claims: [row], redemptions: [redemption(row.source_id, 10)],
    beforeUpdate(table, patch) {
      if (!raced && "contact" in patch) { raced = true; row.dm_refs = [ref(1), ref(2)]; }
    },
  });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client });
  assert.deepEqual(await claims.purgeExpired({ now: NOW }), { purged: 0, deferred: 1, failed: 0 });
  assert.deepEqual(row.dm_refs, [ref(1), ref(2)]);
  await claims.purgeExpired({ now: NOW });
  assert.equal(row.contact, null);
  assert.deepEqual(row.dm_refs, []);
  assert.ok(client.deleted.includes(route(ref(2))));
});

test("purged claim: notify DM says 寄送資料已刪除 and the reply modal still works", async () => {
  const row = claim(70, { contact: null, contact_purged_at: ago(1) });
  const db = fakeDb({ claims: [row] });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client, recipientIds: OWNER });
  assert.equal((await claims.notify({ claimId: row.id })).status, 200);
  const embed = client.sent[0].payload.embeds[0].toJSON();
  assert.equal(embed.fields.find(field => field.name === "收件資料摘要").value, PURGED_CONTACT);
  assert.equal(PURGED_CONTACT, "寄送資料已刪除");

  const edits = [];
  const handled = await claims.handleInteraction({
    customId: `app_claim_reply_modal_${row.id}`, user: { id: OWNER },
    isModalSubmit: () => true, isButton: () => false,
    fields: { getTextInputValue: () => "已寄出" },
    async reply() { throw new Error("unexpected"); },
    async deferReply() {}, async editReply(payload) { edits.push(payload); },
  });
  assert.equal(handled, true);
  assert.equal(edits[0].content, "已送出，客人會在 APP 看到");
  assert.equal(db.inserted[0].row.body, "已寄出");
});

test("index.js runs the purge at startup and every 6 hours without overlap", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /createNonOverlappingTask\("領獎寄送資料清除", \(\) => appPrizeClaims\.purgeExpired\(\)\)/);
  assert.match(source, /prizeClaimPurgeTask\(\);/);
  assert.match(source, /setInterval\(prizeClaimPurgeTask, 6 \* 60 \* 60 \* 1000\)/);
});

const REDACTED = "（已依規定刪除）";
const alertsOf = client => client.sent.filter(item => typeof item.payload.content === "string" && item.payload.content.includes("無法自動刪除"));

test("purge redacts every message of the claim (customer and staff), idempotently", async () => {
  const row = claim(80, { dm_refs: [ref(1)] });
  const keep = claim(81);
  const messages = [
    { id: uuid(801), claim_id: row.id, sender: "customer", body: "改寄到台中市西屯區 1 號", created_at: ago(9) },
    { id: uuid(802), claim_id: row.id, sender: "staff", staff_id: OWNER, body: "好的，寄台中市西屯區 1 號", created_at: ago(9) },
    { id: uuid(803), claim_id: keep.id, sender: "customer", body: "還沒寄嗎", created_at: ago(1) },
  ];
  const db = fakeDb({ claims: [row, keep], messages, redemptions: [redemption(row.source_id, 10)] });
  const claims = createAppPrizeClaims({ db, client: fakeClient() });
  await claims.purgeExpired({ now: NOW });
  assert.deepEqual(messages.map(m => m.body), [REDACTED, REDACTED, "還沒寄嗎"]);
  assert.equal(row.contact, null);
  // A later customer reply DM (recorded ref) gets its DB copy redacted on the next run too.
  messages.push({ id: uuid(804), claim_id: row.id, sender: "customer", body: "電話改 0987654321", created_at: ago(0) });
  row.dm_refs = [ref(2)];
  await claims.purgeExpired({ now: NOW });
  assert.equal(messages[3].body, REDACTED);
  const before = db.updates.filter(u => u.table === "app_prize_claim_messages" && u.count > 0).length;
  await claims.purgeExpired({ now: NOW });
  assert.equal(db.updates.filter(u => u.table === "app_prize_claim_messages" && u.count > 0).length, before);
});

test("append failure alerts the owner list once per claim with a jump link and no contact data", async () => {
  const row = claim(90);
  const db = fakeDb({ claims: [row], failUpdate: true });
  const client = fakeClient();
  const claims = createAppPrizeClaims({ db, client, recipientIds: OWNER });
  const { lines } = await captureConsole(async () => {
    await claims.notify({ claimId: row.id });
    await claims.notify({ claimId: row.id });
  });
  const alerts = alertsOf(client);
  assert.equal(alerts.length, 1);
  const dm = client.sent.find(item => item.payload.embeds);
  assert.match(alerts[0].payload.content, new RegExp(`申請 ${row.id.slice(0, 8)}`));
  assert.ok(alerts[0].payload.content.startsWith("有一則 APP 領獎私訊無法自動刪除"));
  assert.ok(alerts[0].payload.content.includes("請手動刪除"));
  assert.match(alerts[0].payload.content, /https:\/\/discord\.com\/channels\/@me\/\d{17,20}\/\d{17,20}/);
  assert.ok(dm);
  for (const value of Object.values(CONTACT)) assert.ok(!alerts[0].payload.content.includes(value));
  assertNoContact(lines);
});

test("a DM delete that keeps failing alerts once after 4 runs; no repeat afterwards", async () => {
  const stuck = ref(1);
  const row = claim(100, { dm_refs: [stuck] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 10)] });
  const client = fakeClient({ deleteErrors: { [route(stuck)]: discordError(50001) } });
  const claims = createAppPrizeClaims({ db, client, recipientIds: OWNER });
  for (let run = 1; run <= 3; run += 1) {
    await claims.purgeExpired({ now: new Date(NOW.getTime() + run * 60 * 1000) });
    assert.equal(alertsOf(client).length, 0, `run ${run}`);
  }
  await claims.purgeExpired({ now: new Date(NOW.getTime() + 4 * 60 * 1000) });
  assert.equal(alertsOf(client).length, 1);
  assert.ok(alertsOf(client)[0].payload.content.includes(`https://discord.com/channels/@me/${stuck.channelId}/${stuck.messageId}`));
  assert.ok(row.dm_refs[0].alertedAt);
  await claims.purgeExpired({ now: new Date(NOW.getTime() + 5 * 60 * 1000) });
  assert.equal(alertsOf(client).length, 1);
  assert.equal(row.contact, null);
});

test("a DM delete failing for more than 24 h alerts even before 4 runs", async () => {
  const stuck = ref(1);
  const row = claim(101, { dm_refs: [stuck] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 10)] });
  const client = fakeClient({ deleteErrors: { [route(stuck)]: discordError(50001) } });
  const claims = createAppPrizeClaims({ db, client, recipientIds: OWNER });
  await claims.purgeExpired({ now: NOW });
  assert.equal(alertsOf(client).length, 0);
  await claims.purgeExpired({ now: new Date(NOW.getTime() + DAY + 1000) });
  assert.equal(alertsOf(client).length, 1);
});

test("the scan pages past more than 1000 never-due rows to find a due claim", async () => {
  const notDue = Array.from({ length: 1200 }, (_, i) => claim(2000 + i, { dm_refs: [ref(i)] }));
  const due = claim(9999, { dm_refs: [ref(7)] });
  const db = fakeDb({ claims: [...notDue, due], redemptions: [redemption(due.source_id, 10)] });
  const client = fakeClient();
  const result = await createAppPrizeClaims({ db, client }).purgeExpired({ now: NOW });
  assert.equal(result.purged, 1);
  assert.equal(due.contact, null);
  assert.deepEqual(client.deleted, [route(ref(7))]);
});

test("claims still holding contact are purged before leftover-ref retries", async () => {
  const leftovers = Array.from({ length: 100 }, (_, i) => claim(3000 + i, {
    contact: null, contact_purged_at: ago(3), dm_refs: [ref(i)] }));
  const fresh = claim(9000, { dm_refs: [ref(500)] });
  const db = fakeDb({ claims: [...leftovers, fresh], redemptions: [...leftovers, fresh].map(c => redemption(c.source_id, 10)) });
  const client = fakeClient({ deleteErrors: Object.fromEntries(leftovers.map((_, i) => [route(ref(i)), discordError(50001)])) });
  await createAppPrizeClaims({ db, client, recipientIds: OWNER }).purgeExpired({ now: NOW });
  assert.equal(fresh.contact, null);
});

test("refs that do not point at a DM channel are skipped and dropped, never deleted", async () => {
  const guildRef = ref(1, "310000000000000001");
  const dmRef = ref(2);
  const row = claim(110, { dm_refs: [guildRef, dmRef] });
  const db = fakeDb({ claims: [row], redemptions: [redemption(row.source_id, 10)] });
  const client = fakeClient({ channelTypes: { [guildRef.channelId]: 0 } });
  await createAppPrizeClaims({ db, client }).purgeExpired({ now: NOW });
  assert.deepEqual(client.deleted, [route(dmRef)]);
  assert.deepEqual(row.dm_refs, []);
  assert.equal(row.contact, null);
});
