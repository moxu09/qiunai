const { createHash } = require("node:crypto");

const ANNOUNCEMENT_CHANNEL_ID =
  process.env.QIUNAI_ACTIVITY_ANNOUNCEMENT_CHANNEL_ID || "1513185192968454324";
const STAFF_PORTAL_URL = "https://qiunai.wearestilllhere.com/staff";
const BATCH_SIZE = 20;
const STALE_CLAIM_MS = 5 * 60 * 1000;

function taipeiDate(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(value));
}

function notificationNonce(activityId, recipientId = "announcement") {
  return `qa${createHash("sha256").update(`${activityId}:${recipientId}`).digest("hex").slice(0, 20)}`;
}

function buildActivityAnnouncement(activity, options = []) {
  const lines = [
    "📣 秋奈電競｜新活動公告",
    `**${activity.title}**`,
    activity.location ? `地點：${activity.location}` : null,
    `活動時間：${taipeiDate(activity.starts_at)}`,
    `回覆截止：${taipeiDate(activity.response_deadline)}`,
    options.length ? `參與選項：${options.map((item) => item.label).join("、")}` : null,
    activity.description ? `\n活動內容：\n${activity.description.slice(0, 1000)}` : null,
    "\n請至秋奈 EIP 的「活動報名」查看資格與完整內容，並在截止前回覆：",
    STAFF_PORTAL_URL,
  ];
  return lines.filter(Boolean).join("\n").slice(0, 1950);
}

function buildActivityDm(activity, options = []) {
  return [
    "小奈通知你：秋奈有新活動囉！",
    buildActivityAnnouncement(activity, options),
  ].join("\n\n").slice(0, 1950);
}

async function updateNotification(supabase, activityId, values) {
  const { error } = await supabase.from("qiunai_activity_notifications")
    .update(values).eq("activity_id", activityId);
  if (error) throw error;
}

async function updateDelivery(supabase, activityId, discordId, values) {
  const { error } = await supabase.from("qiunai_activity_notification_deliveries")
    .update(values).eq("activity_id", activityId).eq("discord_id", discordId);
  if (error) throw error;
}

async function findSentMessage(channel, client, content) {
  const messages = await channel.messages.fetch({ limit: 50 });
  return messages.find((message) =>
    message.author?.id === client.user?.id && message.content === content,
  ) || null;
}

async function sendAnnouncement(supabase, client, notification, activity, options) {
  if (notification.announcement_status === "sent") return true;
  const channel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
  if (!channel?.isTextBased?.() || !channel.send) {
    throw new Error(`找不到秋奈員工群公告頻道 ${ANNOUNCEMENT_CHANNEL_ID}`);
  }
  const content = buildActivityAnnouncement(activity, options);
  if (notification.announcement_status === "pending" && notification.announcement_attempted_at) {
    const existing = await findSentMessage(channel, client, content);
    if (existing) {
      await updateNotification(supabase, activity.id, {
        announcement_status: "sent", announcement_message_id: existing.id,
        announcement_sent_at: existing.createdAt.toISOString(), last_error: null,
      });
      return true;
    }
  }
  if (notification.announcement_status === "sending") {
    const stale = Date.now() - new Date(notification.announcement_attempted_at || 0).getTime() > STALE_CLAIM_MS;
    if (!stale) return false;
    const existing = await findSentMessage(channel, client, content);
    if (existing) {
      await updateNotification(supabase, activity.id, {
        announcement_status: "sent", announcement_message_id: existing.id,
        announcement_sent_at: existing.createdAt.toISOString(), last_error: null,
      });
      return true;
    }
    const { error } = await supabase.from("qiunai_activity_notifications")
      .update({ announcement_status: "pending" }).eq("activity_id", activity.id)
      .eq("announcement_status", "sending")
      .eq("announcement_attempted_at", notification.announcement_attempted_at);
    if (error) throw error;
  }
  const { data: claimed, error: claimError } = await supabase.from("qiunai_activity_notifications")
    .update({ announcement_status: "sending", announcement_attempted_at: new Date().toISOString() })
    .eq("activity_id", activity.id).eq("announcement_status", "pending")
    .select("activity_id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return false;
  try {
    const message = await channel.send({
      content,
      nonce: notificationNonce(activity.id),
      enforceNonce: true,
      allowedMentions: { parse: [] },
    });
    await updateNotification(supabase, activity.id, {
      announcement_status: "sent", announcement_message_id: message.id,
      announcement_sent_at: new Date().toISOString(), last_error: null,
    });
    console.log(`[活動通知] 員工群公告已發送：${activity.title} (${message.id})`);
    return true;
  } catch (error) {
    await updateNotification(supabase, activity.id, {
      announcement_status: "pending", last_error: String(error?.message || error).slice(0, 500),
    });
    throw error;
  }
}

async function prepareRecipients(supabase, activityId) {
  const { data: notification, error: notificationError } = await supabase
    .from("qiunai_activity_notifications").select("recipients_prepared_at")
    .eq("activity_id", activityId).single();
  if (notificationError) throw notificationError;
  if (notification.recipients_prepared_at) return;
  const { data: staff, error: staffError } = await supabase.from("qiunai_staff")
    .select("discord_id").eq("is_active", true).eq("can_take_order", true)
    .not("discord_id", "is", null).limit(1000);
  if (staffError) throw staffError;
  if (staff.length === 1000) throw new Error("陪陪名單可能超過 1000 位，停止通知以避免漏發");
  const recipients = [...new Set(staff.map((item) => String(item.discord_id).trim()).filter(Boolean))];
  if (recipients.length) {
    const { error } = await supabase.from("qiunai_activity_notification_deliveries")
      .upsert(recipients.map((discordId) => ({ activity_id: activityId, discord_id: discordId })), {
        onConflict: "activity_id,discord_id", ignoreDuplicates: true,
      });
    if (error) throw error;
  }
  await updateNotification(supabase, activityId, { recipients_prepared_at: new Date().toISOString() });
  console.log(`[活動通知] ${activityId} 已建立 ${recipients.length} 位陪陪的私訊清單`);
}

async function deliverDm(supabase, client, activity, options, delivery) {
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("qiunai_activity_notification_deliveries")
    .update({ status: "sending", attempted_at: now, attempt_count: delivery.attempt_count + 1 })
    .eq("activity_id", activity.id).eq("discord_id", delivery.discord_id)
    .eq("status", "pending").select("discord_id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;
  const content = buildActivityDm(activity, options);
  try {
    const user = await client.users.fetch(delivery.discord_id);
    const channel = await user.createDM();
    if (delivery.attempt_count > 0) {
      const existing = await findSentMessage(channel, client, content);
      if (existing) {
        await updateDelivery(supabase, activity.id, delivery.discord_id, {
          status: "sent", dm_message_id: existing.id,
          sent_at: existing.createdAt.toISOString(), last_error: null,
        });
        return;
      }
    }
    const message = await channel.send({
      content,
      nonce: notificationNonce(activity.id, delivery.discord_id),
      enforceNonce: true,
      allowedMentions: { parse: [] },
    });
    await updateDelivery(supabase, activity.id, delivery.discord_id, {
      status: "sent", dm_message_id: message.id,
      sent_at: new Date().toISOString(), last_error: null,
    });
  } catch (error) {
    const permanent = [50007, 10013].includes(Number(error?.code));
    await updateDelivery(supabase, activity.id, delivery.discord_id, {
      status: permanent || delivery.attempt_count + 1 >= 3 ? "failed" : "pending",
      last_error: String(error?.message || error).slice(0, 500),
    });
  }
}

async function recoverStaleDeliveries(supabase, client, activity, options) {
  const threshold = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: stale, error } = await supabase.from("qiunai_activity_notification_deliveries")
    .select("discord_id,attempted_at").eq("activity_id", activity.id)
    .eq("status", "sending").lt("attempted_at", threshold).limit(BATCH_SIZE);
  if (error) throw error;
  const content = buildActivityDm(activity, options);
  for (const delivery of stale || []) {
    try {
      const user = await client.users.fetch(delivery.discord_id);
      const channel = await user.createDM();
      const existing = await findSentMessage(channel, client, content);
      if (existing) {
        await updateDelivery(supabase, activity.id, delivery.discord_id, {
          status: "sent", dm_message_id: existing.id,
          sent_at: existing.createdAt.toISOString(), last_error: null,
        });
      } else {
        const { error: resetError } = await supabase.from("qiunai_activity_notification_deliveries")
          .update({ status: "pending" }).eq("activity_id", activity.id)
          .eq("discord_id", delivery.discord_id).eq("status", "sending")
          .eq("attempted_at", delivery.attempted_at);
        if (resetError) throw resetError;
      }
    } catch (error) {
      if ([50007, 10013].includes(Number(error?.code))) {
        await updateDelivery(supabase, activity.id, delivery.discord_id, {
          status: "failed", last_error: String(error?.message || error).slice(0, 500),
        });
        continue;
      }
      console.warn(`[活動通知] 私訊狀態復原失敗 ${delivery.discord_id}: ${error?.message || error}`);
    }
  }
}

async function processActivityNotification(supabase, client, notification) {
  const { data: activity, error: activityError } = await supabase.from("qiunai_activities")
    .select("id,title,description,location,starts_at,response_deadline,is_published")
    .eq("id", notification.activity_id).maybeSingle();
  if (activityError) throw activityError;
  if (!activity?.is_published) return;
  if (new Date(activity.response_deadline).getTime() <= Date.now()) {
    const reason = "回覆截止時間已過，等待管理員修正日期，未發送通知";
    if (notification.last_error !== reason) await updateNotification(supabase, activity.id, { last_error: reason });
    return;
  }
  const { data: options, error: optionError } = await supabase.from("qiunai_activity_options")
    .select("label").eq("activity_id", activity.id).order("sort_order");
  if (optionError) throw optionError;
  if (!await sendAnnouncement(supabase, client, notification, activity, options || [])) return;
  await prepareRecipients(supabase, activity.id);
  await recoverStaleDeliveries(supabase, client, activity, options || []);
  const { data: pending, error: pendingError } = await supabase
    .from("qiunai_activity_notification_deliveries")
    .select("discord_id,attempt_count").eq("activity_id", activity.id)
    .eq("status", "pending").order("discord_id").limit(BATCH_SIZE);
  if (pendingError) throw pendingError;
  for (const delivery of pending || []) {
    await deliverDm(supabase, client, activity, options || [], delivery);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const { count: unfinished, error: countError } = await supabase
    .from("qiunai_activity_notification_deliveries")
    .select("discord_id", { count: "exact", head: true })
    .eq("activity_id", activity.id).in("status", ["pending", "sending"]);
  if (countError) throw countError;
  if (!unfinished) {
    const { count: failed, error: failedError } = await supabase
      .from("qiunai_activity_notification_deliveries")
      .select("discord_id", { count: "exact", head: true })
      .eq("activity_id", activity.id).eq("status", "failed");
    if (failedError) throw failedError;
    await updateNotification(supabase, activity.id, {
      completed_at: new Date().toISOString(),
      last_error: failed ? `${failed} 位陪陪拒收或私訊失敗` : null,
    });
    console.log(`[活動通知] ${activity.title} 私訊完成，失敗 ${failed || 0} 位`);
  }
}

async function processPendingActivityNotifications(supabase, client) {
  const { data: notifications, error } = await supabase
    .from("qiunai_activity_notifications")
    .select("activity_id,announcement_status,announcement_attempted_at,last_error")
    .is("completed_at", null).order("created_at").limit(100);
  if (error) throw error;
  for (const notification of notifications || []) {
    try {
      await processActivityNotification(supabase, client, notification);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      await updateNotification(supabase, notification.activity_id, { last_error: message }).catch(() => {});
      console.error(`[活動通知] ${notification.activity_id} 處理失敗`, error);
    }
  }
}

function startQiunaiActivityNotificationScheduler(supabase, client, createNonOverlappingTask) {
  const run = createNonOverlappingTask("秋奈活動公告與私訊", () =>
    processPendingActivityNotifications(supabase, client));
  const timer = setInterval(run, 15 * 1000);
  timer.unref?.();
  void run();
  return timer;
}

module.exports = {
  buildActivityAnnouncement,
  buildActivityDm,
  notificationNonce,
  processPendingActivityNotifications,
  startQiunaiActivityNotificationScheduler,
};
