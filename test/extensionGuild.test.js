const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("秋奈所有加時建立入口都保存伺服器歸屬供正式核帳使用", () => {
  let count = 0;
  for (const file of ["events/dispatchSystem.js", "index.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const match of source.matchAll(/\.from\("order_extensions"\)\s*\.insert\(\{([\s\S]*?)\}\)/g)) {
      count++;
      assert.match(match[1], /guild_id:/, `${file} 不可建立缺少歸屬的加時單`);
      if (file.startsWith("events/")) {
        assert.match(match[1], /guild_id: order\.guild_id \|\| process\.env\.GUILD_ID/);
      }
    }
  }
  assert.equal(count, 3, "新增加時入口時也必須納入驗證");
});
