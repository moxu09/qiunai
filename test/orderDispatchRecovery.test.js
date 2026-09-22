const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPaidOrderDispatcher,
} = require("../utils/orderDispatchRecovery");

const GUILD_ID = "guild-qiunai";

function createDispatchDb(order = { id: "order-1", paid: true, guild_id: GUILD_ID }) {
  const state = {
    status: "pending",
    staffMessageId: null,
    controlMessageId: null,
    attempts: 0,
    order,
  };
  return {
    state,
    async rpc(name, args) {
      if (name === "qiunai_claim_order_dispatch") {
        assert.equal(args.p_guild_id, GUILD_ID);
        if (state.status === "dispatched") {
          return { data: { claimed: false, state: "dispatched", order }, error: null };
        }
        if (state.status === "processing") {
          return { data: { claimed: false, state: "processing", order }, error: null };
        }
        state.status = "processing";
        state.attempts += 1;
        return {
          data: {
            claimed: true,
            state: "processing",
            order,
            attempt: state.attempts,
            staff_message_id: state.staffMessageId,
            control_message_id: state.controlMessageId,
          },
          error: null,
        };
      }
      if (name === "qiunai_checkpoint_order_dispatch") {
        assert.equal(args.p_guild_id, GUILD_ID);
        assert.equal(args.p_attempt, state.attempts);
        if (args.p_stage === "staff") state.staffMessageId = args.p_message_id;
        else state.controlMessageId = args.p_message_id;
        return { data: {}, error: null };
      }
      if (name === "qiunai_complete_order_dispatch") {
        assert.equal(args.p_guild_id, GUILD_ID);
        assert.equal(args.p_attempt, state.attempts);
        if (!state.staffMessageId || !state.controlMessageId) {
          return { data: null, error: { message: "missing checkpoint" } };
        }
        state.status = "dispatched";
        return { data: {}, error: null };
      }
      if (name === "qiunai_fail_order_dispatch") {
        assert.equal(args.p_guild_id, GUILD_ID);
        assert.equal(args.p_attempt, state.attempts);
        state.status = "failed";
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

test("Discord 在第二段發送失敗後，重試沿用第一段 message id 而不重複派單", async () => {
  const db = createDispatchDb();
  let staffSends = 0;
  let controlSends = 0;
  let failControl = true;
  const dispatcher = createPaidOrderDispatcher({
    supabase: db,
    guildId: GUILD_ID,
    sendStaffOrder: async () => ({ id: `staff-${++staffSends}` }),
    sendControlPanel: async () => {
      controlSends += 1;
      if (failControl) throw new Error("Discord unavailable");
      return { id: `control-${controlSends}` };
    },
    findStaffOrder: async () => null,
    findControlPanel: async () => null,
  });

  await assert.rejects(dispatcher(db.state.order, {}), /Discord unavailable/);
  assert.equal(db.state.status, "failed");
  assert.equal(db.state.staffMessageId, "staff-1");
  failControl = false;
  const recovered = await dispatcher(db.state.order, {});
  assert.equal(recovered.state, "dispatched");
  assert.equal(staffSends, 1);
  assert.equal(controlSends, 2);
  assert.equal(db.state.status, "dispatched");
});

test("兩個並行派單只有取得持久 claim 的程序會送 Discord 訊息", async () => {
  const db = createDispatchDb();
  let release;
  let staffSends = 0;
  const dispatcher = createPaidOrderDispatcher({
    supabase: db,
    guildId: GUILD_ID,
    sendStaffOrder: async () => {
      staffSends += 1;
      await new Promise((resolve) => { release = resolve; });
      return { id: "staff-one" };
    },
    sendControlPanel: async () => ({ id: "control-one" }),
    findStaffOrder: async () => null,
    findControlPanel: async () => null,
  });

  const first = dispatcher(db.state.order, {});
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = await dispatcher(db.state.order, {});
  assert.equal(second.inProgress, true);
  assert.equal(staffSends, 1);
  release();
  await first;
  assert.equal(db.state.status, "dispatched");
});

test("已完成派單的付款重試不再發任何 Discord 訊息", async () => {
  const db = createDispatchDb();
  db.state.status = "dispatched";
  const dispatcher = createPaidOrderDispatcher({
    supabase: db,
    guildId: GUILD_ID,
    sendStaffOrder: async () => assert.fail("不應重送員工派單"),
    sendControlPanel: async () => assert.fail("不應重送客服面板"),
    findStaffOrder: async () => null,
    findControlPanel: async () => null,
  });
  const result = await dispatcher(db.state.order, {});
  assert.equal(result.alreadyDispatched, true);
});

test("派單器拒絕其他 guild 的共用表訂單，且不呼叫 RPC", async () => {
  let rpcCalls = 0;
  const dispatcher = createPaidOrderDispatcher({
    supabase: { rpc: async () => { rpcCalls += 1; return { data: null, error: null }; } },
    guildId: GUILD_ID,
    sendStaffOrder: async () => assert.fail("不應送出員工派單"),
    sendControlPanel: async () => assert.fail("不應送出客服面板"),
    findStaffOrder: async () => null,
    findControlPanel: async () => null,
  });
  await assert.rejects(
    dispatcher({ id: "foreign-order", paid: true, guild_id: "deepnight" }, {}),
    /不屬於目前秋奈 guild/,
  );
  assert.equal(rpcCalls, 0);
});
