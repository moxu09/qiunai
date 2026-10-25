const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField } = require('discord.js');
const { STAFF_GUILD_ID, BUSINESS_GUILD_ID, taipeiPeriod, isDispatchTime, acceptedStaffToday, readLinks, planTargets, buildNotice, alreadySent, processNasNotifications } = require('../events/qiunaiNasUploadNotifications');
const id = '111111111111111111', second = '222222222222222222';
const links = [{ discord_id: id, url: 'https://ug.link/test-device/filemgr/collect-invite/?id=testfixture' }];
const dailyLinks = [{ date: '2026-10-17', url: links[0].url }];
function channel(owner = id, channelId = '333333333333333333') {
  const messages = new Collection(); let sends = 0;
  return { id: channelId, type: 0, name: '填單專區-test',
    permissionOverwrites: { cache: new Collection([
      [STAFF_GUILD_ID, { deny: new PermissionsBitField(1024n) }],
      [owner, { allow: new PermissionsBitField(1024n), deny: new PermissionsBitField(0n) }],
    ]) }, messages: { fetch: async () => messages },
    send: async payload => { sends++; const m = { id: 'm1', author: { id: 'bot' }, content: payload.content, createdTimestamp: Date.parse('2026-10-17T15:00:00Z') }; messages.set(m.id, m); return m; },
    get sends() { return sends; },
  };
}
test('台北 23:30 才派送，提前與跨日均不查 DB', async () => {
  assert.deepEqual(taipeiPeriod(new Date('2026-10-17T15:30:00Z')), { date: '2026-10-17', hour: 23, minute: 30 });
  assert.equal(isDispatchTime(taipeiPeriod(new Date('2026-10-17T15:30:00Z'))), true);
  for (const time of ['2026-10-17T14:59:59Z', '2026-10-17T15:00:00Z', '2026-10-17T15:29:59Z', '2026-10-17T16:00:00Z']) {
    assert.equal((await processNasNotifications({}, {}, { now: new Date(time), links })).scheduled, false);
  }
});
test('連結設定不可空白、重複或指向其他網站', () => {
  assert.equal(readLinks(JSON.stringify(dailyLinks)).length, 1);
  assert.throws(() => readLinks('[]'));
  assert.throws(() => readLinks(JSON.stringify([...dailyLinks, ...dailyLinks])));
  assert.throws(() => readLinks(JSON.stringify([{ discord_id: id, url: 'https://example.com/sharing/test' }])));
  assert.throws(() => readLinks(JSON.stringify([{ date: '2026-10-17', url: 'http://weareatilllhere.quickconnect.to/sharing/testfixture' }])));
  assert.throws(() => readLinks(JSON.stringify([{ date: '2026-10-17', url: 'https://ug.link/admin' }])));
});
test('只配對本人私有填單區，離職、離群、錯誤權限都略過', () => {
  const c = channel(), staff = [{ discord_id: id, is_active: true, salary_channel_id: c.id }], channels = new Collection([[c.id, c]]), members = new Set([id]);
  assert.equal(planTargets(links, staff, channels, members).targets.length, 1);
  assert.equal(planTargets(links, [{ ...staff[0], is_active: false }], channels, members).targets.length, 0);
  assert.equal(planTargets(links, staff, channels, new Set()).targets.length, 0);
  c.permissionOverwrites.cache.delete(id);
  assert.equal(planTargets(links, staff, channels, members).targets.length, 0);
});
test('多人共用填單區兩人都跳過，不洩露任何個人連結', () => {
  const c = channel(); c.permissionOverwrites.cache.set(second, { allow: new PermissionsBitField(1024n), deny: new PermissionsBitField(0n) });
  const plan = planTargets([...links, { ...links[0], discord_id: second }], [id, second].map(discord_id => ({ discord_id, salary_channel_id: c.id })), new Collection([[c.id, c]]), new Set([id, second]));
  assert.equal(plan.targets.length, 0); assert.equal(plan.skipped.length, 2);
});
test('當日訊息與 nonce 固定，沒有其他員工或全體提醒', () => {
  const a = buildNotice(links[0], '2026-10-17'), b = buildNotice(links[0], '2026-10-17');
  assert.equal(a.nonce, b.nonce); assert.equal(a.enforceNonce, true);
  assert.match(a.content, /今天（2026-10-17）/); assert.deepEqual(a.allowedMentions, { parse: [] });
  assert.match(a.content, /UGREEN/); assert.match(a.content, /上傳時請填寫你的陪陪名稱/);
  assert.doesNotMatch(a.content, /專屬連結|僅供本人/);
});
test('23:30 僅通知當日接單者；重啟去重；dry-run 不發送', async () => {
  const c = channel(), client = { user: { id: 'bot' }, guilds: { fetch: async () => ({ channels: { fetch: async () => new Collection([[c.id, c]]) } }) }, rest: { get: async () => [{ user: { id } }] } };
  const db = mockDb([{ assigned_player: id, status: 'completed', order_type: '訂單' }], [{ discord_id: id, salary_channel_id: c.id }, { discord_id: second }]);
  const options = { now: new Date('2026-10-17T15:30:00Z'), links: dailyLinks };
  assert.equal((await processNasNotifications(db, client, { ...options, dryRun: true })).eligible, 1); assert.equal(c.sends, 0);
  assert.equal((await processNasNotifications(db, client, options)).sent, 1);
  assert.equal((await processNasNotifications(db, client, options)).alreadySent, 1); assert.equal(c.sends, 1);
  assert.equal(await alreadySent(c, 'bot', '2026-10-18'), false);
});
test('缺少當天 UGREEN 日期時不借用昨日連結，也不查資料庫', async () => {
  await assert.rejects(processNasNotifications({}, {}, { now: new Date('2026-10-18T15:30:00Z'), links: dailyLinks }), /缺少 2026-10-18/);
});

function mockDb(orders, staff = []) {
  return { from(table) {
    if (table === 'qiunai_staff') return { select: async () => ({ data: staff, error: null }) };
    assert.equal(table, 'play_orders');
    const query = {
      select: () => query,
      eq: (key, value) => { assert.equal(key, 'guild_id'); assert.equal(value, BUSINESS_GUILD_ID); return query; },
      gte: (key, value) => { assert.equal(key, 'accepted_at'); assert.equal(value, '2026-10-16T16:00:00.000Z'); return query; },
      lt: (key, value) => { assert.equal(key, 'accepted_at'); assert.equal(value, '2026-10-17T16:00:00.000Z'); return query; },
      order: () => query,
      range: async (start, end) => ({ data: orders.slice(start, end + 1), error: null }),
    }; return query;
  }};
}
test('接單名單拆分多人並去重，排除打賞、取消、退款與刪除單', async () => {
  const result = await acceptedStaffToday(mockDb([
    { assigned_player: `${id}, ${second}`, order_type: '訂單', status: 'accepted' },
    { assigned_player: id, order_type: '訂單', status: 'completed' },
    ...['打賞', '儲值'].map(order_type => ({ assigned_player: '999999999999999999', order_type })),
    ...['cancelled', 'refunded', '訂單棄單'].map(status => ({ assigned_player: '999999999999999999', status })),
    { assigned_player: '999999999999999999', is_deleted: true },
  ]), '2026-10-17');
  assert.deepEqual([...result].sort(), [id, second]);
});
test('接單查詢失敗必須停止，不退回全員通知', async () => {
  const db = mockDb([]); const original = db.from;
  db.from = table => {
    const query = original(table);
    if (table === 'play_orders') query.range = async () => ({ data: null, error: { message: 'failed' } });
    return query;
  };
  await assert.rejects(acceptedStaffToday(db, '2026-10-17'), /停止 NAS 派送/);
});
test('接單超過一頁仍查完，不漏掉末頁人員', async () => {
  const orders = Array.from({ length: 1000 }, () => ({ assigned_player: id }));
  orders.push({ assigned_player: second });
  assert.deepEqual([...await acceptedStaffToday(mockDb(orders), '2026-10-17')].sort(), [id, second]);
});
test('同頻道另一人當日沒接單，也必須辨識共用頻道並停止派送', async () => {
  const c = channel();
  c.permissionOverwrites.cache.set(second, { allow: new PermissionsBitField(1024n), deny: new PermissionsBitField(0n) });
  const client = { user: { id: 'bot' }, guilds: { fetch: async () => ({ channels: { fetch: async () => new Collection([[c.id, c]]) } }) }, rest: { get: async () => [id, second].map(id => ({ user: { id } })) } };
  const db = mockDb([{ assigned_player: id, status: 'accepted' }], [id, second].map(discord_id => ({ discord_id, salary_channel_id: c.id })));
  const summary = await processNasNotifications(db, client, { now: new Date('2026-10-17T15:30:00Z'), links: dailyLinks });
  assert.equal(summary.eligible, 0);
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped[0].reason, '多人共用填單區');
});
test('同日舊 Synology 通知不阻擋修正後的 UGREEN 通知', async () => {
  const c = channel(); c.messages.fetch = async () => new Collection([['old', { id: 'old', author: { id: 'bot' }, content: '【NAS 當日影片上傳｜2026-10-17】', createdTimestamp: Date.parse('2026-10-17T15:00:00Z') }]]);
  assert.equal(await alreadySent(c, 'bot', '2026-10-17'), false);
});
