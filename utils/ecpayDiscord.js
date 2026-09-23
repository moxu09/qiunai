const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require("discord.js");
const bwipjs = require("bwip-js");
const { PNG } = require("pngjs");
const { createHmac } = require("node:crypto");
const { isEcpayAtmAvailable } = require("./ecpayAtmSchedule");

const METHODS = Object.freeze({
  ATM: { label: "匯款／ATM 虛擬帳號", min: 16, max: 49_999 },
  CVS: { label: "超商代碼", min: 34, max: 20_000 },
  BARCODE: { label: "超商條碼", min: 18, max: 20_000 },
});

function buildEcpayPaymentRows(payment, amount, { topup = false, onlyMethod = null, selfService = false } = {}) {
  const order = String(payment.platformOrderId || "");
  const base = String(payment.paymentUrl || "").split("/payments/ecpay/service/checkout")[0];
  if (!/^[A-Za-z0-9]{1,20}$/.test(order) || !/^https:\/\//.test(base))
    throw new Error("綠界付款連結不正確");
  const buttons = [];
  if (!onlyMethod || onlyMethod === "CARD") {
    buttons.push(new ButtonBuilder().setLabel("站內刷卡").setEmoji("💳")
      .setStyle(ButtonStyle.Link).setURL(`${base}/payments/ecpay/service/insite?order=${encodeURIComponent(order)}`));
  }
  for (const [method, limit] of Object.entries(METHODS)) {
    if (onlyMethod && onlyMethod !== method) continue;
    if (method === "ATM" && !selfService && !isEcpayAtmAvailable()) continue;
    if (topup && method !== "ATM") continue;
    if (amount < limit.min || amount > limit.max) continue;
    buttons.push(new ButtonBuilder().setCustomId(`ecpay_direct_${method}_${order}`)
      .setLabel(limit.label).setStyle(ButtonStyle.Primary));
  }
  if (!buttons.length) throw new Error("此訂單金額不適用所選的綠界付款方式");
  return [new ActionRowBuilder().addComponents(buttons)];
}

async function renderBarcodes(barcodes) {
  const images = await Promise.all(barcodes.map(async (value) => PNG.sync.read(await bwipjs.toBuffer({
    bcid: "code39", text: value, scale: 3, height: 15,
    includetext: true, textxalign: "center", padding: 16,
  }))));
  const margin = 48;
  const gap = 40;
  const width = Math.max(...images.map((item) => item.width)) + margin * 2;
  const height = images.reduce((sum, item) => sum + item.height, 0) + margin * 2 + gap * 2;
  const sheet = new PNG({ width, height, colorType: 6 });
  sheet.data.fill(255);
  let top = margin;
  for (const item of images) {
    const left = Math.floor((width - item.width) / 2);
    for (let y = 0; y < item.height; y++) {
      for (let x = 0; x < item.width; x++) {
        const source = (y * item.width + x) * 4;
        const target = ((top + y) * width + left + x) * 4;
        const alpha = item.data[source + 3] / 255;
        if (!alpha) continue;
        for (let channel = 0; channel < 3; channel++) {
          sheet.data[target + channel] = Math.round(item.data[source + channel] * alpha + 255 * (1 - alpha));
        }
      }
    }
    top += item.height + gap;
  }
  return PNG.sync.write(sheet);
}

async function handleEcpayDirect(interaction, supabase, baseUrl) {
  const match = String(interaction.customId || "").match(/^ecpay_direct_(ATM|CVS|BARCODE)_([A-Za-z0-9]{1,20})$/);
  if (!match) return false;
  const [, method, order] = match;
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
  try {
    const { data: payment, error } = await supabase.from("ecpay_service_payments")
      .select("user_id,channel_id,status,amount,payment_kind,organization_code,metadata").eq("merchant_trade_no", order).maybeSingle();
    if (error || !payment || payment.status !== "pending" ||
        payment.user_id !== interaction.user.id || String(payment.channel_id) !== String(interaction.channelId))
      throw new Error("這筆付款不屬於你，或已完成付款");
    if (method === "ATM" && !isEcpayAtmAvailable() &&
        !(payment.organization_code === "qiunai" && payment.metadata?.flow === "self_service"))
      throw new Error("綠界虛擬 ATM 將於 9 月 28 日開放");
    const limit = METHODS[method];
    if (payment.amount < limit.min || payment.amount > limit.max ||
        (payment.payment_kind === "topup" && method !== "ATM"))
      throw new Error("此付款方式不適用這筆金額或訂單");
    const body = JSON.stringify({ order, method, timestamp: Math.floor(Date.now() / 1000) });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("付款服務尚未完成設定");
    const signature = createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY).update(body).digest("hex");
    const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/api/payments/ecpay/service/direct-issue`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Ecpay-Bot-Signature": signature },
      body, signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json();
    if (!response.ok || !result.payment_info || result.payment_info.method !== method)
      throw new Error(result.error || "綠界取號失敗，請勿重複操作");
    const info = result.payment_info;
    let content = `<@${interaction.user.id}>\n**綠界${limit.label}**\n金額：NT$${Number(payment.amount).toLocaleString("zh-TW")}\n期限：${info.expireDate}\n`;
    const files = [];
    if (method === "ATM") {
      if (!/^\d{3}$/.test(info.bankCode) || !/^\d{6,16}$/.test(info.virtualAccount))
        throw new Error("綠界虛擬帳號資料不完整");
      content += `銀行代碼：\`${info.bankCode}\`\n虛擬帳號：\`${info.virtualAccount}\`\n`;
    } else if (method === "CVS") {
      if (!/^[A-Za-z0-9]{6,14}$/.test(info.paymentNo)) throw new Error("綠界超商代碼資料不完整");
      content += `超商繳費代碼：\`${info.paymentNo}\`\n`;
    } else {
      if (!Array.isArray(info.barcode) || info.barcode.length !== 3 ||
          !info.barcode.every(value => /^[A-Za-z0-9-]{1,20}$/.test(value)))
        throw new Error("綠界超商條碼資料不完整");
      for (let i = 0; i < 3; i++) content += `條碼${i + 1}：\`${info.barcode[i]}\`\n`;
      files.push(new AttachmentBuilder(await renderBarcodes(info.barcode), { name: `ecpay-${order}-barcodes.png` }));
    }
    content += "\n取號不代表已付款；完成轉帳或超商繳費後，系統收到綠界通知才會自動核帳。請勿重複繳費。";
    await interaction.channel.send({ content, files });
    await interaction.editReply({ content: "✅ 綠界繳費資訊已發送到此頻道。" });
  } catch (error) {
    await interaction.editReply({ content: `❌ ${error.message || error}` });
  }
  return true;
}

async function sendPreferredEcpayDirect(channel, userId, order, supabase, baseUrl, method = "ATM") {
  let failure = null;
  await handleEcpayDirect({
    customId: `ecpay_direct_${method}_${order}`, user: { id: userId }, channelId: channel.id, channel,
    deferReply: async () => {},
    editReply: async ({ content }) => { if (content.startsWith("❌")) failure = content; },
  }, supabase, baseUrl);
  if (failure) await channel.send({ content: `<@${userId}> ${failure} 已建立付款單但尚未取得繳費資訊；請勿重複建立付款單。` });
  return !failure;
}

module.exports = { buildEcpayPaymentRows, handleEcpayDirect, sendPreferredEcpayDirect, renderBarcodes };
