// In-app prize claims (APP 我的獎品 → 申請領獎): 小奈 DMs the allowlisted recipients when a
// customer files a claim or replies to it (signed POST /app/prize-claims/notify via appBridge),
// with a 「回覆」 button that opens a modal; the reply is stored in app_prize_claim_messages
// (sender 'staff') so the customer sees it in the APP.
// The claim and message are read here with the service-role client; the app never sends
// contact data over the notify call. Contact data only goes into the DM, never into logs.
//
// Retention (owner decision 「領獎寄送資料保存至寄出後一週」): every DM sent for a claim (new claim and
// customer replies alike) is recorded in app_prize_claims.dm_refs; purgeExpired() (index.js: at
// startup + every 6 h) deletes those DMs and nulls contact one week after the prize is sent.
// "Sent" = a bot_prize_redemptions row (/兌換獎品) for the claim's prize with redeemed_at > 7 days ago.
// Rejected claims: the table has no status-change time, so they are purged at created_at + 30 days
// (documented choice; the rejection itself is never stored with a timestamp).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, Routes, TextInputBuilder, TextInputStyle, escapeMarkdown } = require("discord.js");

// Customer-supplied text: escape markdown so e.g. a masked link can't be faked in the owner's DM.
const safe = value => escapeMarkdown(String(value ?? "").trim(),
  { maskedLink: true, heading: true, bulletedList: true, numberedList: true });

const DEFAULT_RECIPIENT_ID = "847840193859682304";
const BUTTON_PREFIX = "app_claim_reply_";
const MODAL_PREFIX = "app_claim_reply_modal_";
const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_TEXT}$`, "i");
const MAX_BODY = 1000;
const SOURCE_LABELS = { ichiban: "一番賞", gacha: "扭蛋" };
// app_prize_claims.source_type -> bot_prize_redemptions.source_type
const REDEMPTION_TYPES = { ichiban: "ichiban_draw", gacha: "gacha_item" };
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_RETENTION_MS = 7 * DAY_MS;
const REJECTED_RETENTION_MS = 30 * DAY_MS;
const PURGE_BATCH = 100;
const PURGE_SCAN_LIMIT = 1000;
const PURGED_CONTACT = "寄送資料已刪除";
const SNOWFLAKE = /^\d{17,20}$/;
const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message: already gone

const NOT_ALLOWED = "你沒有權限回覆這張申請";
const SENT = "已送出，客人會在 APP 看到";
const INVALID = "這張申請的編號無效";
const NOT_FOUND = "找不到這張申請";
const BLANK = "回覆內容不能是空白";
const TOO_LONG = `回覆最多 ${MAX_BODY} 字`;
const SAVE_FAILED = "回覆暫時無法送出，請稍後再試";
const DM_FAILED = "通知暫時無法送出，請稍後再試";
const LOAD_FAILED = "暫時無法讀取領獎申請，請稍後再試";

function parseRecipientIds(value) {
  const ids = [...new Set(String(value || "").match(/\d{17,20}/g) || [])];
  return ids.length ? ids : [DEFAULT_RECIPIENT_ID];
}

const clip = (value, max = 1024) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function contactObject(contact) {
  if (typeof contact === "string") {
    try { return JSON.parse(contact) || {}; } catch { return {}; }
  }
  return contact && typeof contact === "object" ? contact : {};
}

// Owner decision 2026-11-25: everything in full (phone included); the owner ships the prize.
function contactSummary(raw) {
  const contact = contactObject(raw);
  const lines = [
    ["收件人", contact.name],
    ["電話", contact.phone],
    ["地址", contact.address],
    ["超商門市", contact.store],
    ["Email", contact.email],
  ].filter(([, value]) => value != null && String(value).trim())
    .map(([label, value]) => `${label}：${safe(value)}`);
  return clip(lines.join("\n") || "（未填）");
}

function buildDm(claim, message) {
  const embed = new EmbedBuilder()
    .setColor(0x7c4dff)
    .setTitle(message ? "💬 領獎申請新回覆" : "📦 APP 領獎申請")
    .addFields(
      { name: "獎品", value: clip(safe(claim.prize_name)) || "（未命名）", inline: true },
      { name: "來源", value: SOURCE_LABELS[claim.source_type] || "其他", inline: true },
      { name: "申請人", value: `<@${claim.user_id}>`, inline: true },
      { name: "收件資料摘要", value: claim.contact == null ? PURGED_CONTACT : contactSummary(claim.contact) },
    )
    .setFooter({ text: `申請編號 ${claim.id}` });
  if (message) embed.addFields({ name: "客人回覆", value: clip(safe(message.body)) || "（空白）" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${claim.id}`).setLabel("回覆").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function createAppPrizeClaims({ db, client, recipientIds = process.env.APP_PRIZE_CLAIM_NOTIFY_USER_IDS } = {}) {
  const recipients = parseRecipientIds(recipientIds);

  async function loadClaim(claimId) {
    const { data, error } = await db.from("app_prize_claims")
      .select("id,user_id,guild_id,source_type,source_id,prize_name,contact,status,created_at")
      .eq("id", claimId).maybeSingle();
    if (error) throw error;
    return data;
  }

  // Compare-and-set append (retried) so concurrent notifies for one claim never drop a ref.
  async function appendDmRef(claimId, ref) {
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await db.from("app_prize_claims").select("dm_refs").eq("id", claimId).maybeSingle();
        if (error) throw error;
        if (!data) return;
        const current = Array.isArray(data.dm_refs) ? data.dm_refs : [];
        const { data: updated, error: updateError } = await db.from("app_prize_claims")
          .update({ dm_refs: [...current, ref] })
          .eq("id", claimId).eq("dm_refs", JSON.stringify(current)).select("id");
        if (updateError) throw updateError;
        if (updated?.length) return;
      }
      throw Object.assign(new Error("dm_refs contention"), { code: "contention" });
    } catch (error) {
      console.warn("[APP 領獎通知] 私訊紀錄失敗", { claimId, code: error?.code || "unknown" });
    }
  }

  async function notify(value) {
    const claimId = value?.claimId;
    const messageId = value?.messageId;
    if (typeof claimId !== "string" || !UUID.test(claimId)) return { status: 400, body: { error: INVALID } };
    if (messageId != null && (typeof messageId !== "string" || !UUID.test(messageId))) {
      return { status: 400, body: { error: "回覆編號無效" } };
    }
    let claim;
    let message = null;
    try {
      claim = await loadClaim(claimId);
      if (!claim) return { status: 404, body: { error: NOT_FOUND } };
      if (messageId) {
        const { data, error } = await db.from("app_prize_claim_messages")
          .select("id,claim_id,sender,body,created_at")
          .eq("id", messageId).eq("claim_id", claimId).eq("sender", "customer").maybeSingle();
        if (error) throw error;
        if (!data) return { status: 404, body: { error: "找不到這則回覆" } };
        message = data;
      }
    } catch (error) {
      console.error("[APP 領獎通知] 讀取失敗", { claimId, code: error?.code || "unknown" });
      return { status: 503, body: { error: LOAD_FAILED } };
    }
    const payload = buildDm(claim, message);
    let sent = 0;
    for (const id of recipients) {
      try {
        const user = await client.users.fetch(id);
        const dm = await user.send(payload);
        sent += 1;
        if (dm?.id && dm?.channelId) await appendDmRef(claimId, { channelId: String(dm.channelId), messageId: String(dm.id) });
      } catch (error) {
        console.warn("[APP 領獎通知] 私訊失敗", { claimId, recipient: id, code: error?.code || "unknown" });
      }
    }
    if (!sent) return { status: 503, body: { error: DM_FAILED } };
    return { status: 200, body: { ok: true, sent } };
  }

  async function deleteDm(ref) {
    try {
      await client.rest.delete(Routes.channelMessage(ref.channelId, ref.messageId));
      return true;
    } catch (error) {
      if (GONE_CODES.has(Number(error?.code))) return true;
      return error || {};
    }
  }

  async function purgeClaim(claim, now) {
    const refs = Array.isArray(claim.dm_refs) ? claim.dm_refs : [];
    const kept = [];
    for (const ref of refs) {
      if (!SNOWFLAKE.test(String(ref?.channelId)) || !SNOWFLAKE.test(String(ref?.messageId))) continue;
      const result = await deleteDm({ channelId: String(ref.channelId), messageId: String(ref.messageId) });
      if (result !== true) {
        kept.push(ref); // retried next run; contact is still nulled now
        console.warn("[APP 領獎資料清除] 私訊刪除失敗", { claimId: claim.id, code: result.code || result.status || "unknown" });
      }
    }
    // Compare-and-set on dm_refs: a DM recorded meanwhile stays for the next run instead of being lost.
    const { data, error } = await db.from("app_prize_claims")
      .update({ contact: null, contact_purged_at: claim.contact_purged_at || now.toISOString(), dm_refs: kept })
      .eq("id", claim.id).eq("dm_refs", JSON.stringify(refs)).select("id");
    if (error) throw error;
    return Boolean(data?.length);
  }

  // Idempotent; at most PURGE_BATCH claims per run. Never reads or logs contact.
  async function purgeExpired({ now = new Date() } = {}) {
    const summary = { purged: 0, deferred: 0, failed: 0 };
    const { data: candidates, error } = await db.from("app_prize_claims")
      .select("id,guild_id,source_type,source_id,status,created_at,dm_refs,contact_purged_at")
      .or("contact.not.is.null,dm_refs.neq.[]")
      .order("created_at", { ascending: true }).limit(PURGE_SCAN_LIMIT);
    if (error) {
      console.error("[APP 領獎資料清除] 讀取失敗", { code: error.code || "unknown" });
      return summary;
    }
    const rows = candidates || [];
    const rejectedCutoff = now.getTime() - REJECTED_RETENTION_MS;
    const due = rows.filter(c => c.status === "rejected" && Date.parse(c.created_at) < rejectedCutoff);
    const shippedCutoff = new Date(now.getTime() - SHIPPED_RETENTION_MS).toISOString();
    for (const [type, redemptionType] of Object.entries(REDEMPTION_TYPES)) {
      const claims = rows.filter(c => c.status !== "rejected" && c.source_type === type);
      for (let i = 0; i < claims.length && due.length < PURGE_BATCH; i += 100) {
        const chunk = claims.slice(i, i + 100);
        const { data: redeemed, error: redemptionError } = await db.from("bot_prize_redemptions")
          .select("guild_id,source_id,redeemed_at")
          .eq("source_type", redemptionType)
          .in("source_id", [...new Set(chunk.map(c => String(c.source_id)))])
          .lt("redeemed_at", shippedCutoff);
        if (redemptionError) {
          console.error("[APP 領獎資料清除] 讀取兌換紀錄失敗", { code: redemptionError.code || "unknown" });
          return summary;
        }
        const shipped = new Set((redeemed || []).map(r => `${r.guild_id}:${r.source_id}`));
        due.push(...chunk.filter(c => shipped.has(`${c.guild_id}:${c.source_id}`)));
      }
    }
    for (const claim of due.slice(0, PURGE_BATCH)) {
      try {
        if (await purgeClaim(claim, now)) summary.purged += 1; else summary.deferred += 1;
      } catch (purgeError) {
        summary.failed += 1;
        console.error("[APP 領獎資料清除] 清除失敗", { claimId: claim.id, code: purgeError?.code || "unknown" });
      }
    }
    if (summary.purged || summary.deferred || summary.failed) console.log("[APP 領獎資料清除] 完成", summary);
    return summary;
  }

  const ephemeral = content => ({ content, flags: 64, allowedMentions: { parse: [] } });

  async function handleButton(interaction, claimId) {
    if (!recipients.includes(String(interaction.user?.id))) return interaction.reply(ephemeral(NOT_ALLOWED));
    if (!UUID.test(claimId)) return interaction.reply(ephemeral(INVALID));
    const modal = new ModalBuilder()
      .setCustomId(`${MODAL_PREFIX}${claimId}`)
      .setTitle("回覆領獎申請")
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("body").setLabel("回覆內容（客人會在 APP 看到）")
          .setStyle(TextInputStyle.Paragraph).setMaxLength(MAX_BODY).setRequired(true),
      ));
    return interaction.showModal(modal);
  }

  async function handleModal(interaction, claimId) {
    if (!recipients.includes(String(interaction.user?.id))) return interaction.reply(ephemeral(NOT_ALLOWED));
    if (!UUID.test(claimId)) return interaction.reply(ephemeral(INVALID));
    const body = String(interaction.fields.getTextInputValue("body") || "").trim();
    if (!body) return interaction.reply(ephemeral(BLANK));
    // Code points, not UTF-16 units, so emoji don't push a ≤1000-character reply over the limit.
    // On refusal the typed text is echoed back (in a code block) so the owner doesn't lose it.
    if ([...body].length > MAX_BODY) {
      const prefix = `${TOO_LONG}，請縮短後再送出。你剛剛輸入的內容：\n\`\`\`\n`;
      const kept = body.replaceAll("```", "ˋˋˋ").slice(0, 2000 - prefix.length - 4);
      return interaction.reply(ephemeral(`${prefix}${kept}\n\`\`\``));
    }
    await interaction.deferReply({ flags: 64 });
    try {
      const claim = await loadClaim(claimId);
      if (!claim) return interaction.editReply({ content: NOT_FOUND });
      const { error } = await db.from("app_prize_claim_messages")
        .insert({ claim_id: claimId, sender: "staff", staff_id: interaction.user.id, body });
      if (error) throw error;
    } catch (error) {
      console.error("[APP 領獎回覆] 寫入失敗", { claimId, code: error?.code || "unknown" });
      return interaction.editReply({ content: SAVE_FAILED });
    }
    return interaction.editReply({ content: SENT });
  }

  // Only claims app_claim_reply_<id> buttons and app_claim_reply_modal_<id> modals; the id part
  // must be a single token so no other customId (all existing ones differ in prefix) matches.
  async function handleInteraction(interaction) {
    const customId = String(interaction?.customId || "");
    if (interaction?.isModalSubmit?.()) {
      if (!customId.startsWith(MODAL_PREFIX)) return false;
      const claimId = customId.slice(MODAL_PREFIX.length);
      if (!/^[0-9a-z-]{1,64}$/i.test(claimId)) return false;
      await handleModal(interaction, claimId);
      return true;
    }
    if (interaction?.isButton?.()) {
      if (!customId.startsWith(BUTTON_PREFIX) || customId.startsWith(MODAL_PREFIX)) return false;
      const claimId = customId.slice(BUTTON_PREFIX.length);
      if (!/^[0-9a-z-]{1,64}$/i.test(claimId)) return false;
      await handleButton(interaction, claimId);
      return true;
    }
    return false;
  }

  return { notify, handleInteraction, purgeExpired, recipients };
}

module.exports = { createAppPrizeClaims, parseRecipientIds, contactSummary, PURGED_CONTACT, DEFAULT_RECIPIENT_ID, BUTTON_PREFIX, MODAL_PREFIX };
