const { createHash } = require('node:crypto');
const VIP_CHANNEL_ID = '1313770637587644507';
function rewardDeliveryKey(reward) {
  return `${reward.guild_id}:${reward.user_id}:${reward.level_key}`;
}
async function sendVipChannelDelivery({ supabase, client, reward, embed, channelId }) {
  const identity = { guild_id:String(reward.guild_id), user_id:String(reward.user_id), level_key:String(reward.level_key) };
  const query = () => supabase.from('qiunai_vip_channel_deliveries').select('message_id,channel_id')
    .eq('guild_id',identity.guild_id).eq('user_id',identity.user_id).eq('level_key',identity.level_key).maybeSingle();
  const saved = await query();
  if (saved.error) throw saved.error;
  if (saved.data) return saved.data;
  channelId = reward.notification_channel_id || channelId;
  const unavailable = error => [10003,50001,50013].includes(Number(error?.code));
  let channel;
  if (channelId && channelId !== VIP_CHANNEL_ID) {
    try { channel = await client.channels.fetch(channelId); }
    catch (error) { if (!unavailable(error)) throw error; }
  }
  if (channel && channel.guildId !== identity.guild_id) throw new Error('VIP 升級播報頻道不屬於秋奈');
  if (!channel?.isTextBased()) channel = null;
  const key = rewardDeliveryKey(reward);
  embed.setFooter({ text:`VIP:${key}` });
  const payload = { content:`<@${identity.user_id}>`, embeds:[embed],
    nonce:createHash('sha256').update(key).digest('hex').slice(0,24),enforceNonce:true,
    allowedMentions:{ users:[identity.user_id],parse:[] } };
  async function sendOnce(destination) {
    const recent = await destination.messages.fetch({ limit:100 });
    const existing = recent.find(m => m.author?.id === client.user.id && m.embeds?.some(e => e.footer?.text === `VIP:${key}`));
    return existing || destination.send(payload);
  }
  let message;
  if (channel) {
    try { message = await sendOnce(channel); }
    catch (error) { if (!unavailable(error)) throw error; channel = null; }
  }
  if (!channel) {
    const user = await client.users.fetch(identity.user_id);
    channel = await user.createDM();
    message = await sendOnce(channel);
  }
  channelId = channel.id || channelId;
  const result = await supabase.from('qiunai_vip_channel_deliveries').upsert({ ...identity,channel_id:channelId,message_id:message.id },
    { onConflict:'guild_id,user_id,level_key',ignoreDuplicates:true });
  if (result.error) throw result.error;
  return { channel_id:channelId,message_id:message.id };
}
module.exports = { VIP_CHANNEL_ID,rewardDeliveryKey,sendVipChannelDelivery };
