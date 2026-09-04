function getManualCommissionRate(tier) {
  return {
    rate_80: 80,
    rate_85: 85,
    rate_90: 90,
    manager_95: 95,
  }[tier] || null;
}

function getOrderCommissionBase(order = {}) {
  return Number(order.price || order.order_amount || order.final_price || 0);
}

function chooseHigherCommission(baseCommission, activityCommission) {
  if (
    activityCommission &&
    Number(activityCommission.rate || 0) > Number(baseCommission?.rate || 0)
  ) {
    return activityCommission;
  }
  return baseCommission;
}

module.exports = {
  chooseHigherCommission,
  getManualCommissionRate,
  getOrderCommissionBase,
};
