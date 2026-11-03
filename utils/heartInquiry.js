const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder,
  InteractionContextType, PermissionFlagsBits, SlashCommandBuilder,
} = require("discord.js");

const SUPPORT_ROLE_BY_GUILD = new Map([
  ["1206138511535898654", "1210642900355125288"],
  ["1513174069087047731", "1513203868895412305"],
]);
const PAGE_SIZE = 15;
const QUERY_SIZE = 500;
const NO_MENTIONS = { parse: [], repliedUser: false };

function buildHeartInquiryCommand() {
  return new SlashCommandBuilder()
    .setName("心動值查詢")
    .setDescription("私下查看指定成員的所有心動值對象（秋奈客服與管理員）")
    .setContexts(InteractionContextType.Guild)
    .addUserOption(option => option.setName("對象").setDescription("要查詢的人").setRequired(true));
}

async function readDirection(db, userId, targetColumn, partnerColumn) {
  const pairs = [];
  let after;
  while (true) {
    let query = db.from("qiunai_heart_pairs")
      .select(`${partnerColumn},opening_points::text,earned_points::text,opening_verified_at`)
      .eq(targetColumn, userId).order(partnerColumn).limit(QUERY_SIZE);
    if (after) query = query.gt(partnerColumn, after);
    const { data, error } = await query;
    if (error) throw error;
    if (!data.length) return pairs;

    for (const row of data) {
      const points = BigInt(row.opening_points) + BigInt(row.earned_points);
      if (points > 0n) {
        pairs.push({ id: row[partnerColumn], points, verified: Boolean(row.opening_verified_at) });
      }
    }
    after = data.at(-1)[partnerColumn];
  }
}

async function findHeartPartners(db, userId) {
  const [sent, received] = await Promise.all([
    readDirection(db, userId, "buyer_id", "staff_id"),
    readDirection(db, userId, "staff_id", "buyer_id"),
  ]);
  const byId = new Map();
  for (const [direction, pairs] of [["sent", sent], ["received", received]]) {
    for (const pair of pairs) {
      const partner = byId.get(pair.id) || { id: pair.id, total: 0n };
      partner[direction] = pair;
      partner.total += pair.points;
      byId.set(pair.id, partner);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.total === b.total ? a.id.localeCompare(b.id) : a.total > b.total ? -1 : 1);
}

function renderPage(userId, partners, page, controls = true) {
  const pageCount = Math.max(1, Math.ceil(partners.length / PAGE_SIZE));
  const rows = partners.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lines = rows.map(partner => {
    const scores = [
      partner.sent && `送給對方 ${partner.sent.points.toLocaleString("zh-TW")}${partner.sent.verified ? "" : "＊"}`,
      partner.received && `對方送來 ${partner.received.points.toLocaleString("zh-TW")}${partner.received.verified ? "" : "＊"}`,
    ].filter(Boolean);
    return `<@${partner.id}>｜${scores.join("／")}`;
  });
  const embed = new EmbedBuilder().setColor(0xd66199).setTitle("秋奈｜心動值查詢")
    .setDescription(`查詢對象 <@${userId}>，共 ${partners.length} 位\n\n${lines.join("\n") || "目前沒有已記錄的正數心動值。"}`)
    .setFooter({ text: `第 ${page + 1}／${pageCount} 頁・僅顯示已建檔配對・＊表示舊資料尚未完整核對` });
  const components = [];
  if (controls && pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`heart-inquiry:${page - 1}`)
        .setStyle(ButtonStyle.Secondary).setLabel("上一頁").setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`heart-inquiry:${page + 1}`)
        .setStyle(ButtonStyle.Secondary).setLabel("下一頁").setDisabled(page + 1 === pageCount),
    ));
  }
  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

async function handleHeartInquiry(interaction, db) {
  const role = SUPPORT_ROLE_BY_GUILD.get(interaction.guildId);
  const memberRoles = interaction.member?.roles;
  const isSupport = Array.isArray(memberRoles) ? memberRoles.includes(role) : memberRoles?.cache?.has(role);
  if (!role || !(isSupport || interaction.guild?.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))) {
    return interaction.editReply({ content: "只有秋奈客服或管理員可以查詢心動值。" });
  }
  const target = interaction.options.getUser("對象", true);
  if (target.bot) return interaction.editReply({ content: "請選擇一位非機器人的成員。" });

  const partners = await findHeartPartners(db, target.id);
  const message = await interaction.editReply(renderPage(target.id, partners, 0));
  if (partners.length <= PAGE_SIZE) return message;

  const pageCount = Math.ceil(partners.length / PAGE_SIZE);
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: button => button.user.id === interaction.user.id && /^heart-inquiry:\d+$/.test(button.customId),
    time: 5 * 60_000,
  });
  collector.on("collect", async button => {
    const page = Number(button.customId.split(":")[1]);
    if (page >= pageCount) return;
    await button.update(renderPage(target.id, partners, page)).catch(() => {});
  });
  collector.on("end", () => interaction.editReply({ components: [] }).catch(() => {}));
  return message;
}

module.exports = { buildHeartInquiryCommand, findHeartPartners, handleHeartInquiry };
