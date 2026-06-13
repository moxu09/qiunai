const cron = require("node-cron");

function getTaipeiDayRange() {
  const now = new Date();

  const taipeiDateString = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Taipei",
  });

  const start = new Date(`${taipeiDateString}T00:00:00+08:00`);
  const end = new Date(`${taipeiDateString}T23:59:59.999+08:00`);

  return {
    dateText: taipeiDateString,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function money(value) {
  return Number(value || 0).toLocaleString("zh-TW");
}

function getStaffName(staff) {
  return (
    staff.display_name ||
    staff.real_name ||
    staff.discord_name ||
    staff.discord_id ||
    "未知員工"
  );
}

function getOrderStaffName(order) {
  return order.staff_name || order.discord_id || "未知員工";
}

function buildPersonalReport({ dateText, staff, orders, extraBonuses }) {
  const staffName = getStaffName(staff);

  const totalOrderAmount = orders.reduce(
    (sum, order) => sum + Number(order.order_amount || 0),
    0
  );

  const totalSalary = orders.reduce(
    (sum, order) => sum + Number(order.staff_salary || 0),
    0
  );

  const orderBonus = orders.reduce(
    (sum, order) => sum + Number(order.bonus_amount || 0),
    0
  );

  const extraBonusTotal = extraBonuses.reduce(
    (sum, bonus) => sum + Number(bonus.amount || 0),
    0
  );

  const totalBonus = orderBonus + extraBonusTotal;
  const finalTotal = totalSalary + totalBonus;

  const orderLines =
    orders.length === 0
      ? "今日沒有完成訂單"
      : orders
          .slice(0, 15)
          .map((order, index) => {
            return `${index + 1}. ${order.service_name || "未命名服務"}｜訂單 $${money(
              order.order_amount
            )}｜薪資 $${money(order.staff_salary)}${
              Number(order.bonus_amount || 0) > 0
                ? `｜獎金 $${money(order.bonus_amount)}`
                : ""
            }`;
          })
          .join("\n");

  const bonusLines =
    extraBonuses.length === 0
      ? ""
      : "\n\n額外獎金：\n" +
        extraBonuses
          .slice(0, 10)
          .map((bonus, index) => {
            return `${index + 1}. ${bonus.title}｜$${money(bonus.amount)}${
              bonus.note ? `｜${bonus.note}` : ""
            }`;
          })
          .join("\n");

  return {
    content:
      `秋奈電競｜個人每日薪資報告\n\n` +
      `日期：${dateText}\n` +
      `員工：${staffName}\n\n` +
      `今日完成訂單：${orders.length} 筆\n` +
      `今日訂單總額：$${money(totalOrderAmount)}\n` +
      `今日接單薪資：$${money(totalSalary)}\n` +
      `今日獎金：$${money(totalBonus)}\n` +
      `今日合計：$${money(finalTotal)}\n\n` +
      `訂單明細：\n${orderLines}` +
      bonusLines,
    summary: {
      staffName,
      orderCount: orders.length,
      totalOrderAmount,
      totalSalary,
      totalBonus,
      finalTotal,
    },
  };
}

function buildAdminReport({ dateText, orders, extraBonuses }) {
  const totalIncome = orders.reduce(
    (sum, order) => sum + Number(order.platform_income || order.order_amount || 0),
    0
  );

  const totalSalary = orders.reduce(
    (sum, order) => sum + Number(order.staff_salary || 0),
    0
  );

  const orderBonus = orders.reduce(
    (sum, order) => sum + Number(order.bonus_amount || 0),
    0
  );

  const extraBonusTotal = extraBonuses.reduce(
    (sum, bonus) => sum + Number(bonus.amount || 0),
    0
  );

  const totalBonus = orderBonus + extraBonusTotal;

  const totalExpense = orders.reduce((sum, order) => {
    const expense = Number(
      order.platform_expense ||
        Number(order.staff_salary || 0) + Number(order.bonus_amount || 0)
    );

    return sum + expense;
  }, 0) + extraBonusTotal;

  const profit = totalIncome - totalExpense;

  const staffMap = new Map();

  for (const order of orders) {
    const key = order.discord_id;
    const old = staffMap.get(key) || {
      name: getOrderStaffName(order),
      orderCount: 0,
      income: 0,
      salary: 0,
      bonus: 0,
    };

    old.orderCount += 1;
    old.income += Number(order.order_amount || 0);
    old.salary += Number(order.staff_salary || 0);
    old.bonus += Number(order.bonus_amount || 0);

    staffMap.set(key, old);
  }

  for (const bonus of extraBonuses) {
    const key = bonus.discord_id;
    const old = staffMap.get(key) || {
      name: bonus.staff_name || bonus.discord_id || "未知員工",
      orderCount: 0,
      income: 0,
      salary: 0,
      bonus: 0,
    };

    old.bonus += Number(bonus.amount || 0);
    staffMap.set(key, old);
  }

  const staffLines =
    staffMap.size === 0
      ? "今日沒有員工薪資資料"
      : Array.from(staffMap.values())
          .sort((a, b) => b.salary + b.bonus - (a.salary + a.bonus))
          .map((item) => {
            return `${item.name}｜${item.orderCount} 單｜薪資 $${money(
              item.salary
            )}｜獎金 $${money(item.bonus)}｜合計 $${money(
              item.salary + item.bonus
            )}`;
          })
          .join("\n");

  return (
    `秋奈電競｜每日總報告\n\n` +
    `日期：${dateText}\n\n` +
    `今日完成訂單：${orders.length} 筆\n` +
    `今日總收入：$${money(totalIncome)}\n` +
    `今日總支出：$${money(totalExpense)}\n` +
    `今日預估利潤：$${money(profit)}\n` +
    `今日薪資：$${money(totalSalary)}\n` +
    `今日獎金：$${money(totalBonus)}\n\n` +
    `員工統計：\n${staffLines}`
  );
}

async function safeSendToChannel(client, channelId, content) {
  if (!channelId) return false;

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      console.warn(`[QIUNAI_REPORT] 頻道不可用或不是文字頻道：${channelId}`);
      return false;
    }

    const chunks = splitMessage(content, 1900);

    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    return true;
  } catch (error) {
    console.error(`[QIUNAI_REPORT] 發送頻道失敗：${channelId}`, error);
    return false;
  }
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function sendQiunaiDailySalaryReports(client, supabase) {
  const { dateText, startIso, endIso } = getTaipeiDayRange();
  console.log(`[QIUNAI_REPORT] 開始發送秋奈每日薪資報告：${dateText}`);

  const { data: staffList, error: staffError } = await supabase
    .from("qiunai_staff")
    .select("*")
    .eq("is_active", true)
    .not("salary_channel_id", "is", null);
  if (staffError) {
    console.error("[QIUNAI_REPORT] 讀取 qiunai_staff 失敗", staffError);
    return;
  }

  const { data: todayOrders, error: orderError } = await supabase
    .from("qiunai_salary_orders")
    .select("*")
    .gte("order_finished_at", startIso)
    .lte("order_finished_at", endIso)
    .order("order_finished_at", { ascending: true });

  if (orderError) {
    console.error("[QIUNAI_REPORT] 讀取 qiunai_salary_orders 失敗", orderError);
    return;
  }

  const { data: todayBonuses, error: bonusError } = await supabase
    .from("qiunai_staff_bonus")
    .select("*")
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: true });

  if (bonusError) {
    console.error("[QIUNAI_REPORT] 讀取 qiunai_staff_bonus 失敗", bonusError);
    return;
  }

  const staffs = staffList || [];
  const staffDiscordIds = new Set(
    staffs
      .map(staff => String(staff.discord_id || "").trim())
      .filter(Boolean) 
  );
  const orders = (todayOrders || []).filter(order =>
    staffDiscordIds.has(String(order.discord_id || "").trim())
  );
  const bonuses = (todayBonuses || []).filter(bonus =>
    staffDiscordIds.has(String(bonus.discord_id || "").trim())
  );
  let successCount = 0;
  let failCount = 0;

  for (const staff of staffs) {
    const personalOrders = orders.filter(
      (order) => order.discord_id === staff.discord_id
    );

    const personalBonuses = bonuses.filter(
      (bonus) => bonus.discord_id === staff.discord_id
    );

    if (personalOrders.length === 0 && personalBonuses.length === 0) {
      continue;
    }

    const report = buildPersonalReport({
      dateText,
      staff,
      orders: personalOrders,
      extraBonuses: personalBonuses,
    });

    const ok = await safeSendToChannel(
      client,
      staff.salary_channel_id,
      report.content
    );

    if (ok) successCount += 1;
    else failCount += 1;
  }

  const { data: setting, error: settingError } = await supabase
    .from("qiunai_salary_settings")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (settingError) {
    console.error("[QIUNAI_REPORT] 讀取 qiunai_salary_settings 失敗", settingError);
  }

  if (setting?.report_channel_id) {
    const adminReport = buildAdminReport({
      dateText,
      orders,
      extraBonuses: bonuses,
    });

    await safeSendToChannel(client, setting.report_channel_id, adminReport);
  }

  console.log(
    `[QIUNAI_REPORT] 發送完成，成功 ${successCount}，失敗 ${failCount}`
  );
}

function startQiunaiSalaryReportCron(client, supabase) {
  const timezone = process.env.QIUNAI_TIMEZONE || "Asia/Taipei";

  cron.schedule(
    "59 23 * * *",
    async () => {
      try {
        await sendQiunaiDailySalaryReports(client, supabase);
      } catch (error) {
        console.error("[QIUNAI_REPORT] 排程執行失敗", error);
      }
    },
    {
      timezone,
    }
  );

  console.log(`[QIUNAI_REPORT] 已啟動每日 23:59 秋奈薪資報告排程｜${timezone}`);
}

module.exports = {
  startQiunaiSalaryReportCron,
  sendQiunaiDailySalaryReports,
};