function firstRpcObject(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
}

function rewardIdentity(operation) {
  const guildId = String(operation?.guild_id || "");
  const userId = String(operation?.user_id || "");
  const levelKey = String(operation?.level_key || "");
  if (!guildId || !userId || !levelKey) {
    throw new Error("VIP 獎勵派送資料不完整");
  }
  return { guildId, userId, levelKey };
}

function createVipRewardCoordinator({ supabase, deliver, notificationChannelId = null }) {
  if (!supabase?.rpc || typeof deliver !== "function") {
    throw new Error("VIP 獎勵協調器設定不完整");
  }

  async function deliverPersisted(operation) {
    const { guildId, userId, levelKey } = rewardIdentity(operation);
    const { data, error } = await supabase.rpc(
      "qiunai_claim_vip_reward_delivery",
      {
        p_guild_id: guildId,
        p_user_id: userId,
        p_level_key: levelKey,
      },
    );
    if (error) throw new Error(error.message || "鎖定 VIP 獎勵派送失敗");
    const claim = firstRpcObject(data);
    if (!claim?.claimed) return { state: claim?.state || "processing" };
    let reward = claim.operation || operation;
    const attempt = Number(claim.attempt || reward.delivery_attempts || 0);
    try {
      if (notificationChannelId && notificationChannelId !== '1313770637587644507' && !reward.notification_channel_id) {
        const route = await supabase.from('bot_vip_reward_operations')
          .update({notification_channel_id: String(notificationChannelId)})
          .eq('organization_code', 'qiunai').eq('guild_id', guildId).eq('user_id', userId).eq('level_key', levelKey)
          .is('notification_channel_id', null);
        if (route.error) throw route.error;
        const stored = await supabase.from('bot_vip_reward_operations').select('notification_channel_id')
          .eq('organization_code', 'qiunai').eq('guild_id', guildId).eq('user_id', userId).eq('level_key', levelKey).single();
        if (stored.error) throw stored.error;
        reward = {...reward, notification_channel_id: stored.data.notification_channel_id};
      }
      await deliver(reward);
      const completed = await supabase.rpc(
        "qiunai_complete_vip_reward_delivery",
        {
          p_guild_id: guildId,
          p_user_id: userId,
          p_level_key: levelKey,
          p_attempt: attempt,
        },
      );
      if (completed.error) {
        throw new Error(completed.error.message || "完成 VIP 獎勵派送標記失敗");
      }
      return { state: "completed" };
    } catch (deliveryError) {
      await supabase.rpc("qiunai_fail_vip_reward_delivery", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_level_key: levelKey,
        p_attempt: attempt,
        p_error: String(deliveryError.message || deliveryError).slice(0, 1500),
      });
      throw deliveryError;
    }
  }

  async function applyAndDeliver(parameters) {
    const { data, error } = await supabase.rpc(
      "qiunai_apply_vip_level_reward",
      parameters,
    );
    if (error) throw new Error(error.message || "VIP 升等獎勵原子發放失敗");
    const operation = firstRpcObject(data);
    if (!operation) throw new Error("VIP 升等獎勵未回傳持久操作");
    if (operation.historical_claim) return { state: "completed", historicalClaim: true };
    return deliverPersisted(operation);
  }

  return { applyAndDeliver, deliverPersisted };
}

module.exports = { createVipRewardCoordinator, firstRpcObject, rewardIdentity };
