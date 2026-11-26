// /app/orders/extend-dispatch：APP 的「延長 5 分鐘（限一次）」。驗證輸入後交給 dispatchSystem 的共用核心
// （與 Discord 按鈕 self_selection_extend_<orderId> 同一套檢查、樂觀更新、重排逾時、停用按鈕、討論串通知）。
const SNOWFLAKE = /^\d{16,22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO = /^[A-Za-z0-9_-]{1,64}$/;
const UNAVAILABLE = "延長選人時間暫時無法完成，請稍後再試";

function createAppDispatchExtend({ extend, errors }) {
  async function extendDispatch(value) {
    const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const userId = String(body.userId ?? "");
    const orderId = body.orderId == null ? "" : String(body.orderId);
    const orderNo = body.orderNo == null ? "" : String(body.orderNo);
    if (!SNOWFLAKE.test(userId) || (orderId ? !UUID.test(orderId) : !ORDER_NO.test(orderNo))) {
      return { status: 400, body: { ok: false, code: "invalid_request", error: "請求格式錯誤" } };
    }
    const result = await extend(orderId ? { userId, orderId } : { userId, orderNo });
    if (result?.ok) {
      return { status: 200, body: { ok: true, deadlineAt: new Date(result.deadlineAt).toISOString() } };
    }
    const known = errors[result?.code];
    if (!known) return { status: 503, body: { ok: false, code: "unavailable", error: UNAVAILABLE } };
    return { status: known.status, body: { ok: false, code: result.code, error: known.message } };
  }
  return { extendDispatch };
}

module.exports = { createAppDispatchExtend, UNAVAILABLE };
