const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");

const filename = path.resolve(__dirname, "../events/dispatchSystem.js");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, "utf8") +
  "\nmodule.exports.resetForTest = resetSelectMenuMessage;", filename);
const reset = compiled.exports.resetForTest;

function interaction({ ephemeral = false, error } = {}) {
  const edits = [];
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("menu").addOptions([
      { label: "娛樂", value: "entertain", default: true },
    ]),
  ).toJSON();
  return {
    edits,
    message: {
      id: "message", components: [row],
      flags: { has: flag => flag === 64 && ephemeral },
      async edit(payload) { edits.push(payload); if (error) throw error; },
    },
  };
}

test("私人選單不使用一般頻道訊息更新，公開選單仍能重置", async () => {
  const privateMenu = interaction({ ephemeral: true });
  await reset(privateMenu);
  assert.equal(privateMenu.edits.length, 0);
  const publicMenu = interaction();
  await reset(publicMenu);
  assert.equal(publicMenu.edits.length, 1);
  assert.equal(publicMenu.edits[0].components[0].toJSON().components[0].options[0].default, false);
});

test("已刪除選單不阻斷流程，其他錯誤仍保留診斷且不輸出 token", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await reset(interaction({ error: { code: 10008, message: "Unknown Message" } }));
    assert.equal(errors.length, 0);
    await reset(interaction({ error: { code: 50013, message: "Missing Permissions", url: "secret-token" } }));
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].code, 50013);
    assert.equal(JSON.stringify(errors).includes("secret-token"), false);
    await reset({});
  } finally {
    console.error = originalError;
  }
});
