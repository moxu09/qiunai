const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDiscordArchiveHtml,
  classifyOrderArchive,
  fetchAllChannelMessages,
} = require("../utils/orderArchive");

test("訂單存檔依遊戲資料分類", () => {
  assert.equal(classifyOrderArchive({ service: "特戰英豪｜排位" }), "特戰訂單");
  assert.equal(classifyOrderArchive({ game: "三角洲行動" }), "三角洲訂單");
  assert.equal(classifyOrderArchive({ order_item: "Apex 技術" }), "apex訂單");
  assert.equal(classifyOrderArchive({ service_name: "LOL 娛樂" }), "英雄聯盟訂單");
  assert.equal(classifyOrderArchive({}, "steam-客人-123"), "steam訂單");
  assert.equal(classifyOrderArchive({ service: "唱歌" }), "其他訂單");
});

test("HTML 存檔保留訊息、Embed 與內嵌圖片", async () => {
  const attachment = {
    url: "https://cdn.discordapp.com/attachments/1/2/example.png",
    name: "付款.png",
    contentType: "image/png",
  };
  const html = await buildDiscordArchiveHtml({
    channelName: "訂單-測試",
    guildName: "秋奈電競",
    messages: [
      {
        id: "123",
        content: "付款完成\n請查收",
        createdTimestamp: Date.parse("2026-09-08T00:00:00+08:00"),
        author: {
          tag: "tester",
          displayAvatarURL: () => "https://cdn.discordapp.com/avatars/1/a.png",
        },
        member: { displayName: "測試者" },
        attachments: new Map([["1", attachment]]),
        embeds: [
          {
            title: "訂單資訊",
            description: "金額 NT$500",
            fields: [{ name: "遊戲", value: "特戰英豪" }],
          },
        ],
        stickers: new Map(),
      },
    ],
    imageDownloader: async () => ({
      source: "data:image/png;base64,aW1hZ2U=",
      bytes: 5,
    }),
  });
  assert.match(html, /測試者/);
  assert.match(html, /付款完成<br>請查收/);
  assert.match(html, /訂單資訊/);
  assert.match(html, /data:image\/png;base64,aW1hZ2U=/);
  assert.doesNotMatch(html, /example\.png/);
});

test("訊息存檔會翻頁抓取，不只保存最近 100 則", async () => {
  const firstPage = new Map(
    Array.from({ length: 100 }, (_, index) => {
      const number = 200 - index;
      return [String(number), { id: String(number), createdTimestamp: number }];
    }),
  );
  const secondPage = new Map([
    ["100", { id: "100", createdTimestamp: 100 }],
    ["99", { id: "99", createdTimestamp: 99 }],
  ]);
  const calls = [];
  const channel = {
    messages: {
      async fetch(options) {
        calls.push(options);
        return calls.length === 1 ? firstPage : secondPage;
      },
    },
  };
  const messages = await fetchAllChannelMessages(channel);
  assert.equal(messages.length, 102);
  assert.equal(calls[1].before, "101");
  assert.equal(messages[0].id, "99");
});
