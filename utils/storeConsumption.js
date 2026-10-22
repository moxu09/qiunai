async function getStoreConsumptionField(db, guildId, userId, { businessGuildId, staffGuildId } = {}) {
  if (!guildId || !userId) throw new Error("缺少店家或會員資料");
  // An employee server belongs to its business server; it has no VIP ledger.
  // Only map the explicitly configured employee server, never another store.
  const storeGuildId = businessGuildId && staffGuildId && String(guildId) === String(staffGuildId)
    ? String(businessGuildId) : String(guildId);
  const { data, error } = await db.from("user_vips")
    .select("total_spent").eq("guild_id", storeGuildId)
    .eq("user_id", String(userId)).maybeSingle();
  if (error) throw error;
  const amount = Number(data?.total_spent ?? 0);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("本店累積消費資料異常");
  return {
    name: "本店累積消費",
    value: `**${amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} ASD**\n依本店 VIP 消費累積紀錄；不含其他店家。`,
  };
}

async function addStoreConsumptionField(embed, { db, guildId, userId, businessGuildId, staffGuildId, logger = console }) {
  try {
    embed.addFields(await getStoreConsumptionField(db, guildId, userId, { businessGuildId, staffGuildId }));
  } catch (error) {
    logger.error("[查詢累積｜本店消費]", error.message);
    embed.addFields({ name: "本店累積消費", value: "暫時無法取得，請稍後再試。" });
  }
}

module.exports = { getStoreConsumptionField, addStoreConsumptionField };
