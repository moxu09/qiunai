function groupInventoryItems(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const key = [
      item.item_name || "",
      item.rarity || "",
      item.description || "",
      item.item_type || "",
      item.expires_at || "",
      item.valid_until || "",
    ].join("||");
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += quantity;
    } else {
      grouped.set(key, { ...item, count: quantity });
    }
  }
  return [...grouped.values()];
}

function formatInventoryItemTitle(item) {
  const count = Math.max(1, Number(item?.count) || 1);
  return `• ${item?.item_name || "未知物品"}${count > 1 ? ` ×${count}` : ""}`;
}

module.exports = {
  formatInventoryItemTitle,
  groupInventoryItems,
};
