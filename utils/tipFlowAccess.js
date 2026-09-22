function canOperateTipFlow({ actorId, creatorId, isCustomerService = false }) {
  const actor = String(actorId || "").trim();
  const creator = String(creatorId || "").trim();
  return Boolean(actor && ((creator && actor === creator) || isCustomerService));
}

module.exports = { canOperateTipFlow };
