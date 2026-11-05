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

function buildHeartAdjustmentCommand() {
  return new SlashCommandBuilder()
    .setName("調整心動值")
    .setDescription("調整指定老闆與陪陪配對的心動值（秋奈管理員）")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option => option.setName("老闆").setDescription("這筆配對的老闆").setRequired(true))
    .addUserOption(option => option.setName("陪陪").setDescription("這筆配對的陪陪").setRequired(true))
    .addIntegerOption(option => option.setName("數額").setDescription("要調整的心動值，直接設定時可輸入 0")
      .setMinValue(0).setMaxValue(2_147_483_647).setRequired(true))
    .addStringOption(option => option.setName("方式").setDescription("選擇增加、減少或直接設定").setRequired(true)
      .addChoices({ name: "增加", value: "add" }, { name: "減少", value: "subtract" }, { name: "直接設定", value: "set" }));
}

async function handleHeartAdjustment(interaction, db) {
  const authorized = SUPPORT_ROLE_BY_GUILD.has(interaction.guildId) &&
    (interaction.guild?.ownerId === interaction.user.id ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  if (!authorized) return interaction.editReply({ content: "只有秋奈管理員可以調整心動值。" });
  const buyer = interaction.options.getUser("老闆", true);
  const staff = interaction.options.getUser("陪陪", true);
  const points = interaction.options.getInteger("數額", true);
  const operation = interaction.options.getString("方式", true);
  if (buyer.bot || staff.bot || buyer.id === staff.id) {
    return interaction.editReply({ content: "請選擇兩個不同的非機器人成員。" });
  }
  if (points === 0 && operation !== "set") {
    return interaction.editReply({ content: "增加或減少請輸入大於 0 的整數。" });
  }
  const { data, error } = await db.rpc("qiunai_adjust_heart_points", {
    p_interaction_id: interaction.id,
    p_actor_id: interaction.user.id,
    p_buyer_id: buyer.id,
    p_staff_id: staff.id,
    p_operation: operation,
    p_points: points,
  });
  if (error?.code === "22023" && error.message === "扣減數額超過目前心動值") {
    return interaction.editReply({ content: "扣減數額超過目前心動值，請輸入較小的數額。" });
  }
  if (error) throw error;
  const previous = BigInt(data.previous).toLocaleString("zh-TW");
  const total = BigInt(data.total).toLocaleString("zh-TW");
  return interaction.editReply({
    content: `✅ 已調整心動值\n配對 <@${buyer.id}> ＆ <@${staff.id}>\n${previous} → **${total}**`,
    allowedMentions: NO_MENTIONS,
  });
}

async function findHeartPartners(db, userId) {
  const partners = [];
  let after;
  while (true) {
    let query = db.rpc("qiunai_list_heart_partners", { p_user_id: userId })
      .order("partner_id").limit(QUERY_SIZE);
    if (after) query = query.gt("partner_id", after);
    const { data, error } = await query;
    if (error) throw error;
    for (const row of data) {
      partners.push({ id: row.partner_id, total: BigInt(row.total_points), verified: row.opening_verified });
    }
    if (data.length < QUERY_SIZE) break;
    after = data.at(-1).partner_id;
  }
  return partners.sort((a, b) =>
    a.total === b.total ? a.id.localeCompare(b.id) : a.total > b.total ? -1 : 1);
}

function renderPage(userId, partners, page, controls = true) {
  const pageCount = Math.max(1, Math.ceil(partners.length / PAGE_SIZE));
  const rows = partners.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lines = rows.map(partner =>
    `<@${partner.id}>｜共同累積 ${partner.total.toLocaleString("zh-TW")}${partner.verified ? "" : "＊"}`);
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

module.exports = { buildHeartInquiryCommand, findHeartPartners, handleHeartInquiry, buildHeartAdjustmentCommand, handleHeartAdjustment };
