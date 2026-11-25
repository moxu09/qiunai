// In-app prize claims (APP 我的獎品 → 申請領獎): 小奈 DMs the allowlisted recipients when a
// customer files a claim or replies to it (signed POST /app/prize-claims/notify via appBridge),
// with a 「回覆」 button that opens a modal; the reply is stored in app_prize_claim_messages
// (sender 'staff') so the customer sees it in the APP.
// The claim and message are read here with the service-role client; the app never sends
// contact data over the notify call. Contact data only goes into the DM, never into logs.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

const DEFAULT_RECIPIENT_ID = "847840193859682304";
const BUTTON_PREFIX = "app_claim_reply_";
const MODAL_PREFIX = "app_claim_reply_modal_";
const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_TEXT}$`, "i");
const MAX_BODY = 1000;
const SOURCE_LABELS = { ichiban: "一番賞", gacha: "扭蛋" };

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
    .map(([label, value]) => `${label}：${String(value).trim()}`);
  return clip(lines.join("\n") || "（未填）");
}

function buildDm(claim, message) {
  const embed = new EmbedBuilder()
    .setColor(0x7c4dff)
    .setTitle(message ? "💬 領獎申請新回覆" : "📦 APP 領獎申請")
    .addFields(
      { name: "獎品", value: clip(claim.prize_name) || "（未命名）", inline: true },
      { name: "來源", value: SOURCE_LABELS[claim.source_type] || "其他", inline: true },
      { name: "申請人", value: `<@${claim.user_id}>`, inline: true },
      { name: "收件資料摘要", value: contactSummary(claim.contact) },
    )
    .setFooter({ text: `申請編號 ${claim.id}` });
  if (message) embed.addFields({ name: "客人回覆", value: clip(message.body) || "（空白）" });
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
        await user.send(payload);
        sent += 1;
      } catch (error) {
        console.warn("[APP 領獎通知] 私訊失敗", { claimId, recipient: id, code: error?.code || "unknown" });
      }
    }
    if (!sent) return { status: 503, body: { error: DM_FAILED } };
    return { status: 200, body: { ok: true, sent } };
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
    if (body.length > MAX_BODY) return interaction.reply(ephemeral(TOO_LONG));
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

  return { notify, handleInteraction, recipients };
}

module.exports = { createAppPrizeClaims, parseRecipientIds, contactSummary, DEFAULT_RECIPIENT_ID, BUTTON_PREFIX, MODAL_PREFIX };
