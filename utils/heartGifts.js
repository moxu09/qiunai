const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const GUILD_ID = "1206138511535898654";
const BROADCAST_CHANNEL_ID = "1226103044895412244";
const UPGRADE_ART_CHANNEL_ID = "1529591891329286246";
const UPGRADE_ART_GUILD_ID = "1513174069087047731";
const HEART = "<:I_cn_b02:1221687963621265451>";
const ENABLED = process.env.QIUNAI_HEART_GIFTS_ENABLED === "1";
const CUSTOM_HEART_GIFT = Object.freeze({
  key: "heart:custom",
  name: "自訂心動禮物",
  emoji: "💗",
  customPrice: true,
});
const MAX_HEART_ALLOCATION = 2_147_483_647;
const TIERS = [
  [520, "1226143428002316389", "1529591998548545536"],
  [1314, "1226143498164633662", "1529592089447370803"],
  [2460, "1226143660308041748", "1529592174314786888"],
  [3888, "1226143754260578315", "1529592229314826271"],
  [5200, "1226143843741597766", "1529592324999479397"],
  [13140, "1226143937362657321", "1529592411184173197"],
  [26914, "1226144053209468968", "1529592459569528892"],
  [52000, "1226144189939453992", "1529592549143216128"],
  [131400, "1226144357900619816", "1529592584169717914"],
  [201314, "1226131081892462604", "1529592624573452450"],
];

function crossedTiers(previous, current) {
  return TIERS.filter(([points]) => previous < points && current >= points);
}

async function checked(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function createHeartGifts({ client, supabase, fetchImage = fetch }) {
  const checkoutTable = () => supabase.from("qiunai_heart_checkouts");
  let running = false;

  async function checkout(flowId, channelId) {
    return checked(checkoutTable().select("*").eq("flow_id", flowId).eq("channel_id", channelId).maybeSingle());
  }

  async function prepareCheckout(flowId, tip, allocations, paymentMethod) {
    if (tip.guildId !== GUILD_ID || allocations.length === 0) throw new Error("心動值打賞資料不完整");
    const giftByKey = new Map(tip.heartGifts.map(gift => [gift.key, gift]));
    if (tip.customPriceSet && !tip.customPriceRequired) {
      for (const gift of tip.gifts || []) {
        if (gift.customPrice && Number.isSafeInteger(gift.price) && gift.price > 0 &&
            gift.price <= 999_999_999 && !giftByKey.has(gift.key) &&
            (gift.key === CUSTOM_HEART_GIFT.key || gift.key === `${CUSTOM_HEART_GIFT.key}:${gift.price}`)) {
          giftByKey.set(gift.key, { ...gift, emoji: CUSTOM_HEART_GIFT.emoji });
        }
      }
    }
    const validated = allocations.map(allocation => {
      const lines = allocation.lines.map(line => {
        const gift = giftByKey.get(line.key);
        if (!gift || gift.price !== line.price || !Number.isSafeInteger(line.quantity) ||
            line.quantity < 1 || line.quantity > 999 || line.subtotal !== gift.price * line.quantity) {
          throw new Error("心動禮物的價格或數量不正確");
        }
        return { key: gift.key, name: gift.name, emoji: gift.emoji, quantity: line.quantity, points: line.subtotal };
      });
      if (!lines.length || !Number.isSafeInteger(allocation.amount) || allocation.amount <= 0 ||
          allocation.amount > MAX_HEART_ALLOCATION ||
          lines.reduce((sum, line) => sum + line.points, 0) !== allocation.amount) {
        throw new Error("心動值打賞的金額不正確");
      }
      return { staffId: allocation.staffId, item: allocation.item, amount: allocation.amount, lines };
    });
    const record = {
      flow_id: flowId,
      buyer_id: tip.tipperId,
      channel_id: tip.channelId,
      allocations: validated,
      payment_method: paymentMethod,
      broadcast: Boolean(tip.broadcastEnabled),
      anonymous: Boolean(tip.broadcastAnonymous),
    };
    await checked(checkoutTable().upsert(record, { onConflict: "flow_id", ignoreDuplicates: true }));
    const saved = await checkout(flowId, tip.channelId);
    if (!saved || !Object.keys(record).every(key => isDeepStrictEqual(saved[key], record[key]))) {
      throw new Error("此筆心動值打賞已建立付款明細，請使用原付款訊息");
    }
  }

  async function updateJob(job, owner, changes) {
    const rows = await checked(supabase.from("qiunai_heart_delivery").update(changes)
      .eq("event_id", job.event_id).eq("kind", job.kind).eq("lease_owner", owner)
      .gt("lease_until", new Date().toISOString()).select("event_id"));
    if (!rows.length) throw new Error("心動值任務已由其他程序接手");
  }

  async function broadcast(job, tiers, owner) {
    if (!job.broadcast) return;
    const channel = await client.channels.fetch(BROADCAST_CHANNEL_ID);
    if (!channel?.isTextBased() || channel.guildId !== GUILD_ID) throw new Error("找不到心動播報頻道");
    const sender = job.anonymous ? "匿名闆闆" : `<@${job.buyer_id}>`;
    const receiver = `<@${job.staff_id}>`;
    const allowedMentions = { parse: [], users: job.anonymous ? [job.staff_id] : [job.buyer_id, job.staff_id] };
    const gifts = job.lines.map(line => [line.name, line.quantity > 1 ? `×${line.quantity}` : "", line.emoji].filter(Boolean).join(" ")).join("、");
    const totalLabel = job.opening_verified ? "累積心動值" : "已核對的累積心動值";
    const messages = {
      gift: `**感謝 ${sender} 送給\n${receiver} 的 ${gifts}\n增加心動值${job.points} ${HEART}\n${totalLabel}${job.total} ${HEART}**`,
    };
    const latest = tiers.at(-1);
    if (latest) {
      const [points, role] = latest;
      messages.upgrade = `**${HEART}                     親密度升級                   ${HEART}\n${sender}          &      ${receiver}\n心動值達到${points} ${HEART}\n<:B_cn_12:1237145581521211503> 解鎖雙人專屬TAG <@&${role}> **`;
    }
    const messageIds = { ...job.message_ids };
    for (const [key, content] of Object.entries(messages)) {
      if (messageIds[key]) continue;
      const nonce = createHash("sha256").update(`qiunai-heart:${job.event_id}:${key}`).digest("hex").slice(0, 25);
      const payload = { content, allowedMentions, nonce, enforceNonce: true };
      if (key === "upgrade") {
        const [points, , artworkMessageId] = latest;
        const artworkChannel = await client.channels.fetch(UPGRADE_ART_CHANNEL_ID);
        if (!artworkChannel?.isTextBased() || artworkChannel.guildId !== UPGRADE_ART_GUILD_ID) {
          throw new Error("找不到心動值圖片頻道");
        }
        // Fetch the original message for a fresh Discord attachment URL on each attempt.
        const artwork = await artworkChannel.messages.fetch({ message: artworkMessageId, force: true });
        const image = artwork.attachments.find(attachment => attachment.contentType === "image/png");
        if (!image?.url) throw new Error("找不到心動值升等圖片");
        const response = await fetchImage(image.url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png") {
          throw new Error("心動值升等圖片下載失敗");
        }
        payload.files = [{ attachment: Buffer.from(await response.arrayBuffer()), name: `heart-${points}.png` }];
      }
      const message = await channel.send(payload);
      messageIds[key] = message.id;
      await updateJob(job, owner, { message_ids: messageIds });
    }
  }

  async function grantRoles(job, tiers) {
    if (!tiers.length) return;
    const guild = await client.guilds.fetch(GUILD_ID);
    const id = job.kind === "buyer_roles" ? job.buyer_id : job.staff_id;
    const member = await guild.members.fetch({ user: id, force: true });
    for (const [, role] of tiers) {
      if (!member.roles.cache.has(role)) await member.roles.add(role, "心動值達到門檻");
    }
  }

  async function deliver() {
    if (running) return;
    running = true;
    const owner = randomUUID();
    try {
      const jobs = await checked(supabase.rpc("qiunai_claim_heart_delivery", { p_owner: owner }));
      for (const job of jobs) {
        try {
          const tiers = crossedTiers(job.previous_total, job.total);
          if (job.kind === "broadcast") await broadcast(job, tiers, owner);
          else await grantRoles(job, tiers);
          await updateJob(job, owner, { done_at: new Date().toISOString(), lease_owner: null, lease_until: null });
        } catch (error) {
          const delay = Math.min(3600, 20 * 2 ** Math.min(job.attempts, 8));
          await updateJob(job, owner, {
            next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
            lease_owner: null,
            lease_until: null,
          }).catch(() => {});
          console.warn("[心動值] 任務待重試", job.event_id, job.kind, error.code || error.name);
        }
      }
    } finally {
      running = false;
    }
  }

  return { checkout, prepareCheckout, deliver };
}

module.exports = { ENABLED, GUILD_ID, BROADCAST_CHANNEL_ID, CUSTOM_HEART_GIFT, createHeartGifts, crossedTiers };
