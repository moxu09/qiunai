const DISCORD_IMAGE_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
]);

const DEFAULT_INLINE_IMAGE_BUDGET = 6 * 1024 * 1024;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeHttpsUrl(value = "") {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatContent(value = "") {
  const escaped = escapeHtml(value || "(無文字內容)");
  return escaped
    .replace(
      /(https:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
    )
    .replaceAll("\n", "<br>");
}

function classifyOrderArchive(order = {}, channelName = "") {
  const source = [
    channelName,
    order.service,
    order.service_name,
    order.order_item,
    order.game,
    order.category,
    order.item,
    order.note,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/特戰|valorant|瓦羅蘭/.test(source)) return "特戰訂單";
  if (/三角洲|delta/.test(source)) return "三角洲訂單";
  if (/apex/.test(source)) return "apex訂單";
  if (/英雄聯盟|league of legends|\blol\b/.test(source)) {
    return "英雄聯盟訂單";
  }
  if (/steam/.test(source)) return "steam訂單";
  return "其他訂單";
}

async function fetchAllChannelMessages(channel, maxMessages = 5000) {
  const messages = new Map();
  let before;

  while (messages.size < maxMessages) {
    const page = await channel.messages.fetch({
      limit: Math.min(100, maxMessages - messages.size),
      ...(before ? { before } : {}),
    });
    if (!page?.size) break;
    for (const message of page.values()) messages.set(message.id, message);
    const oldest = [...page.values()].reduce((current, message) =>
      !current || message.createdTimestamp < current.createdTimestamp
        ? message
        : current,
    null);
    if (!oldest || page.size < 100) break;
    before = oldest.id;
  }

  return [...messages.values()].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp,
  );
}

async function downloadDiscordImage(url, remainingBytes) {
  const safeUrl = safeHttpsUrl(url);
  if (!safeUrl || remainingBytes <= 0) return null;
  const parsed = new URL(safeUrl);
  if (!DISCORD_IMAGE_HOSTS.has(parsed.hostname)) return null;

  const response = await fetch(safeUrl, {
    signal: AbortSignal.timeout(12_000),
    headers: { "User-Agent": "QiunaiOrderArchive/1.0" },
  });
  if (!response.ok) return null;
  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.startsWith("image/")) return null;
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > remainingBytes) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > remainingBytes) return null;
  return {
    source: `data:${contentType.split(";")[0]};base64,${buffer.toString("base64")}`,
    bytes: buffer.length,
  };
}

function renderImage(source, alt, className = "archive-image") {
  if (!source) return "";
  const image = `<img class="${className}" src="${source}" alt="${escapeHtml(alt)}" loading="lazy">`;
  return source.startsWith("data:")
    ? image
    : `<a href="${source}" target="_blank" rel="noreferrer">${image}</a>`;
}

async function buildDiscordArchiveHtml({
  channelName,
  guildName,
  messages,
  inlineImageBudget = DEFAULT_INLINE_IMAGE_BUDGET,
  imageDownloader = downloadDiscordImage,
}) {
  let remainingBytes = inlineImageBudget;
  const cachedImages = new Map();

  async function archiveImage(url) {
    const safeUrl = safeHttpsUrl(url);
    if (!safeUrl) return "";
    if (cachedImages.has(safeUrl)) return cachedImages.get(safeUrl);
    try {
      const downloaded = await imageDownloader(safeUrl, remainingBytes);
      if (downloaded?.source) {
        remainingBytes -= Number(downloaded.bytes || 0);
        cachedImages.set(safeUrl, downloaded.source);
        return downloaded.source;
      }
    } catch {
      // 外部圖片下載失敗時保留原始 HTTPS 連結。
    }
    cachedImages.set(safeUrl, safeUrl);
    return safeUrl;
  }

  const renderedMessages = [];
  for (const message of messages) {
    const attachments = [];
    for (const attachment of message.attachments?.values?.() || []) {
      const url = safeHttpsUrl(attachment.url);
      const contentType = String(attachment.contentType || "");
      const looksLikeImage =
        contentType.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(url);
      if (looksLikeImage) {
        attachments.push(
          renderImage(await archiveImage(url), attachment.name || "訊息圖片"),
        );
      } else if (url) {
        attachments.push(
          `<a class="file" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(attachment.name || "下載附件")}</a>`,
        );
      }
    }

    const embeds = [];
    for (const embed of message.embeds || []) {
      const fields = (embed.fields || [])
        .map(
          (field) =>
            `<div class="embed-field"><strong>${escapeHtml(field.name)}</strong><div>${formatContent(field.value)}</div></div>`,
        )
        .join("");
      const imageUrl = embed.image?.url || embed.thumbnail?.url || "";
      embeds.push(`
        <section class="embed">
          ${embed.author?.name ? `<div class="embed-author">${escapeHtml(embed.author.name)}</div>` : ""}
          ${embed.title ? `<h3>${escapeHtml(embed.title)}</h3>` : ""}
          ${embed.description ? `<div>${formatContent(embed.description)}</div>` : ""}
          ${fields}
          ${renderImage(await archiveImage(imageUrl), embed.title || "嵌入圖片", "embed-image")}
          ${embed.footer?.text ? `<small>${escapeHtml(embed.footer.text)}</small>` : ""}
        </section>`);
    }

    const stickerImages = [];
    for (const sticker of message.stickers?.values?.() || []) {
      stickerImages.push(
        renderImage(await archiveImage(sticker.url), sticker.name || "貼圖", "sticker"),
      );
    }

    const avatarUrl = safeHttpsUrl(
      message.author?.displayAvatarURL?.({ extension: "png", size: 128 }) || "",
    );
    const timestamp = new Date(message.createdTimestamp).toLocaleString(
      "zh-TW",
      { timeZone: "Asia/Taipei", hour12: false },
    );
    renderedMessages.push(`
      <article class="message" id="message-${escapeHtml(message.id)}">
        <img class="avatar" src="${escapeHtml(avatarUrl)}" alt="">
        <div class="message-body">
          <header><strong>${escapeHtml(message.member?.displayName || message.author?.globalName || message.author?.tag || "未知使用者")}</strong><time>${escapeHtml(timestamp)}</time></header>
          <div class="content">${formatContent(message.content)}</div>
          ${embeds.join("")}
          ${attachments.join("")}
          ${stickerImages.join("")}
        </div>
      </article>`);
  }

  const generatedAt = new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
  });
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; media-src https: data:;">
  <title>${escapeHtml(channelName)}｜Discord 訂單存檔</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}.page{width:min(980px,100%);margin:auto;padding:28px 18px 64px}.archive-head{position:sticky;top:0;z-index:2;padding:18px 20px;margin-bottom:16px;border:1px solid #3f4147;border-radius:16px;background:#2b2d31ee;backdrop-filter:blur(12px)}h1{margin:0 0 6px;color:#f2f3f5;font-size:22px}.meta{color:#949ba4;font-size:13px}.message{display:flex;gap:14px;padding:14px 16px;border-radius:10px}.message:hover{background:#2b2d31}.avatar{width:42px;height:42px;border-radius:50%;background:#313338;object-fit:cover}.message-body{min-width:0;flex:1}header{display:flex;align-items:baseline;gap:10px;color:#f2f3f5}time{color:#949ba4;font-size:12px}.content{overflow-wrap:anywhere}.content a,.file{color:#00a8fc}.embed{max-width:680px;margin-top:8px;padding:12px 14px;border-left:4px solid #5c64f4;border-radius:4px;background:#2b2d31}.embed h3{margin:2px 0 6px}.embed-field{margin-top:10px}.embed small{display:block;margin-top:10px;color:#b5bac1}.archive-image,.embed-image{display:block;max-width:min(680px,100%);max-height:720px;margin-top:10px;border-radius:8px;object-fit:contain;background:#111}.sticker{width:160px;max-height:160px;object-fit:contain}.file{display:block;margin-top:8px}@media(max-width:560px){.page{padding:12px 6px 40px}.message{padding:12px 8px}.avatar{width:36px;height:36px}.archive-head{border-radius:10px}}
  </style>
</head>
<body><main class="page">
  <section class="archive-head"><h1>#${escapeHtml(channelName)}</h1><div class="meta">${escapeHtml(guildName)} · ${messages.length} 則訊息 · 存檔時間 ${escapeHtml(generatedAt)}</div></section>
  ${renderedMessages.join("\n")}
</main></body></html>`;
}

module.exports = {
  DEFAULT_INLINE_IMAGE_BUDGET,
  buildDiscordArchiveHtml,
  classifyOrderArchive,
  downloadDiscordImage,
  escapeHtml,
  fetchAllChannelMessages,
};
