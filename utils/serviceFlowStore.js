const { ORDER_FLOW_TTL_MS } = require("./orderFlow");
const revision = Symbol("serviceFlowRevision");
const conflict = () => new Error("訂單流程已更新，請使用最新訊息再試一次。");

function createServiceFlowStore(supabase, { organization = "qiunai", now = Date.now } = {}) {
  const table = () => supabase.from("bot_service_order_flows");
  function scope(query, id) {
    return query.eq("organization_code", organization).eq("flow_id", String(id));
  }
  function hydrate(row) {
    if (!row || row.closed_at || Date.parse(row.expires_at) <= now()) return undefined;
    const value = structuredClone(row.payload);
    Object.defineProperty(value, revision, { value: row.revision, writable: true });
    return value;
  }
  return {
    async get(id) {
      const { data, error } = await scope(table().select("*"), id).maybeSingle();
      if (error) throw new Error("暫時無法讀取訂單流程，請稍後再試。", { cause: error });
      return hydrate(data);
    },
    async isClosed(id) {
      const { data, error } = await scope(table().select("closed_at"), id).maybeSingle();
      if (error) throw new Error("暫時無法讀取訂單流程，請稍後再試。", { cause: error });
      return Boolean(data?.closed_at);
    },
    async set(id, value, { expiresAt } = {}) {
      const expected = value[revision];
      const payload = JSON.parse(JSON.stringify(value));
      const at = new Date(now()).toISOString();
      const expiry = new Date(expiresAt ?? now() + ORDER_FLOW_TTL_MS).toISOString();
      const query = expected === undefined
        ? table().insert({ organization_code: organization, flow_id: String(id), payload,
          revision: 1, expires_at: expiry })
        : scope(table().update({ payload, revision: expected + 1, updated_at: at,
          ...(expiresAt === undefined ? {} : { expires_at: expiry }) }), id)
          .eq("revision", expected).is("closed_at", null).gt("expires_at", at);
      const { data, error } = await query.select("*").maybeSingle();
      if (error || !data) throw error?.code === "23505" || !error ? conflict()
        : new Error("訂單資料尚未保存，請稍後再試。", { cause: error });
      if (expected === undefined) Object.defineProperty(value, revision, { value: data.revision, writable: true });
      else value[revision] = data.revision;
      return value;
    },
    async delete(id, value) {
      // Keep a tombstone so stale controls cannot recreate a completed flow.
      const query = scope(table().update({ closed_at: new Date(now()).toISOString() }), id).is("closed_at", null);
      const expected = value?.[revision];
      const { data, error } = expected === undefined
        ? await query
        : await query.eq("revision", expected).select("flow_id").maybeSingle();
      if (error) throw new Error("暫時無法關閉訂單流程，請稍後再試。", { cause: error });
      if (expected !== undefined && !data) throw conflict();
    },
  };
}
module.exports = { createServiceFlowStore };
