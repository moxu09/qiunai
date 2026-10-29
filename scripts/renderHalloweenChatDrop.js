const fs = require("node:fs");
const path = require("node:path");
const { Resvg } = require("@resvg/resvg-js");
const { buildChatDropPayload } = require("../utils/chatDropTheme");
const root = path.join(__dirname, "..");
const font = { fontFiles: [path.join(root, "assets/fonts/NotoSansCJKtc-Regular.otf"), path.join(root, "assets/fonts/NotoSans-Regular.ttf"), path.join(root, "assets/fonts/NotoEmoji.ttf")], loadSystemFonts: false };
const banner = new Resvg(fs.readFileSync(path.join(root, "assets/halloween-chat-drop.svg")), { font }).render().asPng();
fs.writeFileSync(path.join(root, "assets/halloween-chat-drop.png"), banner);
const payload = buildChatDropPayload(18, { now: Date.parse("2026-10-30T12:00:00+08:00") }), embed = payload.embeds[0].toJSON();
const esc = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lines = embed.description.replace(/\*\*/g, "").split("\n");
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="650"><rect width="800" height="650" rx="20" fill="#313338"/>
<circle cx="48" cy="49" r="22" fill="#6a558e"/><text x="31" y="57" fill="#fff" font-size="22" font-family="Noto Sans CJK TC">奈</text>
<text x="84" y="49" fill="#e8d7ff" font-size="23" font-family="Noto Sans CJK TC">小奈</text><rect x="143" y="29" width="49" height="25" rx="6" fill="#5865f2"/><text x="150" y="47" fill="white" font-size="14" font-family="Noto Sans CJK TC">應用</text>
<rect x="83" y="76" width="677" height="489" rx="9" fill="#2b2d31"/><path d="M87 80V561" stroke="#ff9b3d" stroke-width="5"/>
<text x="111" y="122" fill="#fff0da" font-family="Noto Sans CJK TC" font-size="26">${esc(embed.title)}</text>
${lines.map((line, i) => `<text x="111" y="${167 + i * 30}" fill="#e1dfe5" font-family="Noto Sans CJK TC" font-size="19">${esc(line)}</text>`).join("")}
<image x="110" y="303" width="624" height="206" href="data:image/png;base64,${banner.toString("base64")}"/>
<text x="112" y="541" fill="#a9a3b2" font-family="Noto Sans CJK TC" font-size="15">${esc(embed.footer.text)}</text>
<rect x="84" y="578" width="211" height="48" rx="6" fill="#5865f2"/><text x="108" y="609" fill="white" font-family="Noto Sans CJK TC" font-size="20">🍬 ${payload.components[0].components[0].data.label}</text></svg>`;
const output = process.argv[2] || path.join(root, "artifacts/halloween-chat-drop-preview.png");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, new Resvg(preview, { font }).render().asPng());
console.log(output);
