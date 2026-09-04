const { createHmac, timingSafeEqual } = require("node:crypto");

const DEFAULT_CALLBACK_IPS = [
  "125.227.158.50",
  "220.133.77.56",
  "59.124.107.103",
  "35.194.172.6",
  "35.244.159.28",
  "175.99.130.66",
  "125.227.158.49",
  "175.99.130.82",
  "35.187.144.191",
];

function signJkopayPayload(payload, secretKey) {
  return createHmac("sha256", String(secretKey || ""))
    .update(String(payload || ""), "utf8")
    .digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeIp(value) {
  const ip = String(value || "").trim();
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function getRequestIp(request) {
  return normalizeIp(request.headers["x-real-ip"] || request.socket?.remoteAddress);
}

function parseCallbackIps(value) {
  const configured = String(value || "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_CALLBACK_IPS);
}

function isAllowedCallbackIp(ip, allowedIps) {
  return allowedIps.has(normalizeIp(ip));
}

function buildPlatformOrderId(topupNo) {
  const normalized = String(topupNo || "").trim().toUpperCase();
  if (!/^TOP-\d{10,}$/.test(normalized)) {
    throw new Error("街口儲值編號格式錯誤");
  }
  return `QIUNAI-${normalized}`;
}

function normalizeJkopayPlatformOrderId(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (/^TOP-\d{10,}$/.test(normalized)) {
    return buildPlatformOrderId(normalized);
  }
  if (!/^QIUNAI-TOP-\d{10,}$/.test(normalized)) {
    throw new Error("街口訂單編號格式錯誤");
  }
  return normalized;
}

function normalizeJkopayRefundOrderId(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (/^WASH-\d{10,}-[A-Z0-9]+$/.test(normalized)) return normalized;
  return normalizeJkopayPlatformOrderId(normalized);
}

function buildJkopayRefundPayload(platformOrderId, refundAmount) {
  const normalizedOrderId = normalizeJkopayRefundOrderId(platformOrderId);
  const amount = Number(refundAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("街口退款金額錯誤");
  }
  return {
    platform_order_id: normalizedOrderId,
    refund_amount: amount,
  };
}

function getJkopayConfig(env = process.env) {
  const config = {
    apiKey: String(env.JKOPAY_API_KEY || "").trim(),
    secretKey: String(env.JKOPAY_SECRET_KEY || "").trim(),
    storeId: String(env.JKOPAY_STORE_ID || "").trim(),
    entryUrl: String(env.JKOPAY_ENTRY_URL || "").trim(),
    inquiryUrl: String(env.JKOPAY_INQUIRY_URL || "").trim(),
    refundUrl: String(env.JKOPAY_REFUND_URL || "").trim(),
    gatewaySecret: String(env.JKOPAY_GATEWAY_SECRET || "").trim(),
    publicBaseUrl: String(env.JKOPAY_PUBLIC_BASE_URL || "")
      .trim()
      .replace(/\/$/, ""),
    callbackIps: parseCallbackIps(env.JKOPAY_CALLBACK_IPS),
  };
  config.enabled = Boolean(
    config.apiKey &&
      config.secretKey &&
      config.storeId &&
      config.entryUrl &&
      config.inquiryUrl &&
      config.publicBaseUrl,
  );
  return config;
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readTextBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function sendHtml(response, statusCode, html) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(html);
}

async function callJkopay({ url, method, payload, config }) {
  const digest = signJkopayPayload(payload, config.secretKey);
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "api-key": config.apiKey,
      digest,
    },
    body: method === "GET" ? undefined : payload,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`街口回傳非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(`街口連線失敗（HTTP ${response.status}）`);
  return data;
}

function createJkopayService({ supabase, client, onPaid, env = process.env }) {
  const config = getJkopayConfig(env);

  async function createTopupPayment({ userId, amount, topupNo, channelId }) {
    if (!config.enabled) throw new Error("街口支付尚未完成環境設定");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("儲值金額錯誤");

    const platformOrderId = buildPlatformOrderId(topupNo);
    const resultUrl = `${config.publicBaseUrl}/payments/jkopay/result`;
    const displayUrl = `${config.publicBaseUrl}/payments/jkopay/display?order=${encodeURIComponent(platformOrderId)}`;
    const payloadObject = {
      platform_order_id: platformOrderId,
      store_id: config.storeId,
      currency: "TWD",
      total_price: amount,
      final_price: amount,
      unredeem: 0,
      result_url: resultUrl,
      result_display_url: displayUrl,
      payment_type: "onetime",
      escrow: false,
      products: [
        {
          name: `秋奈 ASD 儲值 ${topupNo}`,
          unit_count: 1,
          unit_price: amount,
          unit_final_price: amount,
        },
      ],
    };

    const { data: existingOrder, error: existingError } = await supabase
      .from("jkopay_topup_orders")
      .select("platform_order_id,topup_no,user_id,amount,status,payment_url,qr_img,qr_timeout")
      .eq("platform_order_id", platformOrderId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message || "無法查詢街口付款紀錄");
    if (existingOrder) {
      if (
        String(existingOrder.user_id) !== String(userId) ||
        Number(existingOrder.amount) !== amount ||
        existingOrder.topup_no !== topupNo
      ) {
        throw new Error("街口付款編號已被其他儲值單使用");
      }
      if (existingOrder.status === "paid") throw new Error("此儲值單已完成街口付款");
      if (existingOrder.status !== "pending") throw new Error("此街口付款單已無法繼續付款");
      if (existingOrder.payment_url) {
        return {
          paymentUrl: existingOrder.payment_url,
          qrImg: existingOrder.qr_img || null,
          qrTimeout: existingOrder.qr_timeout || null,
          platformOrderId,
        };
      }
    }

    const { error: saveError } = existingOrder
      ? { error: null }
      : await supabase.from("jkopay_topup_orders").insert({
          platform_order_id: platformOrderId,
          topup_no: topupNo,
          user_id: String(userId),
          amount,
          currency: "TWD",
          channel_id: String(channelId || ""),
          status: "pending",
          updated_at: new Date().toISOString(),
        });
    if (saveError) throw new Error(saveError.message || "無法建立街口付款紀錄");

    const payload = JSON.stringify(payloadObject);
    const data = await callJkopay({
      url: config.entryUrl,
      method: "POST",
      payload,
      config,
    });
    if (data?.result !== "000" || !data?.result_object?.payment_url) {
      throw new Error(data?.message || `街口建立付款失敗（${data?.result || "unknown"}）`);
    }

    const payment = {
      paymentUrl: data.result_object.payment_url,
      qrImg: data.result_object.qr_img || null,
      qrTimeout: data.result_object.qr_timeout || null,
      platformOrderId,
    };
    const { error: updateError } = await supabase
      .from("jkopay_topup_orders")
      .update({
        payment_url: payment.paymentUrl,
        qr_img: payment.qrImg,
        qr_timeout: payment.qrTimeout,
        updated_at: new Date().toISOString(),
      })
      .eq("platform_order_id", platformOrderId);
    if (updateError) throw new Error(updateError.message || "無法保存街口付款連結");
    return payment;
  }

  async function attachPaymentMessage(platformOrderId, messageId) {
    await supabase
      .from("jkopay_topup_orders")
      .update({ payment_message_id: String(messageId), updated_at: new Date().toISOString() })
      .eq("platform_order_id", platformOrderId);
  }

  async function inquire(platformOrderId) {
    const query = `platform_order_ids=${encodeURIComponent(platformOrderId)}`;
    console.log(`[JKOPAY][INQUIRY][REQUEST] ${query}`);
    const data = await callJkopay({
      url: `${config.inquiryUrl}?${query}`,
      method: "GET",
      payload: query,
      config,
    });
    if (data?.result !== "000") {
      console.log(
        `[JKOPAY][INQUIRY][RESPONSE] ${JSON.stringify({ result: data?.result, message: data?.message || null })}`,
      );
      throw new Error(data?.message || `街口查單失敗（${data?.result || "unknown"}）`);
    }
    const transaction = (data.result_object?.transactions || []).find(
      (transaction) => transaction.platform_order_id === platformOrderId,
    );
    console.log(
      `[JKOPAY][INQUIRY][RESPONSE] ${JSON.stringify({
        result: data.result,
        platform_order_id: transaction?.platform_order_id || platformOrderId,
        status: transaction?.status ?? null,
        final_price: transaction?.final_price ?? null,
        trade_no: transaction?.tradeNo || transaction?.trade_no || null,
        trans_time: transaction?.trans_time || null,
      })}`,
    );
    return transaction;
  }

  async function inquirePayment(platformOrderId) {
    if (!config.enabled) throw new Error("街口查單尚未完成環境設定");
    const normalizedOrderId = normalizeJkopayRefundOrderId(platformOrderId);
    const transaction = await inquire(normalizedOrderId);
    if (!transaction) throw new Error("街口回傳結果中找不到這筆訂單");
    return { platformOrderId: normalizedOrderId, transaction };
  }

  async function refundTopupPayment({ platformOrderId, requestedBy }) {
    if (!config.enabled || !config.refundUrl) {
      throw new Error("街口退款尚未完成環境設定");
    }

    const normalizedOrderId = normalizeJkopayPlatformOrderId(platformOrderId);
    const { data: order, error: orderError } = await supabase
      .from("jkopay_topup_orders")
      .select("*")
      .eq("platform_order_id", normalizedOrderId)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message || "無法查詢街口付款紀錄");
    if (!order) throw new Error("找不到街口付款訂單");

    if (order.status === "refunded") {
      return {
        kind: "topup",
        alreadyProcessed: true,
        amount: Number(order.amount),
        balance: null,
        order,
        refundResult: order.raw_result?.refund?.response || null,
      };
    }
    if (order.status === "refunding") {
      throw new Error("此訂單的退款正在確認中，請勿重複操作");
    }
    if (order.status !== "paid") throw new Error("只有已付款訂單可以退款");

    const refundObject = buildJkopayRefundPayload(normalizedOrderId, order.amount);
    const payload = JSON.stringify(refundObject);
    const { data: prepared, error: prepareError } = await supabase.rpc(
      "prepare_jkopay_topup_refund",
      {
        p_platform_order_id: normalizedOrderId,
        p_refund_amount: refundObject.refund_amount,
        p_refund_request: refundObject,
        p_requested_by: String(requestedBy || ""),
      },
    );
    if (prepareError) {
      throw new Error(prepareError.message || "街口退款前置處理失敗");
    }
    if (prepared?.already_processed) {
      return {
        kind: "topup",
        alreadyProcessed: true,
        amount: refundObject.refund_amount,
        balance: Number(prepared.balance || 0),
        order,
        refundResult: prepared.refund_result || null,
      };
    }

    console.log(`[JKOPAY][REFUND][REQUEST] ${payload}`);
    let data;
    try {
      data = await callJkopay({
        url: config.refundUrl,
        method: "POST",
        payload,
        config,
      });
    } catch (error) {
      console.error(
        `[JKOPAY][REFUND][UNCERTAIN] ${normalizedOrderId}｜${error.message || error}`,
      );
      throw new Error(
        "街口退款結果不明，訂單已鎖定且 ASD 已暫時扣回；請先查單或聯繫街口，請勿重複退款",
      );
    }
    console.log(`[JKOPAY][REFUND][RESPONSE] ${JSON.stringify(data)}`);

    if (data?.result !== "000") {
      const { error: cancelError } = await supabase.rpc(
        "cancel_jkopay_topup_refund",
        {
          p_platform_order_id: normalizedOrderId,
          p_refund_result: data || {},
        },
      );
      if (cancelError) {
        console.error("[JKOPAY][REFUND] 退款失敗後恢復 ASD 失敗", cancelError);
        throw new Error("街口拒絕退款，且 ASD 恢復失敗，請立即查看 Railway Logs");
      }
      throw new Error(data?.message || `街口退款失敗（${data?.result || "unknown"}）`);
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_jkopay_topup_refund",
      {
        p_platform_order_id: normalizedOrderId,
        p_refund_result: data,
      },
    );
    if (completeError) {
      throw new Error(
        `街口退款成功，但本地訂單更新失敗：${completeError.message || "未知錯誤"}`,
      );
    }
    return {
      kind: "topup",
      alreadyProcessed: Boolean(completed?.already_processed),
      amount: refundObject.refund_amount,
      balance: Number(completed?.balance ?? prepared?.balance ?? 0),
      order,
      refundResult: data,
    };
  }

  async function refundMerchandisePayment({ platformOrderId, requestedBy }) {
    if (!config.enabled || !config.refundUrl) {
      throw new Error("街口退款尚未完成環境設定");
    }

    const normalizedOrderId = normalizeJkopayRefundOrderId(platformOrderId);
    if (!normalizedOrderId.startsWith("WASH-")) throw new Error("官網商品訂單編號格式錯誤");
    const { data: order, error: orderError } = await supabase
      .from("merchandise_orders")
      .select("*")
      .eq("platform_order_id", normalizedOrderId)
      .maybeSingle();
    if (orderError) throw new Error(orderError.message || "無法查詢官網商品付款紀錄");
    if (!order) throw new Error("找不到官網商品付款訂單");

    if (order.status === "refunded") {
      return {
        kind: "merchandise",
        alreadyProcessed: true,
        amount: Number(order.total_amount),
        order,
        refundResult: order.raw_result?.refund?.response || null,
      };
    }
    if (order.status === "refunding") {
      throw new Error("此訂單的退款正在確認中，請勿重複操作");
    }
    if (order.status !== "paid") throw new Error("只有已付款的官網商品訂單可以退款");

    const refundObject = buildJkopayRefundPayload(normalizedOrderId, order.total_amount);
    const payload = JSON.stringify(refundObject);
    const { data: prepared, error: prepareError } = await supabase.rpc(
      "prepare_jkopay_merchandise_refund",
      {
        p_platform_order_id: normalizedOrderId,
        p_refund_amount: refundObject.refund_amount,
        p_refund_request: refundObject,
        p_requested_by: String(requestedBy || ""),
      },
    );
    if (prepareError) throw new Error(prepareError.message || "官網商品退款前置處理失敗");
    if (prepared?.already_processed) {
      return {
        kind: "merchandise",
        alreadyProcessed: true,
        amount: refundObject.refund_amount,
        order,
        refundResult: prepared.refund_result || null,
      };
    }

    console.log(`[JKOPAY][MERCHANDISE_REFUND][REQUEST] ${payload}`);
    let data;
    try {
      data = await callJkopay({
        url: config.refundUrl,
        method: "POST",
        payload,
        config,
      });
    } catch (error) {
      console.error(
        `[JKOPAY][MERCHANDISE_REFUND][UNCERTAIN] ${normalizedOrderId}｜${error.message || error}`,
      );
      throw new Error(
        "街口退款結果不明，官網商品訂單已鎖定；請先查單或聯繫街口，請勿重複退款",
      );
    }
    console.log(`[JKOPAY][MERCHANDISE_REFUND][RESPONSE] ${JSON.stringify(data)}`);

    if (data?.result !== "000") {
      const { error: cancelError } = await supabase.rpc(
        "cancel_jkopay_merchandise_refund",
        {
          p_platform_order_id: normalizedOrderId,
          p_refund_result: data || {},
        },
      );
      if (cancelError) {
        console.error("[JKOPAY][MERCHANDISE_REFUND] 恢復商品訂單狀態失敗", cancelError);
        throw new Error("街口拒絕退款，且官網商品訂單狀態恢復失敗，請立即查看 Railway Logs");
      }
      throw new Error(data?.message || `街口退款失敗（${data?.result || "unknown"}）`);
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_jkopay_merchandise_refund",
      {
        p_platform_order_id: normalizedOrderId,
        p_refund_result: data,
      },
    );
    if (completeError) {
      throw new Error(
        `街口退款成功，但官網商品訂單更新失敗：${completeError.message || "未知錯誤"}`,
      );
    }
    return {
      kind: "merchandise",
      alreadyProcessed: Boolean(completed?.already_processed),
      amount: refundObject.refund_amount,
      order,
      refundResult: data,
    };
  }

  async function refundPayment({ platformOrderId, requestedBy }) {
    const normalizedOrderId = normalizeJkopayRefundOrderId(platformOrderId);
    if (normalizedOrderId.startsWith("WASH-")) {
      return refundMerchandisePayment({ platformOrderId: normalizedOrderId, requestedBy });
    }
    return refundTopupPayment({ platformOrderId: normalizedOrderId, requestedBy });
  }

  async function handleResultCallback(request, response) {
    const requestIp = getRequestIp(request);
    if (!isAllowedCallbackIp(requestIp, config.callbackIps)) {
      console.warn(`[JKOPAY] 拒絕非白名單 callback IP：${requestIp || "unknown"}`);
      sendJson(response, 403, { ok: false });
      return;
    }

    const body = await readJsonBody(request);
    const platformOrderId = String(body?.transaction?.platform_order_id || "");
    if (!platformOrderId) {
      sendJson(response, 400, { ok: false });
      return;
    }

    const { data: order, error } = await supabase
      .from("jkopay_topup_orders")
      .select("*")
      .eq("platform_order_id", platformOrderId)
      .maybeSingle();
    if (error || !order) {
      console.error("[JKOPAY] callback 找不到儲值單", error || platformOrderId);
      sendJson(response, 404, { ok: false });
      return;
    }

    const transaction = await inquire(platformOrderId);
    if (!transaction || Number(transaction.status) !== 0) {
      throw new Error("街口查單結果尚未付款成功");
    }
    if (Number(transaction.final_price) !== Number(order.amount)) {
      throw new Error("街口查單金額與儲值單不一致");
    }
    if (body.transaction?.tradeNo && !safeEqual(body.transaction.tradeNo, transaction.tradeNo)) {
      throw new Error("街口 callback 與查單交易序號不一致");
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_jkopay_topup",
      {
        p_platform_order_id: platformOrderId,
        p_trade_no: transaction.tradeNo,
        p_amount: Number(transaction.final_price),
        p_trans_time: transaction.trans_time || null,
        p_raw_result: transaction,
      },
    );
    if (completeError) throw new Error(completeError.message || "街口儲值入帳失敗");

    if (!completed?.already_processed) {
      await onPaid?.({
        order,
        transaction,
        balance: Number(completed?.balance || 0),
        alreadyProcessed: false,
      });
    }
    sendJson(response, 200, { ok: true });
  }

  async function handleDisplay(request, response, url) {
    const platformOrderId = String(url.searchParams.get("order") || "");
    const { data: order } = await supabase
      .from("jkopay_topup_orders")
      .select("topup_no,amount,status")
      .eq("platform_order_id", platformOrderId)
      .maybeSingle();
    const paid = order?.status === "paid";
    const title = paid ? "付款成功" : "付款結果確認中";
    const message = paid
      ? `已完成 ${Number(order.amount).toLocaleString("zh-TW")} ASD 儲值，可回到 Discord 查看。`
      : "系統正在向街口確認付款結果，請回到 Discord 稍候通知。";
    sendHtml(
      response,
      200,
      `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}｜秋奈電競</title><style>body{margin:0;background:#111827;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh}.card{max-width:520px;margin:24px;padding:36px;border-radius:20px;background:#1f2937;text-align:center;box-shadow:0 20px 50px #0006}h1{color:${paid ? "#34d399" : "#fbbf24"}}p{line-height:1.8;color:#d1d5db}.no{font-family:monospace;color:#93c5fd}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p><p class="no">${order?.topup_no || ""}</p></main></body></html>`,
    );
  }

  function authorizeGateway(request) {
    const authorization = String(request.headers.authorization || "");
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    return Boolean(config.gatewaySecret) && safeEqual(supplied, config.gatewaySecret);
  }

  async function handleMerchandiseGateway(request, response, pathname) {
    if (!authorizeGateway(request)) {
      sendJson(response, 401, { result: "401", message: "unauthorized" });
      return;
    }

    if (pathname.endsWith("/entry")) {
      const payload = await readTextBody(request);
      const order = JSON.parse(payload);
      const resultOrigin = new URL(String(order.result_url || "")).origin;
      const displayOrigin = new URL(String(order.result_display_url || "")).origin;
      if (
        !String(order.platform_order_id || "").startsWith("WASH-") ||
        order.store_id !== config.storeId ||
        resultOrigin !== "https://www.wearestilllhere.com" ||
        displayOrigin !== "https://www.wearestilllhere.com" ||
        !Number.isInteger(order.total_price) ||
        order.total_price <= 0 ||
        order.total_price !== order.final_price ||
        order.unredeem !== 0
      ) {
        sendJson(response, 400, { result: "400", message: "invalid_order" });
        return;
      }
      const data = await callJkopay({
        url: config.entryUrl,
        method: "POST",
        payload,
        config,
      });
      sendJson(response, 200, data);
      return;
    }

    const body = await readJsonBody(request);
    const platformOrderId = String(body.platform_order_id || "");
    if (!/^WASH-[A-Z0-9-]+$/.test(platformOrderId)) {
      sendJson(response, 400, { result: "400", message: "invalid_order_id" });
      return;
    }
    if (pathname.endsWith("/refund")) {
      const refundAmount = Number(body.refund_amount);
      if (!config.refundUrl || !Number.isInteger(refundAmount) || refundAmount <= 0) {
        sendJson(response, 400, { result: "400", message: "invalid_refund" });
        return;
      }
      const payload = JSON.stringify({
        platform_order_id: platformOrderId,
        refund_amount: refundAmount,
      });
      const data = await callJkopay({
        url: config.refundUrl,
        method: "POST",
        payload,
        config,
      });
      sendJson(response, 200, data);
      return;
    }

    const query = `platform_order_ids=${encodeURIComponent(platformOrderId)}`;
    const data = await callJkopay({
      url: `${config.inquiryUrl}?${query}`,
      method: "GET",
      payload: query,
      config,
    });
    sendJson(response, 200, data);
  }

  async function handleHttpRequest(request, response) {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/payments/jkopay/result" && request.method === "POST") {
      try {
        await handleResultCallback(request, response);
      } catch (error) {
        console.error("[JKOPAY] callback 處理失敗", error);
        sendJson(response, 500, { ok: false });
      }
      return true;
    }
    if (url.pathname === "/payments/jkopay/display" && request.method === "GET") {
      await handleDisplay(request, response, url);
      return true;
    }
    if (
      request.method === "POST" &&
      [
        "/payments/jkopay/gateway/entry",
        "/payments/jkopay/gateway/inquiry",
        "/payments/jkopay/gateway/refund",
      ].includes(url.pathname)
    ) {
      await handleMerchandiseGateway(request, response, url.pathname);
      return true;
    }
    return false;
  }

  return {
    attachPaymentMessage,
    config,
    createTopupPayment,
    handleHttpRequest,
    inquire,
    inquirePayment,
    refundTopupPayment,
    refundMerchandisePayment,
    refundPayment,
  };
}

module.exports = {
  DEFAULT_CALLBACK_IPS,
  buildJkopayRefundPayload,
  buildPlatformOrderId,
  createJkopayService,
  getJkopayConfig,
  isAllowedCallbackIp,
  normalizeJkopayPlatformOrderId,
  normalizeJkopayRefundOrderId,
  parseCallbackIps,
  signJkopayPayload,
};
