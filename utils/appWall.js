// APP 留言牆 moderation: when a customer posts on the wall, app-api calls the signed
// POST /app/wall/notify { postId } (via appBridge); 小奈 DMs the allowlisted recipients
// (APP_PRIZE_CLAIM_NOTIFY_USER_IDS, default the owner) with 「通過／不通過」 buttons.
// A press is a compare-and-set on status='pending', so a post is reviewed exactly once;
// a later press (any copy) answers 「這則已經審核過了」. The result replaces the buttons on the
// pressed DM and, best effort, on every other recipient's copy sent since this process started
// (refs kept in memory only: after a restart a stale copy is fixed when pressed).
// The post is read here with the service-role client; customer text is markdown-escaped and
// mentions are disabled. The body is never logged.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Routes } = require("discord.js");
const { parseRecipientIds } = require("./appPrizeClaims");

// Clipped before markdown-escaping (no dangling backslash); <@id>/<@&id>/<#id> neutralised.
const { safeText } = require("./discordSafeText");

const APPROVE_PREFIX = "app_wall_approve_";
const REJECT_PREFIX = "app_wall_reject_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const BRAND_LABELS = { qiunai: "秋奈", deepnight: "深夜不關燈" };
const ANONYMOUS = "匿名老闆";
const RESULT_LABELS = { approved: "✅ 已通過", rejected: "🚫 不通過" };
const COLORS = { pending: 0x7c4dff, approved: 0x2ecc71, rejected: 0x95a5a6 };
const MAX_REFS = 500;

const NOT_ALLOWED = "你沒有權限審核";
const INVALID = "這則留言的編號無效";
const NOT_FOUND = "找不到這則留言";
const ALREADY = "這則已經審核過了";
const SAVE_FAILED = "暫時無法審核，請稍後再試";
const LOAD_FAILED = "暫時無法讀取留言，請稍後再試";
const DM_FAILED = "通知暫時無法送出，請稍後再試";
const COLUMNS = "id,brand,user_id,display_name,anonymous,body,status,created_at,reviewed_by,reviewed_at";


function buildEmbed(post) {
  const display = post.anonymous ? ANONYMOUS : safeText(post.display_name, 256) || ANONYMOUS;
  const author = SNOWFLAKE.test(String(post.user_id)) ? `<@${post.user_id}>` : "（未知）";
  const done = RESULT_LABELS[post.status];
  const embed = new EmbedBuilder()
    .setColor(COLORS[post.status] || COLORS.pending)
    .setTitle(done ? "📝 APP 留言牆審核結果" : "📝 APP 留言牆待審核")
    .addFields(
      { name: "店別", value: BRAND_LABELS[post.brand] || "其他", inline: true },
      { name: "顯示", value: display, inline: true },
      { name: "作者", value: author, inline: true },
      { name: "留言", value: safeText(post.body) || "（空白）" },
    )
    .setFooter({ text: `留言編號 ${post.id}` });
  if (done) {
    const by = SNOWFLAKE.test(String(post.reviewed_by)) ? `（<@${post.reviewed_by}>）` : "";
    embed.addFields({ name: "審核結果", value: `${done}${by}` });
  }
  return embed;
}

function pendingPayload(post) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${APPROVE_PREFIX}${post.id}`).setLabel("通過").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${REJECT_PREFIX}${post.id}`).setLabel("不通過").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [buildEmbed(post)], components: [row], allowedMentions: { parse: [] } };
}

const resultPayload = post => ({ embeds: [buildEmbed(post)], components: [], allowedMentions: { parse: [] } });

function createAppWall({ db, client, recipientIds = process.env.APP_PRIZE_CLAIM_NOTIFY_USER_IDS } = {}) {
  const recipients = parseRecipientIds(recipientIds);
  const dmRefs = new Map(); // postId -> [{ channelId, messageId }]

  async function loadPost(postId) {
    const { data, error } = await db.from("app_wall_posts").select(COLUMNS).eq("id", postId).maybeSingle();
    if (error) throw error;
    return data;
  }

  function remember(postId, ref) {
    const list = dmRefs.get(postId) || [];
    list.push(ref);
    dmRefs.delete(postId);
    dmRefs.set(postId, list);
    while (dmRefs.size > MAX_REFS) dmRefs.delete(dmRefs.keys().next().value);
  }

  async function notify(value) {
    const postId = value?.postId;
    if (typeof postId !== "string" || !UUID.test(postId)) return { status: 400, body: { error: INVALID } };
    let post;
    try {
      post = await loadPost(postId);
    } catch (error) {
      console.error("[APP 留言牆] 讀取失敗", { postId, code: error?.code || "unknown" });
      return { status: 503, body: { error: LOAD_FAILED } };
    }
    if (!post) return { status: 404, body: { error: NOT_FOUND } };
    if (post.status !== "pending") return { status: 200, body: { ok: true, sent: 0 } };
    const payload = pendingPayload(post);
    let sent = 0;
    for (const id of recipients) {
      try {
        const user = await client.users.fetch(id);
        const dm = await user.send(payload);
        sent += 1;
        if (dm?.id && dm?.channelId) remember(postId, { channelId: String(dm.channelId), messageId: String(dm.id) });
      } catch (error) {
        console.warn("[APP 留言牆] 私訊失敗", { postId, recipient: id, code: error?.code || "unknown" });
      }
    }
    if (!sent) return { status: 503, body: { error: DM_FAILED } };
    return { status: 200, body: { ok: true, sent } };
  }

  // Best effort: show the result on the other recipients' copies too.
  async function updateOtherCopies(post, pressedMessageId) {
    const refs = dmRefs.get(post.id) || [];
    dmRefs.delete(post.id);
    const body = { embeds: [buildEmbed(post).toJSON()], components: [], allowed_mentions: { parse: [] } };
    for (const ref of refs) {
      if (ref.messageId === pressedMessageId) continue;
      try {
        await client.rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), { body });
      } catch (error) {
        console.warn("[APP 留言牆] 更新私訊失敗", { postId: post.id, code: error?.code || "unknown" });
      }
    }
  }

  const ephemeral = content => ({ content, flags: 64, allowedMentions: { parse: [] } });

  async function handleButton(interaction, postId, status) {
    if (!recipients.includes(String(interaction.user?.id))) return interaction.reply(ephemeral(NOT_ALLOWED));
    if (!UUID.test(postId)) return interaction.reply(ephemeral(INVALID));
    await interaction.deferUpdate();
    let updated;
    try {
      const { data, error } = await db.from("app_wall_posts")
        .update({ status, reviewed_by: String(interaction.user.id), reviewed_at: new Date().toISOString() })
        .eq("id", postId).eq("status", "pending").select(COLUMNS);
      if (error) throw error;
      updated = data?.[0] || null;
    } catch (error) {
      console.error("[APP 留言牆] 審核寫入失敗", { postId, code: error?.code || "unknown" });
      return interaction.followUp(ephemeral(SAVE_FAILED));
    }
    if (updated) {
      await interaction.editReply(resultPayload(updated));
      await updateOtherCopies(updated, String(interaction.message?.id || ""));
      return undefined;
    }
    // Already reviewed (or gone): fix this copy's stale buttons, keep the first result.
    let current = null;
    try { current = await loadPost(postId); } catch (error) {
      console.error("[APP 留言牆] 讀取失敗", { postId, code: error?.code || "unknown" });
    }
    if (!current) return interaction.followUp(ephemeral(NOT_FOUND));
    if (current.status !== "pending") await interaction.editReply(resultPayload(current));
    return interaction.followUp(ephemeral(ALREADY));
  }

  // Only claims app_wall_approve_<id> / app_wall_reject_<id> buttons (single-token id).
  async function handleInteraction(interaction) {
    if (!interaction?.isButton?.()) return false;
    const customId = String(interaction.customId || "");
    const [prefix, status] = customId.startsWith(APPROVE_PREFIX) ? [APPROVE_PREFIX, "approved"]
      : customId.startsWith(REJECT_PREFIX) ? [REJECT_PREFIX, "rejected"] : [null, null];
    if (!prefix) return false;
    const postId = customId.slice(prefix.length);
    if (!/^[0-9a-z-]{1,64}$/i.test(postId)) return false;
    await handleButton(interaction, postId, status);
    return true;
  }

  return { notify, handleInteraction, recipients };
}

module.exports = { createAppWall, APPROVE_PREFIX, REJECT_PREFIX };
