const DEFAULT_CUSTOMER_SERVICE_ROLE_ID = "1210642900355125288";
const CUSTOMER_SERVICE_RECEPTION_PAY = 10;
const QIUNAI_SHIFT_CUSTOMER_SERVICE_IDS = Object.freeze([
  "808875987034308618",
  "450464694818439170",
  "1145529569017872394",
]);
const QIUNAI_SUPPORT_CUSTOMER_SERVICE_IDS = Object.freeze([
  "607493124746379274",
  "801749981312581643",
  "519157080503091211",
]);
const QIUNAI_CUSTOMER_SERVICE_IDS = Object.freeze([
  ...QIUNAI_SHIFT_CUSTOMER_SERVICE_IDS,
  ...QIUNAI_SUPPORT_CUSTOMER_SERVICE_IDS,
]);

function hasCustomerServicePointRole(interaction, roleId = DEFAULT_CUSTOMER_SERVICE_ROLE_ID) {
  const resolvedRoleId = String(roleId || DEFAULT_CUSTOMER_SERVICE_ROLE_ID);
  const roles = interaction?.member?.roles;
  if (roles?.cache?.has?.(resolvedRoleId)) return true;
  if (Array.isArray(roles)) return roles.includes(resolvedRoleId);
  return false;
}

async function recordCustomerServicePoint(
  supabase,
  { appKey, orderId, discordId, servedAt = new Date().toISOString() },
) {
  if (!supabase || !appKey || !orderId || !discordId) return false;

  const { error } = await supabase.from("customer_service_order_points").upsert(
    {
      app_key: String(appKey),
      order_id: String(orderId),
      discord_id: String(discordId),
      points: 1,
      served_at: servedAt,
    },
    { onConflict: "app_key,order_id", ignoreDuplicates: true },
  );

  if (error) throw error;
  return true;
}

function calculateCustomerServiceReceptionPay(count) {
  const normalizedCount = Number(count);
  if (!Number.isInteger(normalizedCount) || normalizedCount <= 0) {
    throw new Error("客服接待件數必須是大於 0 的整數");
  }
  return normalizedCount * CUSTOMER_SERVICE_RECEPTION_PAY;
}

function getSeptemberShiftCommissionRate(discordId, finishedAt) {
  if (!QIUNAI_SHIFT_CUSTOMER_SERVICE_IDS.includes(String(discordId || ""))) {
    return null;
  }

  const timestamp = new Date(finishedAt).getTime();
  const startsAt = new Date("2026-09-01T00:00:00+08:00").getTime();
  const endsAt = new Date("2026-10-01T00:00:00+08:00").getTime();
  return timestamp >= startsAt && timestamp < endsAt ? 85 : null;
}

async function recordCustomerServiceReception(
  supabase,
  {
    appKey,
    interactionId,
    discordId,
    staffName,
    count,
    recordedBy,
    note,
    servedAt = new Date().toISOString(),
  },
) {
  if (!supabase || !appKey || !interactionId || !discordId) {
    throw new Error("客服接待紀錄缺少必要資料");
  }

  const normalizedCount = Number(count);
  const amount = calculateCustomerServiceReceptionPay(normalizedCount);
  const orderId = `manual:${interactionId}`;
  const { data: pointRow, error: pointError } = await supabase
    .from("customer_service_order_points")
    .insert({
      app_key: String(appKey),
      order_id: orderId,
      discord_id: String(discordId),
      points: normalizedCount,
      served_at: servedAt,
    })
    .select("id")
    .single();
  if (pointError) throw pointError;

  const noteParts = [
    `接待 ${normalizedCount} 件`,
    `登錄人：${recordedBy || discordId}`,
    `指令紀錄：${interactionId}`,
    String(note || "").trim(),
  ].filter(Boolean);
  const { error: bonusError } = await supabase.from("qiunai_staff_bonus").insert({
    discord_id: String(discordId),
    staff_name: staffName || null,
    title: "客服接待件數薪資",
    amount,
    note: noteParts.join("；"),
    created_at: servedAt,
  });

  if (bonusError) {
    if (pointRow?.id) {
      await supabase
        .from("customer_service_order_points")
        .delete()
        .eq("id", pointRow.id);
    }
    throw bonusError;
  }

  return { count: normalizedCount, amount, orderId };
}

module.exports = {
  CUSTOMER_SERVICE_RECEPTION_PAY,
  DEFAULT_CUSTOMER_SERVICE_ROLE_ID,
  QIUNAI_CUSTOMER_SERVICE_IDS,
  QIUNAI_SHIFT_CUSTOMER_SERVICE_IDS,
  QIUNAI_SUPPORT_CUSTOMER_SERVICE_IDS,
  calculateCustomerServiceReceptionPay,
  getSeptemberShiftCommissionRate,
  hasCustomerServicePointRole,
  recordCustomerServiceReception,
  recordCustomerServicePoint,
};
