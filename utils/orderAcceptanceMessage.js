const { ActionRowBuilder } = require('discord.js');

function acceptanceState(order) {
  const count = new Set(String(order.assigned_player || '').split(',').map(id => id.trim()).filter(Boolean)).size;
  const required = Math.max(1, Number(order.player_count) || 1);
  const full = count >= required;
  const closed = !order.paid || !['pending', 'accepted'].includes(order.status);
  return { count, required, disabled: full || closed,
    label: full ? '已接單' : closed ? '已停止接單' : count ? `接單（${count}/${required}，剩 ${required - count} 位）` : '接單' };
}

// Serialize edits per order and reload the persisted roster instead of using a click's stale snapshot.
function createAcceptanceMessageSync({ loadOrder }) {
  const pending = new Map();
  return function syncAcceptanceMessage(message, orderId) {
    const previous = pending.get(orderId) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      if (!message?.edit) throw new Error('找不到原接單訊息，無法更新按鈕');
      const customId = `accept_play_order_${orderId}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const order = await loadOrder(orderId);
          if (!order) throw new Error('找不到訂單，停止更新接單按鈕');
          const state = acceptanceState(order);
          let found = false;
          const components = (message.components || []).map(row => {
            const data = typeof row.toJSON === 'function' ? row.toJSON() : row;
            const builder = ActionRowBuilder.from(data);
            for (const component of builder.components) {
              if (component.data.custom_id !== customId) continue;
              found = true;
              component.setLabel(state.label).setDisabled(state.disabled);
            }
            return builder;
          });
          if (!found) throw new Error('原訊息沒有對應訂單的接單按鈕');
          await message.edit({ components });
          // A different bot process may have accepted the final slot while the edit was in flight.
          const latest = await loadOrder(orderId);
          if (latest && JSON.stringify(acceptanceState(latest)) === JSON.stringify(state)) return state;
          if (attempt === 2) throw new Error('接單名單仍在變更，按鈕同步尚未完成');
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    });
    pending.set(orderId, job);
    return job.finally(() => { if (pending.get(orderId) === job) pending.delete(orderId); });
  };
}
module.exports = { acceptanceState, createAcceptanceMessageSync };
