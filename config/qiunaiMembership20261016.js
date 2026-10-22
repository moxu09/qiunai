// Runtime activation requires the matching version on the stored guild policy.
// Source: guild 1206138511535898654, channel 1313770637587644507.
const snapshot = require("./qiunaiMembership20261016.snapshot.json");
const MEMBERSHIP_POLICY_VERSION = "20261016";
const ROLE_KEYS = {
  "1559589209692709025": "vip0", "1210649576860680252": "vip1",
  "1207687433085526066": "vip2", "1210177011205668874": "vip3",
  "1210177201811492915": "vip4", "1210177474940506122": "vip5",
  "1210177695908896778": "vip6", "1247229551373979648": "vip7",
  "1247230114375405579": "vip8", "1269203802892800020": "vip9",
  "1273529740598444098": "vip10", "1275121811180228690": "vvip1",
  "1275121906084876308": "vvip2", "1275122057348255805": "vvip3",
  "1275122220619927582": "vvip4", "1275122360625791036": "vvip5",
  "1318540663675158548": "evip", "1513303489470529576": "exclusive",
};
const ORDER = ["vip0", ...Array.from({ length: 10 }, (_, i) => `vip${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `vvip${i + 1}`), "evip", "exclusive"];

function compileMembershipPolicy(source = snapshot) {
  const byRole = new Map(source.roles.map(role => [role.id, role.name]));
  const policies = [];
  for (const message of source.messages) {
    const headers = [...message.content.matchAll(/^(?:\*\*)?<@&(\d+)>\s*(?:\*\*)?\s*$/gm)];
    for (let i = 0; i < headers.length; i++) {
      const roleId = headers[i][1];
      const key = ROLE_KEYS[roleId];
      if (!key) continue;
      const description = message.content.slice(headers[i].index + headers[i][0].length,
        headers[i + 1]?.index ?? message.content.length).trim();
      const plain = description.replaceAll("*", "").replaceAll(",", "").replaceAll("％", "%");
      const invited = key === "exclusive";
      const spend = plain.match(/累積消費\s*(\d+)/)?.[1] ?? plain.match(/消費累積\s*(\d+)/)?.[1];
      const topup = plain.match(/單次購買(?:星雨幣|雨幣)\s*(\d+)/)?.[1];
      const cashback = plain.match(/(?:每筆消費|所有訂單)回饋\s*(\d+)%/)?.[1] || 0;
      if (!spend || (!invited && !topup) || !byRole.has(roleId)) throw new Error(`會員公告資料不完整：${key}`);
      policies.push({ levelKey: key, roleId, name: byRole.get(roleId), sortOrder: ORDER.indexOf(key) + 1,
        totalSpendRequired: Number(spend), singleTopupRequired: topup ? Number(topup) : null,
        cashbackPercent: Number(cashback), invitationOnly: invited,
        invitationLimit: invited ? 20 : null,
        monthlyInvitationThreshold: invited ? 1000000 : null,
        averageMonthlySpendRequirement: invited ? 100000 : null,
        multiPlayerMinimum: /點三個陪陪/.test(plain) ? 3 : null,
        multiPlayerBonusPercent: Number(plain.match(/額外`?(\d+)%點數回饋/)?.[1] || 0),
        description, sourceMessageId: message.id,
        sourceUpdatedAt: message.editedAt || message.createdAt });
    }
  }
  if (policies.length !== ORDER.length || new Set(policies.map(row => row.levelKey)).size !== ORDER.length)
    throw new Error("會員公告級別不完整或重複，禁止切換");
  return policies.sort((a, b) => a.sortOrder - b.sortOrder);
}

const MEMBERSHIP_LEVELS = compileMembershipPolicy();
function nonNegativeMoney(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必須是非負整數`);
  return value;
}
function getMembershipPromotion({ totalSpent, highestSingleTopup, currentLevelKey = null }, levels = MEMBERSHIP_LEVELS) {
  nonNegativeMoney(totalSpent, "累積消費"); nonNegativeMoney(highestSingleTopup, "單次購幣");
  const current = currentLevelKey ? levels.find(level => level.levelKey === currentLevelKey) : null;
  if (currentLevelKey && !current) throw new Error("既有會員級別不明，禁止自動變更");
  const eligible = levels.filter(level => !level.invitationOnly &&
    (totalSpent >= level.totalSpendRequired || highestSingleTopup >= level.singleTopupRequired));
  const best = eligible.at(-1) || null;
  if (current && (!best || current.sortOrder >= best.sortOrder))
    return { level: current, promoted: false, newlyCrossed: [] };
  return { level: best, promoted: Boolean(best), newlyCrossed: eligible.filter(level => level.sortOrder > (current?.sortOrder || 0)) };
}

function calculateMembershipCashback({ paidAmount, levelKey, playerCount = 1 }, levels = MEMBERSHIP_LEVELS) {
  nonNegativeMoney(paidAmount, "實付金額");
  if (!Number.isSafeInteger(playerCount) || playerCount < 1) throw new Error("陪陪人數格式錯誤");
  const level = levels.find(row => row.levelKey === levelKey);
  if (!level) return 0;
  const extra = level.multiPlayerMinimum && playerCount >= level.multiPlayerMinimum ? level.multiPlayerBonusPercent : 0;
  return Math.round((paidAmount * (level.cashbackPercent + extra) / 100 + Number.EPSILON) * 100) / 100;
}

function usesMembershipPolicy(levels) {
  return levels.some(level => level.guild_id === snapshot.guildId &&
    level.membership_policy_version === MEMBERSHIP_POLICY_VERSION);
}

function applyMembershipPolicy(levels) {
  const matching = levels.filter(level => level.guild_id === snapshot.guildId &&
    level.membership_policy_version === MEMBERSHIP_POLICY_VERSION);
  if (matching.length !== MEMBERSHIP_LEVELS.length || MEMBERSHIP_LEVELS.some(policy =>
    !matching.some(level => level.level_key === policy.levelKey && level.role_id === policy.roleId)))
    throw new Error("正式會員設定尚未完整套用，暫停升等以避免錯發");
  return levels.map(level => {
    if (level.guild_id !== snapshot.guildId) return level;
    const policy = MEMBERSHIP_LEVELS.find(row => row.levelKey === level.level_key);
    if (!policy) throw new Error("會員級別不在核對過的公告內");
    return { ...level, level_name: policy.name, sort_order: policy.sortOrder,
      total_spend_required: policy.totalSpendRequired, single_topup_required: policy.singleTopupRequired,
      invitation_only: policy.invitationOnly, reward_asd: 0, reward_points: 0,
      reward_note: policy.description };
  });
}

function shouldIssueMembershipReward({ level, oldSortOrder, newSortOrder, operationState }) {
  if (level.invitation_only || Number(level.sort_order) > newSortOrder) return false;
  // Only durable, unfinished operations may retry below the current level.
  // Missing historical rows are NOT permission to issue the new benefit again.
  if (Number(level.sort_order) <= oldSortOrder) return Boolean(operationState && operationState !== "completed");
  return operationState !== "completed";
}

module.exports = { MEMBERSHIP_POLICY_VERSION, MEMBERSHIP_LEVELS, compileMembershipPolicy,
  getMembershipPromotion, calculateMembershipCashback, usesMembershipPolicy,
  applyMembershipPolicy, shouldIssueMembershipReward };
