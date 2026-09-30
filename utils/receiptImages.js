const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");

const FONT_FILE = path.join(__dirname, "..", "assets", "fonts", "NotoSansCJKtc-Regular.otf");
const WIDTH = 720;

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textUnits(value) {
  return [...String(value)].reduce((sum, char) => sum + (/^[\x00-\x7f]$/.test(char) ? 0.58 : 1), 0);
}

function wrapText(value, maxUnits, maxLines = 3) {
  const source = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!source) return ["—"];
  const lines = [];
  let current = "";
  for (const char of source) {
    if (textUnits(current + char) > maxUnits && current) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const shortened = lines.slice(0, maxLines);
  shortened[maxLines - 1] = `${[...shortened[maxLines - 1]].slice(0, -1).join("")}…`;
  return shortened;
}

function money(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new Error("收據金額無效");
  return `${currency === "ASD" ? "ASD " : "NT$"}${Math.round(value).toLocaleString("zh-TW")}`;
}

function taipeiTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("收據時間無效");
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function buildTipReceiptData({ tipData, allocations, staffNames, payerName }) {
  const payment = String(tipData?.paymentMethod || "已確認付款");
  return {
    kind: "tip",
    reference: tipData?.flowId || tipData?.tipId || tipData?.createdAt || "打賞紀錄",
    payer: tipData?.broadcastAnonymous ? "匿名闆闆" : payerName,
    recipient: staffNames.join("、"),
    details: allocations.flatMap((allocation) =>
      allocation.lines?.length
        ? allocation.lines.map((line) => `${line.name} × ${line.quantity || 1}`)
        : [allocation.item || "打賞"],
    ).join("、"),
    amount: allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0),
    currency: /錢包|儲值|ASD|餘額/u.test(payment) ? "ASD" : "TWD",
    payment,
    time: tipData?.createdAt,
  };
}

function buildOrderReceiptData({ order, payerName, playerNames, amount }) {
  const payment = String(order.payment_method || "已確認付款");
  return {
    kind: "order",
    reference: order.order_no || order.id,
    payer: payerName,
    recipient: playerNames.join("、") || "待選陪陪",
    details: order.service || order.order_item || "陪玩訂單",
    amount,
    currency: /錢包|儲值|ASD|餘額/u.test(payment) ? "ASD" : "TWD",
    payment,
    time: order.paid_at || new Date(),
  };
}

function receiptSvg({ kind, reference, payer, recipient, details, amount, currency = "TWD", payment, time }) {
  if (!['order', 'tip'].includes(kind)) throw new Error("收據類型無效");
  const isTip = kind === "tip";
  const rows = [
    { label: isTip ? "打賞人" : "闆闆", value: payer },
    { label: isTip ? "受賞陪陪" : "接單陪陪", value: recipient },
    { label: isTip ? "打賞內容" : "服務內容", value: details },
    { label: "付款方式", value: payment || "已確認付款" },
  ];
  let y = 300;
  const body = rows.map(({ label, value }) => {
    const lines = wrapText(value, 29, label === "打賞內容" || label === "服務內容" ? 3 : 2);
    const height = Math.max(125, lines.length * 36 + 70);
    const currentY = y;
    y += height;
    return `
      <text x="60" y="${currentY}" class="label">${escapeXml(label)}</text>
      ${lines.map((line, index) => `<text x="60" y="${currentY + 45 + index * 36}" class="value">${escapeXml(line)}</text>`).join("")}
      <path d="M60 ${currentY + height - 20} H660" stroke="#dcecf6" stroke-width="2"/>`;
  }).join("");
  const height = Math.max(1080, y + 305);
  const sum = money(amount, currency);
  const referenceLines = wrapText(reference || "—", 30, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <style>
      text { font-family: 'Noto Sans CJK TC', sans-serif; }
      .label { fill:#647b90; font-size:23px; }
      .value { fill:#142a43; font-size:28px; }
    </style>
    <rect width="720" height="${height}" rx="32" fill="#eaf6ff"/>
    <rect x="20" y="20" width="680" height="${height - 40}" rx="27" fill="#ffffff"/>
    <path d="M20 188 V47 Q20 20 47 20 H673 Q700 20 700 47 V188 Z" fill="#10385a"/>
    <path d="M43 188 H677" stroke="#78d1f6" stroke-width="3" stroke-dasharray="9 7"/>
    <circle cx="62" cy="75" r="12" fill="#72d1f2"/>
    <text x="88" y="86" fill="#ffffff" font-size="31">秋奈電競陪玩</text>
    <text x="60" y="155" fill="#b9e9fb" font-size="20">AKINA  ·  ${isTip ? "TIP RECEIPT" : "ORDER RECEIPT"}</text>
    <rect x="492" y="55" width="160" height="60" rx="29" fill="#78d1f6"/>
    <text x="572" y="94" text-anchor="middle" fill="#10385a" font-size="23">${isTip ? "感謝打賞" : "付款完成"}</text>
    <text x="60" y="248" fill="#6a8397" font-size="21">編號  ${escapeXml(referenceLines[0])}</text>
    ${body}
    <rect x="42" y="${y + 25}" width="636" height="132" rx="19" fill="#e5f7ff"/>
    <text x="64" y="${y + 80}" fill="#315875" font-size="25">${isTip ? "打賞總額" : "實收金額"}</text>
    <text x="650" y="${y + 118}" text-anchor="end" fill="#0b749d" font-size="44">${escapeXml(sum)}</text>
    <path d="M60 ${height - 133} H660" stroke="#b1dce9" stroke-width="2" stroke-dasharray="9 7"/>
    <text x="60" y="${height - 91}" fill="#7993a7" font-size="20">${escapeXml(taipeiTime(time))}</text>
    <text x="60" y="${height - 57}" fill="#7993a7" font-size="18">付款與入帳請以系統紀錄為準</text>
  </svg>`;
}

function renderReceiptPng(data) {
  const svg = receiptSvg(data);
  const renderer = new Resvg(svg, {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: "Noto Sans CJK TC" },
  });
  return renderer.render().asPng();
}

module.exports = {
  escapeXml,
  wrapText,
  buildTipReceiptData,
  buildOrderReceiptData,
  receiptSvg,
  renderReceiptPng,
};
