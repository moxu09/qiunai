const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getPaymentMethodSelection, isGeneralEcpayAmountAllowed } = require('../utils/paymentMethodEmojis');
const { assertBankTransferCanBeSelected, buildEcpayPaymentRows } = require('../utils/ecpayDiscord');
const source = fs.readFileSync(require.resolve('../events/dispatchSystem'), 'utf8');
const extract = name => {
  const body = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body, name);
  return body;
};

async function selectTopup({ selfService = false, existing = null, databaseError = null, legacy = false, available = true } = {}) {
  const sent = [], replies = [], created = [], prompts = [];
  const pendingTopups = new Map([['user_1', { userId: 'user', amount: 1000, note: '無', topupNo: 'TOP-TEST', selfService }]]);
  const supabase = { from(table) {
    assert.equal(table, 'ecpay_service_payments');
    const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { return { data: existing, error: databaseError }; } };
    return q;
  } };
  const context = {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    getPaymentMethodSelection, isGeneralEcpayAmountAllowed, assertBankTransferCanBeSelected,
    pendingTopups, supabase, QIUNAI_WATER_BLUE: '#123456',
    BANK_TRANSFER_QR_CODE_PATH: 'assets/bank-transfer-line-bank.png',
    resetSelectMenuMessage: async () => {}, formatWalletPaymentName: x => x,
    isCardPayment: () => false, isNoCardPayment: () => false, isBankTransfer: x => x === '匯款',
    paymentHelpers: { ecpayAvailable: available, async createEcpayServicePayment(args) {
      created.push(args); return { platformOrderId: 'QNTEST' };
    } },
    async sendEcpayPaymentPrompt(...args) { prompts.push(args); },
    process,
  };
  vm.createContext(context);
  vm.runInContext(extract('sendBankTransferInfo') + '\n' + extract('handleTopupPaymentMethodSelect') + '\nthis.run = handleTopupPaymentMethodSelect;', context);
  await context.run({ customId: legacy ? 'topup_payment_method_user_1' : 'topup_payment_method_user_1__pm_bank',
    ...(legacy ? { values: ['匯款'] } : {}), deferred: true,
    user: { id: 'user' }, guildId: 'guild', channel: { id: 'channel', async send(payload) { sent.push(payload); return { id: 'message' }; } },
    async editReply(payload) { replies.push(payload); },
  });
  return { sent, replies, created, prompts, pendingTopups };
}

test('人工購買 ASD 的新按鈕與舊選單顯示連線銀行，無需綠界可用', async () => {
  for (const options of [{}, { legacy: true }, { available: false }]) {
    const result = await selectTopup(options);
    assert.equal(result.created.length, 0);
    assert.equal(result.sent.length, 2);
    const description = result.sent[1].embeds[0].toJSON().description;
    assert.match(description, /824連線銀行/);
    assert.match(description, /312000002665/);
    assert.match(description, /上傳匯款截圖，等待客服確認/);
    assert.equal(result.sent[1].files[0].name, 'bank-transfer-line-bank.png');
    assert.equal(result.pendingTopups.size, 0);
  }
});

test('自助購買 ASD 仍明確建立綠界 ATM 付款', async () => {
  const result = await selectTopup({ selfService: true });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].metadata.flow, 'self_service');
  assert.equal(result.prompts[0][3].onlyMethod, 'ATM');
  assert.equal(result.prompts[0][3].selfService, true);
  assert.equal(result.sent.length, 0);
});

test('人工購幣已有取號、已付款或查詢失敗時保留申請，不提供第二組帳號', async () => {
  for (const options of [
    { existing: { status: 'pending', raw_result: { PaymentType: 'ATM' } } },
    { existing: { status: 'paid' } },
    { databaseError: { message: 'offline' } },
  ]) {
    const result = await selectTopup(options);
    assert.equal(result.created.length, 0);
    assert.equal(result.sent.length, 0);
    assert.equal(result.pendingTopups.size, 1);
    assert.match(result.replies.at(-1).content, /已有有效綠界|已付款|無法核對/);
  }
});

test('人工購幣的舊綠界付款面板不再提供新 ATM 按鈕，自助面板保留', async () => {
  const sent = [];
  const context = { EmbedBuilder, buildEcpayPaymentRows, QIUNAI_WATER_BLUE: '#123456',
    isEcpayAtmAvailable: () => true, paymentHelpers: {},
  };
  vm.createContext(context);
  vm.runInContext(extract('sendEcpayPaymentPrompt') + '\nthis.run = sendEcpayPaymentPrompt;', context);
  for (const selfService of [false, true]) {
    await context.run({ async send(payload) { sent.push(payload); return { id: 'message' }; } }, 'user', 1000,
      { platformOrderId: 'QNTEST', paymentUrl: 'https://pay.example/payments/ecpay/service/checkout', selfService }, '購買ASD');
    const buttons = sent.at(-1).components.flatMap(row => row.components.map(b => b.toJSON()));
    assert.equal(buttons.some(b => b.custom_id?.includes('_ATM_')), selfService);
  }
});
