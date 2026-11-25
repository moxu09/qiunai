// Customer-supplied text shown in 小奈 DMs: neutralise mention syntax (<@id>, <@&id>, <#id> would
// render as chips even with allowedMentions off) with a zero-width space after '<', clip the RAW text
// first, then markdown-escape — so a cut never leaves a dangling backslash — and shrink until the
// escaped result fits `max` (Discord embed field limit 1024).
const { escapeMarkdown } = require("discord.js");

const OPTIONS = { maskedLink: true, heading: true, bulletedList: true, numberedList: true };
const ZWSP = "​";

const neutraliseMentions = text => text.replace(/<(?=[@#])/g, `<${ZWSP}`);

function safeText(value, max = 1024) {
  const chars = [...neutraliseMentions(String(value ?? "").trim())];
  const render = keep => escapeMarkdown(chars.slice(0, keep).join(""), OPTIONS) + (keep < chars.length ? "…" : "");
  const whole = render(chars.length);
  if (whole.length <= max) return whole;
  // Escaping is not strictly monotone, so binary-search the longest raw prefix whose output fits.
  let best = render(0);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = render(mid);
    if (out.length <= max) { best = out; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

module.exports = { safeText, neutraliseMentions };
