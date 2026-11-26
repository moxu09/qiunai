// /app/orders/delete：APP 的「按錯了，刪除這張單」。驗證輸入後交給 dispatchSystem 的共用核心
// customerDeleteUnpaidOrder（與 Discord 按鈕 website_order_delete_confirm_<orderId> 同一套檢查與條件更新）。
// 只限官網／APP 需求單、下單者本人、付款前；回傳穩定的 code 給 app-api。
const SNOWFLAKE = /^\d{16,22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO = /^[A-Za-z0-9_-]{1,64}$/;
const UNAVAILABLE = "暫時無法刪除，請稍後再試或聯絡客服";

function createAppOrderDelete({ remove, errors }) {
  async function deleteOrder(value) {
    const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const userId = String(body.userId ?? "");
    const orderId = body.orderId == null ? "" : String(body.orderId);
    const orderNo = body.orderNo == null ? "" : String(body.orderNo);
    if (!SNOWFLAKE.test(userId) || (orderId ? !UUID.test(orderId) : !ORDER_NO.test(orderNo))) {
      return { status: 400, body: { ok: false, code: "invalid_request", error: "請求格式錯誤" } };
    }
    const result = await remove(orderId ? { userId, orderId } : { userId, orderNo });
    if (result?.ok) return { status: 200, body: { ok: true, ...(result.alreadyDeleted ? { alreadyDeleted: true } : {}) } };
    const known = result?.code !== "unavailable" ? errors[result?.code] : null;
    if (!known) return { status: 503, body: { ok: false, code: "unavailable", error: UNAVAILABLE } };
    return { status: known.status, body: { ok: false, code: result.code, error: known.message } };
  }
  return { deleteOrder };
}

module.exports = { createAppOrderDelete, UNAVAILABLE };
