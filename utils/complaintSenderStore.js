// Keep routing identities server-side, apart from the complaint visible to the CEO.
// This table already denies access to anon/authenticated clients.
function createComplaintSenderStore(db) {
  const organization = "qiunai:complaints";
  function scoped(query, id) {
    return query.eq("organization_code", organization).eq("flow_id", id);
  }
  return {
    async save(id, payload) {
      const { error } = await db.from("bot_service_order_flows").insert({
        organization_code: organization, flow_id: id, payload,
        expires_at: "2099-01-01T00:00:00Z",
      });
      if (error) throw error;
    },
    async bind(id, payload) {
      const { data, error } = await scoped(db.from("bot_service_order_flows")
        .update({ payload, updated_at: new Date().toISOString() }), id).select("flow_id").maybeSingle();
      if (error || !data) throw error || new Error("投訴回覆資料保存失敗");
    },
    async get(id) {
      const { data, error } = await scoped(db.from("bot_service_order_flows").select("payload"), id).maybeSingle();
      if (error) throw error;
      return data?.payload || null;
    },
  };
}
module.exports = { createComplaintSenderStore };
