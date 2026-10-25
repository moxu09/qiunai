const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { calculateSelfServicePrice } = require('../config/selfServicePricing');
test('ARAM 2026/10/20 價目圖使用提供的原始圖片與獨立新檔名', () => {
  const name = 'aram-pricing-2026-10-20.png';
  const image = fs.readFileSync(path.join(__dirname, '../assets/panels', name));
  assert.equal(createHash('sha256').update(image).digest('hex'), 'e4913866f574bc7321ba6e12e21819d25c5aa7da10c64e0c6606196df2f7e9a1');
  assert.equal(image.readUInt32BE(16), 1672); assert.equal(image.readUInt32BE(20), 941);
  assert.ok(fs.readFileSync(path.join(__dirname, '../events/dispatchSystem.js'), 'utf8').includes(name));
});
test('ARAM 現行小時價格與新圖一致，不變更既有計價規則', () => {
  for (const [serviceType, price] of [['娛樂',300],['技術',350],['大神',400]]) {
    const result = calculateSelfServicePrice({ game:'lol', platformOrMode:'ARAM', serviceType, quantity:'1', playerCount:'1', pricingDate:new Date('2026-10-20T00:00:00+08:00') });
    assert.equal(result.unitPrice, price); assert.equal(result.total, price);
  }
});
