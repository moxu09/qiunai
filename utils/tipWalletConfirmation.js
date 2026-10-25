// Lock the whole flow, not just the debit: concurrent button clicks must not
// both publish the post-payment messages after the atomic RPC returns.
function createTipWalletConfirmationRunner() {
  const active = new Set();
  return async function run(key, work, onBusy) {
    if (active.has(key)) return onBusy();
    active.add(key);
    try {
      return await work();
    } finally {
      active.delete(key);
    }
  };
}

module.exports = { createTipWalletConfirmationRunner };
