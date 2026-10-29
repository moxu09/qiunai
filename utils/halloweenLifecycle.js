const fs = require("node:fs");
const path = require("node:path");
const { Routes } = require("discord.js");
const { HALLOWEEN_END, isHalloweenActive } = require("./halloweenSeason");
const ORGANIZATION = "qiunai:seasonal-theme", KEY = "halloween-2026";
const NICKNAME = "🎃 小奈｜萬聖節";
function createHalloweenLifecycle({ client, db, guildIds, refreshPanels, now = Date.now, logger = console, fetchAvatar = fetch }) {
  let busy = false, timer, deadlineTimer;
  const table = () => db.from("bot_service_order_flows");
  const scoped = query => query.eq("organization_code", ORGANIZATION).eq("flow_id", KEY);
  async function load() {
    const { data, error } = await scoped(table().select("payload")).maybeSingle();
    if (error) throw error;
    return data?.payload || null;
  }
  async function save(state) {
    const { error } = await scoped(table().update({ payload: state, updated_at: new Date(now()).toISOString() }));
    if (error) throw error;
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let state = await load();
      if (isHalloweenActive(now())) {
        if (!state) {
          const response = await fetchAvatar(client.user.displayAvatarURL({ extension: "png", size: 512 }), { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error("無法保存小奈原始頭像");
          const nicknames = {};
          for (const guild of guildIds) nicknames[guild] = (await client.rest.get(Routes.guildMember(guild, client.user.id))).nick ?? null;
          state = { botId: client.user.id, avatar: `data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`, nicknames, applied: false, restored: false };
          const { error } = await table().insert({ organization_code: ORGANIZATION, flow_id: KEY, payload: state, expires_at: "2099-01-01T00:00:00Z" });
          if (error?.code === "23505") state = await load();
          else if (error) throw error;
        }
        if (state.botId !== client.user.id) throw new Error("萬聖節頭像備份不屬於目前小奈");
        if (!state.applied) {
          if (!state.avatarApplied) {
            await client.user.setAvatar(fs.readFileSync(path.join(__dirname, "..", "assets/halloween-bot-avatar.png")));
            state.avatarApplied = true; await save(state);
          }
          state.nicknamesApplied ||= {};
          for (const guild of Object.keys(state.nicknames)) {
            if (state.nicknamesApplied[guild]) continue;
            await client.rest.patch(Routes.guildMember(guild, "@me"), { body: { nick: NICKNAME } });
            state.nicknamesApplied[guild] = true; await save(state);
          }
          state.applied = true; await save(state);
        }
      }
      if (now() >= HALLOWEEN_END && state && !state.restored) {
        if (state.botId !== client.user.id) throw new Error("萬聖節頭像備份不屬於目前小奈");
        if (!state.avatarRestored) {
          await client.user.setAvatar(state.avatar);
          state.avatarRestored = true; await save(state);
        }
        state.nicknamesRestored ||= {};
        for (const [guild, nick] of Object.entries(state.nicknames)) {
          if (state.nicknamesRestored[guild]) continue;
          await client.rest.patch(Routes.guildMember(guild, "@me"), { body: { nick } });
          state.nicknamesRestored[guild] = true; await save(state);
        }
        await refreshPanels();
        state.restored = true; await save(state);
      }
      if (now() >= HALLOWEEN_END && (!state || state.restored)) {
        clearInterval(timer); clearTimeout(deadlineTimer);
      }
    } finally { busy = false; }
  }
  function safelyTick() { void tick().catch(error => logger.error("[萬聖節主題] 將自動重試", { code: error?.code || "unknown" })); }
  return {
    tick,
    async start() {
      timer = setInterval(safelyTick, 60000); timer.unref?.();
      if (now() < HALLOWEEN_END) {
        deadlineTimer = setTimeout(safelyTick, HALLOWEEN_END - now() + 10); deadlineTimer.unref?.();
      }
      await tick();
    },
    stop() { clearInterval(timer); clearTimeout(deadlineTimer); },
  };
}
module.exports = { createHalloweenLifecycle, NICKNAME };
