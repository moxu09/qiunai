// 人工下單（含官網／APP 需求）正式派單時要送去的遊戲派單頻道。
// 頻道 ID 會因為重建頻道而失效，所以依「秋奈派單大廳」內的頻道名稱找（例如「派單｜三角洲」），
// 找不到才用寫死的 ID。英雄聯盟、傳說對決沒有專屬頻道時改送「派單｜綜合遊戲」。
const KEYWORDS = Object.freeze({
  valorant: ["特戰"],
  delta: ["三角洲"],
  lol: ["英雄聯盟", "聯盟戰棋", "lol"],
  apex: ["apex"],
  arena: ["傳說對決"],
  voice: ["語聊", "語音", "陪聊"],
  other: ["其他"],
  mixed: ["綜合"],
});
const FALLBACK_TO_MIXED = new Set(["lol", "arena"]);
const TEXT_TYPES = new Set([0, 5, "GUILD_TEXT", "GUILD_NEWS"]);

// 有專屬派單頻道以外的「遊戲」都送綜合遊戲；非遊戲（追劇陪伴、其他項目、自填）送其他類。
const MIXED_GAME_WORDS = ["steam", "pubg", "第五人格", "王者榮耀", "minecraft", "麥塊", "原神", "爐石", "valorant"];

/** Which dispatch channel key an order goes to. */
function dispatchKeyForOrder(order) {
  const game = String(order?.game || "").toLowerCase();
  const text = `${game} ${order?.service || ""} ${order?.order_item || ""}`;
  const lower = text.toLowerCase();
  if (game === "valorant" || text.includes("特戰")) return "valorant";
  if (game === "delta" || text.includes("三角洲")) return "delta";
  if (game === "lol" || game === "tft" || text.includes("英雄聯盟") || text.includes("ARAM") || text.includes("聯盟戰棋")) return "lol";
  if (/apex/i.test(text)) return "apex";
  if (text.includes("傳說對決")) return "arena";
  if (game === "voice_chat" || text.includes("語音聊天") || text.includes("陪聊")) return "voice";
  if (MIXED_GAME_WORDS.some((w) => lower.includes(w))) return "mixed";
  return "other";
}

function isDispatchChannel(channel) {
  return Boolean(channel) && TEXT_TYPES.has(channel.type) && String(channel.name || "").includes("派單");
}

/** channels: iterable of Discord channels (guild.channels.cache.values()). Returns { key: channelId } found by name. */
function resolveDispatchChannelsByName(channels) {
  const all = [...(channels || [])].filter(Boolean);
  const byId = new Map(all.map((c) => [c.id, c]));
  const candidates = all.filter(isDispatchChannel);
  const inLobby = candidates.filter((c) => String(byId.get(c.parentId)?.name || "").includes("派單大廳"));
  const pool = inLobby.length ? inLobby : candidates;
  const found = {};
  for (const [key, words] of Object.entries(KEYWORDS)) {
    const hit = pool
      .filter((c) => words.some((w) => String(c.name).toLowerCase().includes(w.toLowerCase())))
      .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))[0];
    if (hit) found[key] = hit.id;
  }
  for (const key of FALLBACK_TO_MIXED) if (!found[key] && found.mixed) found[key] = found.mixed;
  return found;
}

function createManualDispatchChannels({ defaults, guildId, getClient, refreshMs = 10 * 60 * 1000, logger = console }) {
  const current = { ...defaults };
  let refreshedAt = 0;
  let inflight = null;

  async function refresh() {
    const client = getClient();
    if (!client) return current;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return current;
    await guild.channels.fetch().catch(() => null);
    const found = resolveDispatchChannelsByName(guild.channels.cache.values());
    for (const key of Object.keys(defaults)) if (found[key]) current[key] = found[key];
    refreshedAt = Date.now();
    logger.log?.("[派單頻道] 已依名稱更新", Object.keys(found).join(","));
    return current;
  }

  /** Refresh by name when stale (or forced); never throws. */
  async function ensure({ force = false } = {}) {
    if (!force && Date.now() - refreshedAt < refreshMs) return current;
    if (!inflight) inflight = refresh().catch((e) => { logger.error?.("[派單頻道] 更新失敗", e?.message); return current; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { ids: current, ensure };
}

module.exports = { resolveDispatchChannelsByName, createManualDispatchChannels, dispatchKeyForOrder, KEYWORDS };
