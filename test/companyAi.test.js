const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCompanyAi,
  fitDiscordMessage,
  getWebSources,
  isDirectBotMention,
  shouldUseWebSearch,
} = require("../utils/companyAi");
const {
  getCompanyAiPricingCatalog,
} = require("../config/selfServicePricing");

test("公司 AI 回覆不超過 Discord 訊息上限", () => {
  const result = fitDiscordMessage("字".repeat(3000));
  assert.ok(result.length <= 1900);
  assert.match(result, /內容已截短/);
});

test("公司 AI 只接受訊息文字中直接標註機器人本人", () => {
  const botId = "123456789012345678";
  assert.equal(isDirectBotMention(`<@${botId}> 哈囉`, botId), true);
  assert.equal(isDirectBotMention(`<@!${botId}> 哈囉`, botId), true);
  assert.equal(
    isDirectBotMention("<@876543210987654321> 哈囉", botId),
    false,
  );
  assert.equal(isDirectBotMention("<@&123456789012345678> 哈囉", botId), false);
});

test("需要最新外部資料時啟用搜尋，但 Discord ID 查詢不送上網", () => {
  assert.equal(shouldUseWebSearch("請上網查今天台北天氣"), true);
  assert.equal(shouldUseWebSearch("陪我聊聊天"), false);
  assert.equal(
    shouldUseWebSearch("上網查 123456789012345678 的資料", true, true),
    false,
  );
});

test("整理並去除重複的網路搜尋來源", () => {
  const sources = getWebSources({
    output: [
      {
        type: "web_search_call",
        action: {
          sources: [
            { title: "官方資料", url: "https://example.com/a" },
            { title: "重複資料", url: "https://example.com/a" },
          ],
        },
      },
      {
        content: [
          {
            annotations: [
              { type: "url_citation", title: "第二來源", url: "https://example.org/b" },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(sources, [
    { title: "官方資料", url: "https://example.com/a" },
    { title: "第二來源", url: "https://example.org/b" },
  ]);
});

test("未設定 OpenAI 金鑰時提供明確提示且不查詢資料庫", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let queried = false;
  const companyAi = createCompanyAi({
    supabase: { from() { queried = true; throw new Error("不應查詢"); } },
    organization: "test",
    companyName: "測試公司",
    staffTable: "staff",
    orderTable: "orders",
    bonusTable: "bonus",
  });
  await assert.rejects(
    companyAi.answer({ userId: "123456789012345678", question: "測試" }),
    /尚未完成 OpenAI API 金鑰設定/,
  );
  assert.equal(queried, false);
  if (previous === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previous;
});

test("AI 輔助報價使用現行價目表且不直接修改訂單", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output_text:
          "🤖 AI 輔助報價（非正式報價）\n參考金額 NT$500，請客服確認。",
      }),
    };
  };
  try {
    const companyAi = createCompanyAi({
      supabase: {},
      organization: "qiunai",
      companyName: "秋奈",
      staffTable: "staff",
      orderTable: "orders",
      bonusTable: "bonus",
      pricingCatalog: getCompanyAiPricingCatalog(),
    });
    const result = await companyAi.suggestQuote({
      userId: "123456789012345678",
      order: {
        order_no: "ORD-TEST",
        customer_id: "876543210987654321",
        game: "特戰英豪",
        order_item: "娛樂",
        rank_preference: "黃金",
        player_count: 2,
        duration_text: "1 小時",
      },
      failureReason: "無法自動計價",
    });
    assert.match(result, /AI 輔助報價/);
    assert.equal(requestBody.store, false);
    assert.match(requestBody.instructions, /現行價目表/);
    assert.match(requestBody.input, /ORD-TEST/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
