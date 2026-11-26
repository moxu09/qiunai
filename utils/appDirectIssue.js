// /app/ecpay/direct-issue: app-api asks the bot to fetch the 超商代碼／超商條碼／ATM 繳費資訊 for a payment row the APP
// created (綠界付款抽 or 超商／ATM 儲值). The website's direct-issue route only accepts the bot's service-key signature,
// so the bot relays the request. Only rows marked metadata.flow "app" + metadata.issue "direct" whose chosen method
// matches are relayed; the website still enforces one code per row, amounts and status.
const { createHmac } = require("node:crypto");

const METHOD = { barcode: "BARCODE", cvs: "CVS", atm: "ATM" };
const ORDER_RE = /^[A-Za-z0-9]{1,20}$/;

function createAppDirectIssue({ db, baseUrl = process.env.ECPAY_PUBLIC_BASE_URL || "https://www.wearestilllhere.com",
  signingKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = globalThis.fetch, timeoutMs = 45_000, logger = console } = {}) {
  async function issue(value) {
    const order = String(value?.order || "");
    const method = String(value?.method || "");
    if (!ORDER_RE.test(order) || !Object.values(METHOD).includes(method)) return { status: 400, body: { error: "缺少付款資料" } };
    const key = signingKey();
    if (!key) return { status: 503, body: { error: "付款服務尚未完成設定" } };
    const { data: row, error } = await db.from("ecpay_service_payments")
      .select("merchant_trade_no,status,metadata").eq("merchant_trade_no", order).maybeSingle();
    if (error) return { status: 503, body: { error: "付款資料暫時讀不到，請稍後再試" } };
    const meta = row?.metadata || {};
    if (!row || meta.flow !== "app" || meta.issue !== "direct" || METHOD[meta.method] !== method)
      return { status: 404, body: { error: "找不到這筆 APP 付款單" } };
    const body = JSON.stringify({ order, method, timestamp: Math.floor(Date.now() / 1000) });
    const signature = createHmac("sha256", key).update(body).digest("hex");
    let response;
    try {
      response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/payments/ecpay/service/direct-issue`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Ecpay-Bot-Signature": signature },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      logger.error?.("[APP 取號轉送] 官網連線失敗", order, e?.name);
      return { status: 504, body: { error: "官網連線逾時" } };
    }
    const data = await response.json().catch(() => null);
    return { status: response.status, body: data && typeof data === "object" ? data : { error: "官網回應格式錯誤" } };
  }
  return { issue };
}

module.exports = { createAppDirectIssue };
