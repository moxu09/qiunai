const test = require('node:test');
const assert = require('node:assert/strict');
const { resendEmploymentSigningLink } = require('../events/employmentSystem');

const applicantId = '123456789012345678';
const reviewerId = '987654321098765432';
const config = { organization: 'qiunai', brandName: '秋奈電競', signingBaseUrl: 'https://hr.wearestilllhere.com' };

function fixture(signings, { dmBlocked = false } = {}) {
  const sent = [];
  const leaseClaims = [];
  const released = [];
  const applicant = { id: applicantId, username: '申請人', async send(message) {
    if (dmBlocked) throw Object.assign(Error('DM blocked'), { code: 50007 });
    sent.push(message);
  } };
  const supabase = {
    from(table) {
      if (table === 'employment_contract_signings') return {
        select() { return this; },
        async eq() { return { data: signings, error: null }; },
      };
      if (table === 'bot_service_order_flows') return {
        async insert(value) { leaseClaims.push(value); return { error: null }; },
        update(value) { released.push(value); return this; },
        eq() { return this; },
        async contains() { return { error: null }; },
      };
      throw Error(`Unexpected table: ${table}`);
    },
  };
  return { client: { users: { fetch: async () => applicant } }, supabase, sent, leaseClaims, released };
}

test('有秋奈舊邀請才產生新連結，舊員工可重新簽署，並由小奈私訊', async () => {
  const oldSecret = process.env.EMPLOYMENT_SIGNING_API_SECRET;
  const oldFetch = global.fetch;
  process.env.EMPLOYMENT_SIGNING_API_SECRET = 'test-secret-with-at-least-thirty-two-characters';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ invitation: {
      required: true, url: 'https://hr.wearestilllhere.com/employment-sign/new-token',
    } }) };
  };
  try {
    const f = fixture([{ organization_code: 'qiunai', status: 'expired' }]);
    assert.equal(await resendEmploymentSigningLink({ ...f, config, discordId: applicantId, reviewerId }), 'sent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://hr.wearestilllhere.com/api/qiunai/employment-signing/invite');
    assert.deepEqual(requests[0].body, {
      discordId: applicantId, discordName: '申請人', invitedBy: reviewerId, forceSigning: true,
    });
    assert.match(f.sent[1], /employment-sign\/new-token/);
    assert.equal(f.leaseClaims[0].flow_id, applicantId);
    assert.equal(f.released.length, 0);
  } finally {
    global.fetch = oldFetch;
    if (oldSecret === undefined) delete process.env.EMPLOYMENT_SIGNING_API_SECRET;
    else process.env.EMPLOYMENT_SIGNING_API_SECRET = oldSecret;
  }
});

test('沒有秋奈邀請或已簽署的人不建立新連結', async () => {
  for (const [signings, expected] of [
    [[{ organization_code: 'deepnight', status: 'expired' }], 'no_invitation'],
    [[{ organization_code: 'qiunai', status: 'signed' }], 'already_signed'],
    [[{ organization_code: 'qiunai', status: 'signing' }], 'signing'],
    [[{ organization_code: 'qiunai', status: 'revoked' }], 'no_invitation'],
  ]) {
    const f = fixture(signings);
    assert.equal(await resendEmploymentSigningLink({ ...f, config, discordId: applicantId, reviewerId }), expected);
    assert.equal(f.leaseClaims.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('私訊關閉時保留舊連結，解除重發冷卻以便重試', async () => {
  const f = fixture([{ organization_code: 'qiunai', status: 'invited' }], { dmBlocked: true });
  assert.equal(await resendEmploymentSigningLink({ ...f, config, discordId: applicantId, reviewerId }), 'dm_blocked');
  assert.equal(f.leaseClaims.length, 1);
  assert.equal(f.released.length, 1);
  assert.ok(f.released[0].closed_at);
});
