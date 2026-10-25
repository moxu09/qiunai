const test = require("node:test");
const assert = require("node:assert/strict");
const { getStoreConsumptionField, addStoreConsumptionField } = require("../utils/storeConsumption");

function database(data, error = null) {
  const calls = [];
  const query = {
    select(fields) { calls.push(["select", fields]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); return this; },
    async maybeSingle() { return { data, error }; },
  };
  return { calls, from(table) { calls.push(["from", table]); return query; } };
}

test("本店 VIP 累積以店家及目標會員雙重篩選，不混算聯盟或錢包", async () => {
  const db = database({ total_spent: "12345.67" });
  const field = await getStoreConsumptionField(db, "1206138511535898654", "639853626705313848");
  assert.match(field.value, /12,345.67 ASD/);
  assert.deepEqual(db.calls, [
    ["from", "user_vips"], ["select", "total_spent"],
    ["eq", "guild_id", "1206138511535898654"], ["eq", "user_id", "639853626705313848"],
  ]);
});
test("查無本店 VIP 紀錄才顯示零，保留合法小數", async () => {
  assert.match((await getStoreConsumptionField(database(null), "store", "user")).value, /0 ASD/);
  assert.match((await getStoreConsumptionField(database({total_spent: 1.25}), "store", "user")).value, /1.25 ASD/);
});
test("員工群查詢對應秋奈店家，與大群顯示同一筆累積", async () => {
  const businessGuildId = "1206138511535898654", staffGuildId = "1513174069087047731";
  const config = {businessGuildId, staffGuildId};
  for (const guildId of [businessGuildId, staffGuildId]) {
    const db = database({total_spent: 209654});
    const fields = [];
    await addStoreConsumptionField({addFields: f => fields.push(f)},
      {db, guildId, userId: "847840193859682304", ...config});
    assert.match(fields[0].value, /209,654 ASD/);
    assert(db.calls.some(call => call[0] === "eq" && call[1] === "guild_id" && call[2] === businessGuildId));
    assert(!db.calls.some(call => call[1] === "guild_id" && call[2] === staffGuildId));
  }
});
test("員工群對應不跨到其他店家，也不能在私訊套用店家", async () => {
  const config = {businessGuildId: "1206138511535898654", staffGuildId: "1513174069087047731"};
  const db = database({total_spent: 100});
  await getStoreConsumptionField(db, "1501098191813214312", "user", config);
  assert(db.calls.some(call => call[1] === "guild_id" && call[2] === "1501098191813214312"));
  await assert.rejects(getStoreConsumptionField(db, null, "user", config), /缺少/);
});
test("錯誤不偽裝為零，也不破壞原有聯盟查詢內容", async () => {
  for (const db of [database(null, Error("database offline")), database({total_spent: "invalid"}), database({total_spent: -10})]) {
    const fields = [{name: "原有欄位", value: "保留"}], errors = [];
    await addStoreConsumptionField({addFields: field => fields.push(field)},
      {db, guildId: "store", userId: "user", logger: {error: (...args) => errors.push(args)}});
    assert.equal(fields.length, 2); assert.equal(fields[0].value, "保留");
    assert.match(fields[1].value, /暫時無法取得/); assert.equal(errors.length, 1);
  }
});
test("沒有店家或會員時不執行未限定範圍的查詢", async () => {
  const db = database(null);
  await assert.rejects(getStoreConsumptionField(db, null, "user"), /缺少/);
  await assert.rejects(getStoreConsumptionField(db, "store", null), /缺少/);
  assert.equal(db.calls.length, 0);
});
test("正式指令只在查詢累積加本店欄位，沿用被查詢對象", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../index.js"), "utf8");
  assert.match(source, /if \(interaction.commandName === "查詢累積"\) \{\s+await require\("\.\/utils\/storeConsumption"\)\.addStoreConsumptionField\(embed, \{\s+db: supabase, guildId: interaction.guildId, userId: target.id,/);
  assert.match(source, /businessGuildId: process.env.GUILD_ID \|\| "1206138511535898654",\s+staffGuildId: QIUNAI_STAFF_GUILD_ID,/);
});
