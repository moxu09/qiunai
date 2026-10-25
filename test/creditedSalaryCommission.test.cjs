const assert = require("node:assert/strict");
const test = require("node:test");
const { getTaipeiMonthWindow, getMonthlyCreditedSalary } = require("../utils/creditedSalaryCommission");

function walletClient(entries) {
  return {
    from(table) {
      assert.equal(table, "salary_wallet_entries");
      let rows = entries;
      const query = {
        select() { return query; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return query; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query; },
        gte(key, value) { rows = rows.filter(row => row[key] >= value); return query; },
        lt(key, value) { rows = rows.filter(row => row[key] < value); return query; },
        order() { return query; },
        async range(start, end) { return { data: rows.slice(start, end + 1), error: null }; },
      };
      return query;
    },
  };
}

test("85% uses the immediately preceding credited month and expires after one month", async () => {
  const row = (amount, settlement_date, entry_type = "order_salary", extra = {}) =>
    ({ app_key: "qiunai", discord_id: "staff", amount, settlement_date, entry_type, ...extra });
  const client = walletClient([
    row(50000, "2026-08-31"), row(9000, "2026-09-01"),
    row(1000, "2026-09-30", "salary_correction"), row(6000, "2026-09-30", "staff_bonus"),
    row(30000, "2026-09-30", "order_salary", { app_key: "deepnight" }),
    row(30000, "2026-09-30", "order_salary", { discord_id: "other" }),
    row(9999, "2026-10-01"), row(50000, "2026-11-01"),
  ]);
  assert.equal(await getMonthlyCreditedSalary(client, "staff", "2026-10-01T00:00:00+08:00", -1), 10000);
  assert.equal(await getMonthlyCreditedSalary(client, "staff", "2026-11-01T00:00:00+08:00", -1), 9999);
  assert.equal(await getMonthlyCreditedSalary(client, "staff", "2026-10-01T00:00:00+08:00"), 9999);
});

test("Taipei midnight and January correctly switch the eligible month", () => {
  assert.equal(getTaipeiMonthWindow("2026-09-30T15:59:59Z").month, "2026-09");
  assert.deepEqual(getTaipeiMonthWindow("2026-09-30T16:00:00Z", -1), {
    month: "2026-09", startDate: "2026-09-01", endDate: "2026-10-01",
  });
  assert.deepEqual(getTaipeiMonthWindow("2027-01-01T00:00:00+08:00", -1), {
    month: "2026-12", startDate: "2026-12-01", endDate: "2027-01-01",
  });
});

test("all pages of salary credits are included and corrections can reduce eligibility", async () => {
  const rows = Array.from({ length: 1001 }, () => ({
    app_key: "qiunai", discord_id: "staff", amount: 10,
    entry_type: "order_salary", settlement_date: "2026-09-30",
  }));
  rows.push({ ...rows[0], amount: -20, entry_type: "salary_correction" });
  assert.equal(await getMonthlyCreditedSalary(walletClient(rows), "staff", "2026-10-01T00:00:00+08:00", -1), 9990);
});
