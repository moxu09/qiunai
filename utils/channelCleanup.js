function isUnknownChannel(error) {
  return Number(error?.code) === 10003;
}

async function deleteChannelIfPresent({ client, channelId, channel, reason }) {
  if (!channelId) return false;
  try {
    const target = typeof client?.channels?.fetch === "function"
      ? await client.channels.fetch(channelId)
      : channel;
    if (!target || typeof target.delete !== "function") return false;
    await target.delete(reason);
    return true;
  } catch (error) {
    // 另一個關閉流程可能已刪除相同頻道；缺少權限等真正錯誤仍須回報。
    if (isUnknownChannel(error)) return false;
    throw error;
  }
}

function scheduleChannelDeletion(interaction, delayMs, {
  reason,
  onError = (error) => console.error("[刪除頻道失敗]", error),
} = {}) {
  // interaction.channel 是依快取取得的 getter；延遲執行時可能已經變成 null。
  const channel = interaction.channel;
  const channelId = interaction.channelId || channel?.id;
  const client = interaction.client || channel?.client;
  const timer = setTimeout(async () => {
    try {
      await deleteChannelIfPresent({ client, channelId, channel, reason });
    } catch (error) {
      onError(error);
    }
  }, delayMs);
  timer.unref?.();
  return timer;
}

module.exports = { deleteChannelIfPresent, scheduleChannelDeletion };
