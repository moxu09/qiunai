// 綠界付款抽（APP）：官網把 payment_kind 'draw' 的 ecpay_service_payments 標為 paid 後，由既有的綠界補償迴圈
// 呼叫這裡。抽獎／轉 ASD 全在資料庫程序 app_paid_draw_fulfill（以 merchant_trade_no 冪等）完成；bot 只負責
// 一番賞 S／A 的公開播報（與 APP 相同文字與頻道），且只在非重送結果播一次。APP 付款單沒有客人頻道，不發任何私訊或頻道訊息。
const { safeText } = require("./discordSafeText");
const { PERMANENT_FAILURE_PREFIX } = require("./ecpay");
const { parseRecipientIds } = require("./appPrizeClaims");

const BROADCAST_CHANNEL_ID = "1575175224612225115";
const ANONYMOUS_NAME = "匿名老闆";
const BROADCAST_TIERS = new Set(["S", "A"]);
// app_paid_draw_fulfill（20261126120000_app_paid_draws.sql）中不會自己好轉的錯誤：付款單資料不符，需人工核對。
// 「付款尚未完成」與連線／逾時等其他錯誤都可在下一輪重試。
const PERMANENT_ERRORS = [
  "付款單編號格式錯誤", "找不到付款單", "付款單不是抽獎付款", "付款單抽獎資料無效", "付款單會員資料無效",
  "付款金額與抽獎內容不符", "付款單店家資料無效", "只能單抽或十抽", "一番賞只限秋奈", "一番賞付款抽一次只能抽一張", "卡池權重設定錯誤",
];
const isPermanentError = message => PERMANENT_ERRORS.some(text => message.includes(text));

const clean = (value, max) => [...String(value ?? "").replace(/[\p{C}\s]+/gu, " ").trim()].slice(0, max).join("").trim();
const normalizeTier = tier => typeof tier === "string" ? tier.trim().replace(/賞$/, "").trim().toUpperCase() : "";

function broadcastChannelId(env) {
  const configured = String(env.ICHIBAN_BROADCAST_CHANNEL_ID || "").trim();
  return /^\d{17,20}$/.test(configured) ? configured : BROADCAST_CHANNEL_ID;
}

function createAppPaidDrawFulfiller({ supabase, client, env = process.env, log = message => console.error(message) }) {
  async function paymentMetadata(payment) {
    if (payment.metadata && typeof payment.metadata === "object") return payment.metadata;
    const { data, error } = await supabase.from("ecpay_service_payments").select("metadata")
      .eq("merchant_trade_no", payment.platform_order_id).maybeSingle();
    if (error) throw new Error(error.message || "無法讀取付款單資料");
    return data?.metadata && typeof data.metadata === "object" ? data.metadata : {};
  }

  async function announce(payment, result) {
    const first = Array.isArray(result.results) ? result.results[0] || {} : {};
    const tier = normalizeTier(result.tier ?? first.tier);
    const prizeName = clean(result.prizeName ?? first.prizeName ?? first.prize_name ?? first.name, 100);
    if (result.outcome !== "drawn" || result.kind !== "ichiban" || !BROADCAST_TIERS.has(tier) || !prizeName) return "skipped";
    const metadata = await paymentMetadata(payment);
    const anonymous = metadata.broadcast?.anonymous !== false;
    const displayName = anonymous ? ANONYMOUS_NAME : clean(metadata.displayName, 32) || ANONYMOUS_NAME;
    const requestId = String(metadata.requestId || payment.entity_key || "");
    if (requestId) {
      // 首頁跑馬燈紀錄，同時以 request_id 擋重複播報；寫入失敗只記錄，非重送結果仍照播。
      const { data, error } = await supabase.from("app_draw_broadcasts").upsert(
        { request_id: requestId, brand: "qiunai", tier, prize_name: prizeName, display_name: displayName, anonymous },
        { onConflict: "request_id", ignoreDuplicates: true },
      ).select("request_id");
      if (error) log(`[ECPAY][DRAW] 播報紀錄寫入失敗 ${payment.platform_order_id}: ${String(error.message || error).slice(0, 200)}`);
      else if (!Array.isArray(data) || data.length === 0) return "duplicate";
    }
    const channel = await client.channels.fetch(broadcastChannelId(env));
    if (!channel?.send) throw new Error("找不到大獎播報頻道");
    await channel.send({
      content: `🎉 恭喜 ${safeText(displayName, 64)} 在 APP 一番賞抽中 ${tier} 賞｜${safeText(prizeName, 200)}！`,
      allowedMentions: { parse: [] },
    });
    return "posted";
  }

  return async function fulfilPaidDraw(payment) {
    if (payment?.provider !== "ecpay" || payment?.payment_kind !== "draw") throw new Error("此付款單不是綠界抽獎付款單");
    const { data: result, error } = await supabase.rpc("app_paid_draw_fulfill", { p_merchant_trade_no: payment.platform_order_id });
    // 錯誤一律拋出，由 processPaidFulfillment 標記失敗；可重試的下一輪補償再試，需人工核對的（permanent）不再重試。
    if (error || !result) {
      const message = String(error?.message || "資料庫未回傳結果").slice(0, 300);
      const permanent = Boolean(error) && isPermanentError(message);
      const failure = new Error(`${permanent ? PERMANENT_FAILURE_PREFIX : ""}綠界付款抽獎入帳失敗：${message}`);
      failure.permanent = permanent;
      throw failure;
    }
    const replayed = result.already_processed === true || result.alreadyProcessed === true;
    if (!replayed) {
      try { await announce(payment, result); }
      catch (broadcastError) { log(`[ECPAY][DRAW] 大獎播報失敗 ${payment.platform_order_id}: ${String(broadcastError?.message || broadcastError).slice(0, 200)}`); }
    }
    return result;
  };
}

// 需人工核對的 draw 單：私訊老闆名單（APP_PRIZE_CLAIM_NOTIFY_USER_IDS）一次。「已通知」記在記憶體（付款單沒有多餘欄位）；
// 該單 fulfillment_error 帶 PERMANENT_FAILURE_PREFIX 後補償迴圈不再重試，因此重啟後也不會再觸發。
function createPaidDrawFailureAlert({ client, recipientIds = process.env.APP_PRIZE_CLAIM_NOTIFY_USER_IDS, log = message => console.error(message) }) {
  const recipients = parseRecipientIds(recipientIds);
  const alerted = new Set();
  return async function alertPaidDrawFailure({ payment, error }) {
    const tradeNo = String(payment?.merchant_trade_no || payment?.platform_order_id || "");
    if (payment?.payment_kind !== "draw" || !tradeNo || alerted.has(tradeNo)) return false;
    alerted.add(tradeNo);
    const userId = /^\d{17,20}$/.test(String(payment.user_id || "")) ? String(payment.user_id) : null;
    const lines = [
      `⚠️ APP 付款抽獎無法自動處理：${safeText(tradeNo, 40)}｜${safeText(Number(payment.amount) || 0, 20)} 元｜請到後台確認（客人已付款）`,
      ...(userId ? [`客人：<@${userId}>`] : []),
      `原因：${safeText(String(error?.message || error || "").replace(PERMANENT_FAILURE_PREFIX, ""), 500)}`,
    ];
    for (const id of recipients) {
      try {
        const user = await client.users.fetch(id);
        await user.send({ content: lines.join("\n"), allowedMentions: { parse: [] } });
      } catch (sendError) {
        log(`[ECPAY][DRAW] 人工核對私訊失敗 ${tradeNo} → ${id}: ${sendError?.code || sendError?.message || "unknown"}`);
      }
    }
    return true;
  };
}

module.exports = { BROADCAST_CHANNEL_ID, createAppPaidDrawFulfiller, createPaidDrawFailureAlert };
