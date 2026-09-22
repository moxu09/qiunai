const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getEmploymentReportChannelGender,
  provisionSignedEmploymentReportChannels,
} = require("../utils/employmentReportChannels");
const {
  QIUNAI_ONBOARDING_GUIDE_FOOTER,
  buildSafeReportChannelOverwrites,
  buildEmploymentOnboardingGuideEmbed,
  ensureEmploymentOnboardingGuide,
} = require("../events/workReportSystem");

test("建立填單區只複製仍存在的角色與 bot，不複製舊員工或失效 overwrite", () => {
  const overwrite = (id, type) => ({
    id,
    type,
    allow: { bitfield: 1024n },
    deny: { bitfield: 0n },
  });
  const templateChannel = {
    permissionOverwrites: {
      cache: new Map([
        ["guild", overwrite("guild", 0)],
        ["customer-service", overwrite("customer-service", 0)],
        ["deleted-role", overwrite("deleted-role", 0)],
        ["bot", overwrite("bot", 1)],
        ["former-staff", overwrite("former-staff", 1)],
      ]),
    },
  };
  const targetGuild = {
    roles: { cache: new Map([["guild", {}], ["customer-service", {}]]) },
  };
  const result = buildSafeReportChannelOverwrites({
    templateChannel,
    targetGuild,
    staffId: "new-staff",
    botUserId: "bot",
  });
  assert.deepEqual(
    result.map((item) => item.id),
    ["guild", "customer-service", "bot", "new-staff"],
  );
  assert.equal(result.at(-1).allow, 1024n);
});

test("新人導覽包含指定頻道、討論串提醒與 EIP 薪水網頁", () => {
  const embed = buildEmploymentOnboardingGuideEmbed().toJSON();
  assert.equal(embed.color, 0x7cc7ff);
  assert.equal(embed.footer.text, QIUNAI_ONBOARDING_GUIDE_FOOTER);
  assert.match(
    embed.description,
    /陪陪自介卡-繳交區.*1514570680354472026/s,
  );
  assert.match(embed.description, /自介卡白單在置頂訊息，請開啟討論串繳交/);
  assert.match(embed.description, /入職必看.*1524701867790307338/s);
  assert.match(embed.description, /陪玩規則.*1513185773699207168/s);
  assert.match(embed.description, /以上兩個頻道一定要看/);
  assert.match(embed.description, /EIP系統.*1515487457137791027/s);
  assert.match(embed.description, /薪水網頁/);
});

test("新人導覽只發送一次並標註新進陪陪", async () => {
  const sent = [];
  const channel = {
    messages: { fetch: async () => [] },
    async send(payload) {
      sent.push(payload);
      return {
        id: "guide-message",
        author: { id: "bot-id" },
        embeds: [payload.embeds[0].toJSON()],
      };
    },
  };

  const first = await ensureEmploymentOnboardingGuide(
    channel,
    "111111111111111111",
    "bot-id",
  );
  assert.equal(first.sent, true);
  assert.equal(sent[0].content, "<@111111111111111111>");

  channel.messages.fetch = async () => [first.message];
  const second = await ensureEmploymentOnboardingGuide(
    channel,
    "111111111111111111",
    "bot-id",
  );
  assert.equal(second.sent, false);
  assert.equal(sent.length, 1);
});

test("入群事件與背景補掃同時執行仍只發一份新人導覽", async () => {
  let sendCount = 0;
  const channel = {
    id: "onboarding-channel",
    messages: {
      fetch: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return [];
      },
    },
    async send(payload) {
      sendCount += 1;
      return {
        id: "concurrent-guide",
        author: { id: "bot-id" },
        embeds: [payload.embeds[0].toJSON()],
      };
    },
  };

  const results = await Promise.all([
    ensureEmploymentOnboardingGuide(
      channel,
      "222222222222222222",
      "bot-id",
    ),
    ensureEmploymentOnboardingGuide(
      channel,
      "222222222222222222",
      "bot-id",
    ),
  ]);

  assert.equal(sendCount, 1);
  assert.equal(results[0].message.id, "concurrent-guide");
  assert.equal(results[1].message.id, "concurrent-guide");
});

test("加入員工群時立即觸發填單區建立，不使用延遲計時器", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const handlerStart = indexSource.indexOf(
    "function retrySignedEmploymentForMember(member)",
  );
  const handlerEnd = indexSource.indexOf(
    "// 線上簽署可能早於加入員工群",
    handlerStart,
  );
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handlerSource = indexSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /processSignedEmploymentReportChannels\(\{/);
  assert.doesNotMatch(handlerSource, /signedEmploymentChannelTask\(\{/);
  assert.doesNotMatch(handlerSource, /setTimeout\s*\(/);
});

test("填單區建立依 Discord ID 排隊，避免入群事件與背景補掃重複建頻道", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  assert.match(source, /const staffReportChannelTasks = new Map\(\)/);
  assert.match(source, /staffReportChannelTasks\.get\(staffId\)/);
  assert.match(source, /ensureStaffReportChannelUnlocked\(staff, options\)/);
  assert.match(source, /staffReportChannelTasks\.set\(staffId, task\)/);
  assert.match(source, /GUILD_RESOURCE_CACHE_TTL_MS/);
  assert.match(source, /getStaffGuildWithCachedResources/);
  assert.doesNotMatch(source, /for \(const guild of client\.guilds\.cache\.values\(\)\)/);
});

test("歷史員工回補在 ready 後背景低速執行，不阻塞按鈕互動", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /現有已簽署成員填單區（背景低速）/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /await delay\(750\)/);
  assert.match(source, /5 \* 60 \* 1000/);
});

function createSupabaseMock(records, staffRecords = [], options = {}) {
  const updates = [];
  const inserts = [];
  return {
    updates,
    inserts,
    from(table) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        in() {
          return this;
        },
        order() {
          return this;
        },
        async limit() {
          return { data: records, error: null };
        },
        update(payload) {
          return {
            async eq(column, value) {
              updates.push({ table, column, value, payload });
              return { error: null };
            },
          };
        },
        async insert(payload) {
          inserts.push({ table, payload });
          return { error: options.insertError || null };
        },
        then(resolve) {
          if (table === "qiunai_staff") {
            return Promise.resolve({ data: staffRecords, error: null }).then(resolve);
          }
          return Promise.resolve({ data: records, error: null }).then(resolve);
        },
      };
    },
  };
}

test("簽署性別只把男與女映射至自動填單區", () => {
  assert.equal(getEmploymentReportChannelGender({ gender: "男" }), "男");
  assert.equal(getEmploymentReportChannelGender({ gender: "女陪" }), "女");
  assert.equal(getEmploymentReportChannelGender({ gender: "其他" }), null);
  assert.equal(getEmploymentReportChannelGender({ gender: "不透露" }), null);
});

test("已簽署新人會建立填單區、保存頻道且略過既有頻道", async () => {
  const supabase = createSupabaseMock(
    [
      {
        id: "sign-1",
        discord_id: "111111111111111111",
        discord_name: "新人一",
        form_data: { real_name: "王小明", gender: "男" },
        status: "signed",
      },
      {
        id: "sign-2",
        discord_id: "222222222222222222",
        discord_name: "新人二",
        form_data: {
          real_name: "林小美",
          gender: "女",
          report_channel_id: "99",
        },
        status: "signed",
      },
      {
        id: "sign-3",
        discord_id: "333333333333333333",
        discord_name: "新人三",
        form_data: { real_name: "陳同學", gender: "不透露" },
        status: "signed",
      },
    ],
    [
      {
        discord_id: "222222222222222222",
        gender: "女",
        salary_channel_id: "99",
      },
    ],
  );
  const provisioned = [];
  const provisionOptions = [];
  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    ensureStaffReportChannel: async (staff, options) => {
      provisioned.push(staff);
      provisionOptions.push(options);
      return { id: "123456789012345678" };
    },
  });

  assert.deepEqual(summary, {
    checked: 2,
    provisioned: 1,
    manualRequired: 1,
    failed: 0,
  });
  assert.equal(provisioned.length, 1);
  assert.deepEqual(provisionOptions, [{ sendOnboardingGuide: true }]);
  assert.equal(provisioned[0].gender, "男");
  assert.equal(supabase.inserts.length, 1);
  assert.equal(supabase.inserts[0].table, "qiunai_staff");
  assert.equal(
    supabase.inserts[0].payload.salary_channel_id,
    "123456789012345678",
  );
  assert.equal(supabase.updates.length, 2);
  assert.equal(
    supabase.updates[0].payload.form_data.report_channel_id,
    "123456789012345678",
  );
  assert.equal(
    supabase.updates[1].payload.form_data.report_channel_status,
    "manual_required",
  );
});

test("已建填單區但 EIP 遺漏的新人會自動補建員工資料", async () => {
  const supabase = createSupabaseMock([
    {
      id: "sign-missed",
      discord_id: "444444444444444444",
      discord_name: "被遺漏的新人",
      form_data: {
        real_name: "測試新人",
        gender: "女",
        birthday: "2000-01-01",
        bank_name: "測試銀行",
        bank_account: "1234567890",
        report_channel_id: "555555555555555555",
        report_channel_status: "provisioned",
      },
      status: "signed",
    },
  ]);
  const provisioned = [];

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    ensureStaffReportChannel: async (staff) => {
      provisioned.push(staff);
      return { id: staff.salary_channel_id };
    },
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 1,
    manualRequired: 0,
    failed: 0,
  });
  assert.equal(provisioned[0].salary_channel_id, "555555555555555555");
  assert.equal(supabase.inserts.length, 1);
  assert.deepEqual(
    {
      discord_id: supabase.inserts[0].payload.discord_id,
      salary_channel_id: supabase.inserts[0].payload.salary_channel_id,
      is_active: supabase.inserts[0].payload.is_active,
    },
    {
      discord_id: "444444444444444444",
      salary_channel_id: "555555555555555555",
      is_active: true,
    },
  );
  assert.equal(
    supabase.updates.at(-1).payload.form_data.report_channel_status,
    "provisioned",
  );
});

test("EIP 員工資料補建失敗時不會把簽署誤標成已完成", async () => {
  const supabase = createSupabaseMock(
    [
      {
        id: "sign-failed",
        discord_id: "666666666666666666",
        discord_name: "補建失敗新人",
        form_data: { gender: "男", report_channel_id: "777777777777777777" },
        status: "signed",
      },
    ],
    [],
    { insertError: { code: "XX000", message: "insert failed" } },
  );

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    ensureStaffReportChannel: async () => ({ id: "777777777777777777" }),
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 0,
    manualRequired: 0,
    failed: 1,
  });
  assert.equal(
    supabase.updates.some(
      (update) =>
        update.table === "employment_contract_signings" &&
        update.payload.form_data?.report_channel_status === "provisioned",
    ),
    false,
  );
});

test("待人工分類者在加入員工群取得陪陪性別後會立即重試", async () => {
  const supabase = createSupabaseMock([
    {
      id: "sign-manual",
      discord_id: "888888888888888888",
      discord_name: "稍後取得身分組",
      form_data: { report_channel_status: "manual_required" },
      status: "signed",
    },
  ]);

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    discordId: "888888888888888888",
    genderOverride: "女",
    ensureStaffReportChannel: async (staff) => {
      assert.equal(staff.gender, "女");
      return { id: "999999999999999999" };
    },
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 1,
    manualRequired: 0,
    failed: 0,
  });
  assert.equal(supabase.inserts[0].payload.gender, "女");
  assert.equal(
    supabase.updates.at(-1).payload.form_data.report_channel_status,
    "provisioned",
  );
  assert.equal(supabase.updates.at(-1).payload.form_data.gender, "女");
});

test("加入秋奈員工群時可沿用另一店的已簽署契約且不覆寫原店頻道", async () => {
  const supabase = createSupabaseMock([
    {
      id: "deepnight-signing",
      organization_code: "deepnight",
      discord_id: "101010101010101010",
      discord_name: "跨店新人",
      form_data: {
        gender: "女",
        report_channel_id: "202020202020202020",
        report_channel_status: "provisioned",
      },
      status: "activated",
      signed_at: "2026-09-01T00:00:00.000Z",
    },
  ]);
  const received = [];

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    organization: "qiunai",
    discordId: "101010101010101010",
    reuseSignedAcrossOrganizations: true,
    ensureStaffReportChannel: async (staff) => {
      received.push(staff);
      return { id: "303030303030303030" };
    },
  });

  assert.equal(summary.provisioned, 1);
  assert.equal(received[0].salary_channel_id, null);
  assert.equal(supabase.inserts[0].payload.salary_channel_id, "303030303030303030");
  assert.equal(
    supabase.updates.some(
      (update) => update.table === "employment_contract_signings",
    ),
    false,
  );
});

test("跨店簽署者已有秋奈 EIP 填單區時不重複建立", async () => {
  const supabase = createSupabaseMock(
    [
      {
        id: "deepnight-existing",
        organization_code: "deepnight",
        discord_id: "404040404040404040",
        discord_name: "既有跨店員工",
        form_data: { gender: "女", report_channel_id: "other-store-channel" },
        status: "activated",
        signed_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    [
      {
        discord_id: "404040404040404040",
        gender: "女",
        salary_channel_id: "505050505050505050",
      },
    ],
  );
  let channelCalls = 0;

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    organization: "qiunai",
    discordId: "404040404040404040",
    reuseSignedAcrossOrganizations: true,
    ensureStaffReportChannel: async () => {
      channelCalls += 1;
      return { id: "unexpected" };
    },
  });

  assert.deepEqual(summary, {
    checked: 0,
    provisioned: 0,
    manualRequired: 0,
    failed: 0,
  });
  assert.equal(channelCalls, 0);
});
