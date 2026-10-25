const assert = require('node:assert/strict');
const test = require('node:test');
const { getCommission } = require('../scripts/reconcileMissingSalaryOrders');

function db({ credits = [], activity = null, walletError = null } = {}) {
  return { from(table) {
    let rows = credits;
    const query = {
      select() { return query; },
      eq(k, v) { if (table === 'salary_wallet_entries') rows = rows.filter(r => r[k] === v); return query; },
      in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return query; },
      not() { return query; }, lte() { return query; }, gt() { return query; },
      gte(k, v) { rows = rows.filter(r => r[k] >= v); return query; },
      lt(k, v) { rows = rows.filter(r => r[k] < v); return query; },
      order() { return query; },
      async range(start, end) { return { data: rows.slice(start, end + 1), error: walletError }; },
      async maybeSingle() { assert.equal(table, 'salary_activity_commission_settings'); return { data: activity, error: null }; },
    };
    assert.ok(['salary_wallet_entries', 'salary_activity_commission_settings'].includes(table));
    return query;
  } };
}
const credit = (amount, date, extra = {}) => ({ app_key: 'qiunai', discord_id: 'staff', entry_type: 'order_salary', settlement_date: date, amount, ...extra });
const at = '2026-10-01T00:00:00+08:00';

test('salary repair qualifies at 10000 credited last month, includes corrections and excludes bonuses', async () => {
  const client = db({ credits: [credit(9000, '2026-09-01'), credit(1000, '2026-09-30', { entry_type: 'salary_correction' }), credit(20000, '2026-08-31'), credit(20000, '2026-10-01'), credit(5000, '2026-09-01', { entry_type: 'staff_bonus' })] });
  assert.equal((await getCommission({}, 'staff', at, [], client)).rate, 85);
  assert.equal((await getCommission({}, 'staff', '2026-11-01T00:00:00+08:00', [], db({ credits: [credit(9999, '2026-10-01')] }))).rate, 80);
  assert.equal((await getCommission({}, 'staff', at, [], db({ credits: [credit(10000, '2026-09-01'), credit(-1, '2026-09-30', { entry_type: 'salary_correction' })] }))).rate, 80);
});

test('salary repair preserves manual, annual and higher activity commission', async () => {
  assert.equal((await getCommission({ commission_tier: 'manager_95' }, 'staff', at, [], db())).rate, 95);
  assert.equal((await getCommission({}, 'staff', at, [{ discord_id: 'staff', order_finished_at: '2025-06-01T00:00:00+08:00', staff_salary: 100000 }], db())).rate, 90);
  assert.equal((await getCommission({}, 'staff', at, [], db({ activity: { activity_rate: 90 } }))).rate, 90);
});

test('salary repair stops on wallet query failure instead of assigning 80 percent', async () => {
  await assert.rejects(getCommission({}, 'staff', at, [], db({ walletError: new Error('ledger unavailable') })), /ledger unavailable/);
});
