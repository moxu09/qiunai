const path = require("node:path");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { parseChatDropReward } = require("./randomEvents");
const FOOTER = "萬聖節限定 · 聊天掉落";

function buildChatDropPayload(reward) {
  if (parseChatDropReward(`claim_${reward}`) !== reward) throw new Error("無效的聊天掉落獎勵");
  return {
    embeds: [new EmbedBuilder().setColor("#FF9B3D")
      .setTitle("🎃 不給糖，就搗蛋！")
      .setDescription(`小奈的南瓜糖果袋掉落了 **${reward} ASD**！\n\n👻 路過的小鬼，快來把這份甜甜的幸運帶走。\n🍬 點下方按鈕領取，先搶先贏！`)
      .setImage("attachment://halloween-chat-drop.png").setFooter({ text: FOOTER })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`claim_${reward}`).setLabel("領取南瓜糖果").setEmoji("🍬").setStyle(ButtonStyle.Primary))],
    files: [{ attachment: path.join(__dirname, "..", "assets", "halloween-chat-drop.png"), name: "halloween-chat-drop.png" }],
    allowedMentions: { parse: [] },
  };
}

function chatDropClaimText(message, reward) {
  return message?.embeds?.some(embed => embed.footer?.text === FOOTER)
    ? `🎃 不給糖，也有 ASD！你從南瓜糖果袋領取了 ${reward} ASD 🍬`
    : `☔ 成功領取 ${reward} 星雨幣`;
}
module.exports = { buildChatDropPayload, chatDropClaimText };
