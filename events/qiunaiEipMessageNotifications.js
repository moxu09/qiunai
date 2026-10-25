const { createHash } = require("node:crypto");

const TABLE = "qiunai_eip_message_notifications";
const PORTAL_URL = "https://qiunai.wearestilllhere.com/staff";
const STALE_MS = 5 * 60 * 1000;

function notificationNonce(messageId) {
  return `qm${createHash("sha256").update(messageId).digest("hex").slice(0, 20)}`;
}

function buildMessageReminder(row) {
  const link = new URL(PORTAL_URL);
  link.searchParams.set("chat", row.sender_discord_id);
  link.searchParams.set("notice", row.message_id);
  return `📨 小奈提醒你：EIP 有一則新的員工訊息。\n點此開啟對話：${link}`;
}

async function updateDelivery(supabase, messageId, values) {
  const { error } = await supabase.from(TABLE).update(values).eq("message_id", messageId);
  if (error) throw error;
}

async function findDelivered(channel, client, content) {
  const recent = await channel.messages.fetch({ limit: 50 });
  return recent.find((message) => message.author?.id === client.user?.id && message.content === content) || null;
}

async function deliverOne(supabase, client, row) {
  const now = new Date().toISOString();
  const content = buildMessageReminder(row);
  if (row.status === "sending") {
    if (Date.now() - new Date(row.attempted_at || 0).getTime() < STALE_MS) return;
    try {
      const user = await client.users.fetch(row.recipient_discord_id);
      const channel = await user.createDM();
      const existing = await findDelivered(channel, client, content);
      if (existing) {
        await updateDelivery(supabase, row.message_id, {
          status: "sent", dm_message_id: existing.id,
          sent_at: existing.createdAt.toISOString(), last_error: null,
        });
        return;
      }
    } catch (error) {
      if ([50007, 10013].includes(Number(error?.code))) {
        await updateDelivery(supabase, row.message_id, {
          status: "failed", last_error: String(error?.message || error).slice(0, 500),
        });
        return;
      }
      throw error;
    }
    const { error } = await supabase.from(TABLE).update({ status: "pending" })
      .eq("message_id", row.message_id).eq("status", "sending")
      .eq("attempted_at", row.attempted_at);
    if (error) throw error;
  }

  const { data: claimed, error: claimError } = await supabase.from(TABLE)
    .update({ status: "sending", attempted_at: now, attempt_count: row.attempt_count + 1 })
    .eq("message_id", row.message_id).eq("status", "pending")
    .select("message_id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  try {
    const user = await client.users.fetch(row.recipient_discord_id);
    const channel = await user.createDM();
    if (row.attempt_count > 0) {
      const existing = await findDelivered(channel, client, content);
      if (existing) {
        await updateDelivery(supabase, row.message_id, {
          status: "sent", dm_message_id: existing.id,
          sent_at: existing.createdAt.toISOString(), last_error: null,
        });
        return;
      }
    }
    const sent = await channel.send({
      content,
      nonce: notificationNonce(row.message_id),
      enforceNonce: true,
      allowedMentions: { parse: [] },
    });
    await updateDelivery(supabase, row.message_id, {
      status: "sent", dm_message_id: sent.id,
      sent_at: new Date().toISOString(), last_error: null,
    });
  } catch (error) {
    const permanent = [50007, 10013].includes(Number(error?.code));
    await updateDelivery(supabase, row.message_id, {
      status: permanent || row.attempt_count + 1 >= 3 ? "failed" : "pending",
      last_error: String(error?.message || error).slice(0, 500),
    });
    console.warn(`[EIP 訊息提醒] ${row.message_id} 無法發送：${error?.message || error}`);
  }
}

async function processPendingEipMessageNotifications(supabase, client) {
  const { data, error } = await supabase.from(TABLE)
    .select("message_id,sender_discord_id,recipient_discord_id,status,attempt_count,attempted_at")
    .in("status", ["pending", "sending"]).order("created_at").limit(20);
  if (error) throw error;
  for (const row of data || []) {
    try {
      await deliverOne(supabase, client, row);
    } catch (cause) {
      console.error(`[EIP 訊息提醒] ${row.message_id} 處理失敗`, cause);
    }
  }
}

function startQiunaiEipMessageNotificationScheduler(supabase, client, createNonOverlappingTask) {
  const run = createNonOverlappingTask("秋奈 EIP 私訊提醒", () =>
    processPendingEipMessageNotifications(supabase, client));
  const timer = setInterval(run, 15 * 1000);
  timer.unref?.();
  void run();
  return timer;
}

module.exports = {
  buildMessageReminder,
  notificationNonce,
  processPendingEipMessageNotifications,
  startQiunaiEipMessageNotificationScheduler,
};
