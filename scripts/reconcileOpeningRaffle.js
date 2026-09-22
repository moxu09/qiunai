const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GUILD_ID = process.env.GUILD_ID || "1206138511535898654";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const DISCORD_TOKEN =
  process.env.TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;

const START_AT = "2026-06-11T16:00:00.000Z";
const END_AT = "2026-08-31T16:00:00.000Z";
const AMOUNT_PER_TICKET = 1000;
const STAFF_THRESHOLD = 2000;
const RAFFLE_TITLE = "秋奈電競陪玩店開幕抽獎｜蘋果全家桶";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 Supabase 正式環境設定");
}

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchAll(table, query = "") {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const separator = query ? "&" : "?";
    const page = await requestJson(
      `${SUPABASE_URL}/rest/v1/${table}${query}${separator}limit=${pageSize}&offset=${offset}`,
      { headers: supabaseHeaders },
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function discordDisplayName(userId) {
  if (!DISCORD_TOKEN) return "";
  const response = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`,
    { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } },
  );
  if (response.status === 404) return "";
  if (!response.ok) return "";
  const member = await response.json();
  return (
    member.nick ||
    member.user?.global_name ||
    member.user?.username ||
    ""
  );
}

async function buildReport() {
  const [vipRows, postEventLedger, members, salaryRows, playOrders] =
    await Promise.all([
      fetchAll(
        "user_vips",
        `?select=user_id,total_spent,total_topup&guild_id=eq.${GUILD_ID}`,
      ),
      fetchAll(
        "alliance_point_ledger",
        `?select=discord_user_id,source_type,qualifying_amount,created_at&source_guild_id=eq.${GUILD_ID}&point_kind=eq.reward&created_at=gte.${END_AT}`,
      ),
      fetchAll("alliance_members", "?select=discord_user_id,display_name"),
      fetchAll(
        "qiunai_salary_orders",
        `?select=discord_id,staff_name,order_id,order_amount,status,order_finished_at,is_deleted,review_decision&order_finished_at=gte.${START_AT}&order_finished_at=lt.${END_AT}`,
      ),
      fetchAll(
        "play_orders",
        `?select=customer_id,customer_username,customer_name,created_at&guild_id=eq.${GUILD_ID}&created_at=gte.${START_AT}&created_at=lt.${END_AT}`,
      ),
    ]);

  const names = new Map(
    members.map((row) => [row.discord_user_id, row.display_name || ""]),
  );
  for (const order of playOrders) {
    if (order.customer_id && !names.get(order.customer_id)) {
      names.set(
        order.customer_id,
        order.customer_name || order.customer_username || "",
      );
    }
  }

  // VIP 累積欄位是開幕後的正式累積值。活動結束後產生的正向交易要扣除；
  // 活動結束後才完成的退款／矯正則保留在目前總額中，避免退費訂單仍取得票券。
  const positiveAfterEvent = new Map();
  for (const row of postEventLedger) {
    const amount = Number(row.qualifying_amount || 0);
    if (amount <= 0 || row.source_type !== "spend") continue;
    positiveAfterEvent.set(
      row.discord_user_id,
      (positiveAfterEvent.get(row.discord_user_id) || 0) + amount,
    );
  }

  const customerRows = vipRows
    .map((row) => {
      const currentTotal = Number(row.total_spent || 0);
      const afterEvent = positiveAfterEvent.get(row.user_id) || 0;
      const eligibleAmount = Math.max(0, currentTotal - afterEvent);
      return {
        userId: row.user_id,
        displayName: names.get(row.user_id) || "",
        customerSpend: Number(row.total_spent || 0),
        customerTopup: Number(row.total_topup || 0),
        postEventPositive: afterEvent,
        customerEligibleAmount: eligibleAmount,
        customerTickets: Math.floor(eligibleAmount / AMOUNT_PER_TICKET),
      };
    })
    .filter((row) => row.customerTickets > 0);

  const staffTotals = new Map();
  for (const order of salaryRows) {
    if (order.is_deleted) continue;
    if (String(order.review_decision || "").toLowerCase() === "rejected") {
      continue;
    }
    const amount = Number(order.order_amount || 0);
    if (amount <= 0) continue;
    const current = staffTotals.get(order.discord_id) || {
      userId: order.discord_id,
      displayName: order.staff_name || names.get(order.discord_id) || "",
      staffOrderAmount: 0,
      staffOrderCount: 0,
    };
    current.staffOrderAmount += amount;
    current.staffOrderCount += 1;
    staffTotals.set(order.discord_id, current);
  }

  const staffRows = [...staffTotals.values()]
    .filter((row) => row.staffOrderAmount >= STAFF_THRESHOLD)
    .map((row) => ({
      ...row,
      staffTickets: Math.floor(row.staffOrderAmount / STAFF_THRESHOLD),
    }));

  const combined = new Map();
  for (const customer of customerRows) {
    combined.set(customer.userId, {
      ...customer,
      staffOrderAmount: 0,
      staffOrderCount: 0,
      staffTickets: 0,
    });
  }
  for (const staff of staffRows) {
    const current = combined.get(staff.userId) || {
      userId: staff.userId,
      displayName: staff.displayName,
      customerSpend: 0,
      customerTopup: 0,
      postEventPositive: 0,
      customerEligibleAmount: 0,
      customerTickets: 0,
      staffOrderAmount: 0,
      staffOrderCount: 0,
      staffTickets: 0,
    };
    current.displayName ||= staff.displayName;
    current.staffOrderAmount = staff.staffOrderAmount;
    current.staffOrderCount = staff.staffOrderCount;
    current.staffTickets = staff.staffTickets;
    combined.set(staff.userId, current);
  }

  const rows = [...combined.values()]
    .map((row) => ({
      ...row,
      totalTickets: row.customerTickets + row.staffTickets,
    }))
    .sort(
      (a, b) =>
        b.totalTickets - a.totalTickets ||
        b.customerEligibleAmount - a.customerEligibleAmount ||
        b.staffOrderAmount - a.staffOrderAmount,
    );

  const missingNames = rows.filter((row) => !row.displayName);
  for (const row of missingNames) {
    row.displayName = await discordDisplayName(row.userId);
  }

  return { customerRows, staffRows, rows };
}

async function writeReports(report, reportDirectory) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  const columns = [
    ["Discord ID", "userId"],
    ["顯示名稱", "displayName"],
    ["活動消費合計", "customerEligibleAmount"],
    ["闆闆抽獎券", "customerTickets"],
    ["陪陪接單金額", "staffOrderAmount"],
    ["陪陪有效訂單數", "staffOrderCount"],
    ["陪陪滿額加券", "staffTickets"],
    ["總抽獎券", "totalTickets"],
  ];
  const csv = [
    columns.map(([label]) => csvCell(label)).join(","),
    ...report.rows.map((row) =>
      columns.map(([, key]) => csvCell(row[key])).join(","),
    ),
  ].join("\n");
  const file = path.join(reportDirectory, "秋奈開幕抽獎券總表_2026-09-11.csv");
  fs.writeFileSync(file, `\uFEFF${csv}`, "utf8");
  return file;
}

async function insertRows(table, rows) {
  const chunkSize = 200;
  for (let index = 0; index < rows.length; index += chunkSize) {
    await requestJson(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(rows.slice(index, index + chunkSize)),
    });
  }
}

async function applyReport(report) {
  const existing = await fetchAll(
    "raffles",
    `?select=*&title=eq.${encodeURIComponent(RAFFLE_TITLE)}`,
  );
  let raffle = existing[0];
  if (!raffle) {
    const allRaffles = await fetchAll("raffles", "?select=id&order=id.desc&limit=1");
    const nextId = Number(allRaffles[0]?.id || 0) + 1;
    const created = await requestJson(`${SUPABASE_URL}/rest/v1/raffles`, {
      method: "POST",
      headers: {
        ...supabaseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        id: nextId,
        title: RAFFLE_TITLE,
        start_at: START_AT,
        end_at: END_AT,
        amount_per_ticket: AMOUNT_PER_TICKET,
        winners_count: 1,
        prize:
          "蘋果全家桶：iPhone 17 Pro Max 1TB、MacBook Air 512GB、iPad Air、AirPods Pro／Max、Netro 等",
        status: "closed",
      }),
    });
    raffle = created[0];
  }

  const [existingEntries, existingSpending] = await Promise.all([
    fetchAll("raffle_entries", `?select=id&raffle_id=eq.${raffle.id}`),
    fetchAll("raffle_spending", `?select=id&raffle_id=eq.${raffle.id}`),
  ]);
  if (
    (existingEntries.length || existingSpending.length) &&
    !process.argv.includes("--replace")
  ) {
    throw new Error("這次抽獎已經有券數資料，為避免重複匯入已停止執行");
  }

  if (process.argv.includes("--replace")) {
    for (const table of ["raffle_entries", "raffle_spending"]) {
      await requestJson(
        `${SUPABASE_URL}/rest/v1/${table}?raffle_id=eq.${raffle.id}`,
        {
          method: "DELETE",
          headers: { ...supabaseHeaders, Prefer: "return=representation" },
        },
      );
    }
    await requestJson(`${SUPABASE_URL}/rest/v1/raffles?id=eq.${raffle.id}`, {
      method: "PATCH",
      headers: {
        ...supabaseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ amount_per_ticket: AMOUNT_PER_TICKET }),
    });
  }

  await insertRows(
    "raffle_entries",
    report.rows.map((row) => ({
      raffle_id: raffle.id,
      user_id: row.userId,
      amount: row.customerEligibleAmount,
      tickets: row.totalTickets,
    })),
  );
  await insertRows(
    "raffle_spending",
    report.rows.map((row) => ({
      raffle_id: raffle.id,
      user_id: row.userId,
      total_amount: row.customerEligibleAmount,
      tickets: row.totalTickets,
      remainder: row.customerEligibleAmount % AMOUNT_PER_TICKET,
    })),
  );
  return raffle;
}

async function main() {
  const reportDirectory =
    process.env.RAFFLE_REPORT_DIR ||
    path.join(
      "/Users/moxu/Documents/Codex/2026-08-31/new-chat-2",
      "reports",
    );
  const report = await buildReport();
  const reportFile = await writeReports(report, reportDirectory);
  const result = {
    reportFile,
    customerCount: report.customerRows.length,
    customerTickets: report.customerRows.reduce(
      (sum, row) => sum + row.customerTickets,
      0,
    ),
    staffCount: report.staffRows.length,
    staffTickets: report.staffRows.reduce(
      (sum, row) => sum + row.staffTickets,
      0,
    ),
    uniqueParticipants: report.rows.length,
    totalTickets: report.rows.reduce((sum, row) => sum + row.totalTickets, 0),
  };
  if (process.argv.includes("--apply")) {
    result.raffle = await applyReport(report);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
