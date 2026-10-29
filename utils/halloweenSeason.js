const HALLOWEEN_START = Date.parse("2026-10-29T00:00:00+08:00");
const HALLOWEEN_END = Date.parse("2026-11-01T00:00:00+08:00");
const THEME_AUTHOR = "🎃 小奈的萬聖節｜10/31 23:59 止";
const AUTHOR_SUFFIX = " · 🎃";
function isHalloweenActive(now = Date.now()) {
  return now >= HALLOWEEN_START && now < HALLOWEEN_END;
}
function embedSize(embed) {
  return [embed.title, embed.description, embed.author?.name, embed.footer?.text,
    ...(embed.fields || []).flatMap(f => [f.name, f.value])].reduce((n, s) => n + String(s || "").length, 0);
}
function seasonalMessageBody(body, now = Date.now()) {
  if (!body || !Array.isArray(body.embeds)) return body;
  const active = isHalloweenActive(now);
  const originals = body.embeds.map(raw => typeof raw?.toJSON === "function" ? raw.toJSON() : { ...raw });
  let budget = originals.reduce((n, e) => n + embedSize(e), 0);
  const embeds = originals.map(embed => {
    if (!active) {
      if (embed.author?.name === THEME_AUTHOR) delete embed.author;
      else if (embed.author?.name?.endsWith(AUTHOR_SUFFIX)) embed.author = { ...embed.author, name: embed.author.name.slice(0, -AUTHOR_SUFFIX.length) };
      return embed;
    }
    // Keep titles, footer references, fields, amounts, links and controls intact.
    if (!embed.author && budget + THEME_AUTHOR.length <= 6000) {
      embed.author = { name: THEME_AUTHOR }; budget += THEME_AUTHOR.length;
    } else if (embed.author?.name && embed.author.name !== THEME_AUTHOR &&
        !embed.author.name.endsWith(AUTHOR_SUFFIX) && embed.author.name.length + AUTHOR_SUFFIX.length <= 256 && budget + AUTHOR_SUFFIX.length <= 6000) {
      embed.author = { ...embed.author, name: embed.author.name + AUTHOR_SUFFIX }; budget += AUTHOR_SUFFIX.length;
    }
    const statusColor = [0x57f287, 0x16a34a, 0x00ff99, 0xff0000, 0xef4444, 0xdc2626, 0xed4245, 0xe74c3c].includes(embed.color);
    if (!statusColor && !/✅|❌|⚠|失敗|取消|成功|已完成/.test(embed.title || "")) embed.color = 0xff9b3d;
    return embed;
  });
  return { ...body, embeds };
}
function installSeasonalMessages(rest, { now = Date.now } = {}) {
  if (rest.__qiunaiHalloween) return;
  rest.__qiunaiHalloween = true;
  const original = rest.request;
  rest.request = function(options) {
    const route = String(options.fullRoute || "");
    const messageRoute = /^\/channels\/\d+\/messages(?:\/\d+)?$/.test(route) || /^\/webhooks\//.test(route);
    let body = options.body;
    if (["POST", "PATCH"].includes(options.method)) {
      if (messageRoute) body = seasonalMessageBody(body, now());
      else if (/^\/interactions\/[^/]+\/[^/]+\/callback$/.test(route) && [4, 7].includes(body?.type)) {
        body = { ...body, data: seasonalMessageBody(body.data, now()) };
      }
    }
    return original.call(this, { ...options, body });
  };
}
module.exports = { HALLOWEEN_START, HALLOWEEN_END, THEME_AUTHOR, isHalloweenActive, seasonalMessageBody, installSeasonalMessages };
