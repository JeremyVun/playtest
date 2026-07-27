// Rule 5. Every response in the whole suite is audited by the client, so this
// scenario's job is to widen the *kinds* of response the audit sees: one probe
// per documented refusal (400/401/403/404/405/409/410/422) plus the inputs
// most likely to fall out of a hand-written router into a 500 — bad
// percent-encoding, a null byte, a 5000-character path, a body that is not an
// object, deep nesting, a forged cursor, a limit that overflows.
//
// It also proves that none of these refusals created anything.
//
// Where a probe checks that a *documented* refusal happened at all (a
// zero-amount transfer, an unauthenticated call), the finding is filed under
// "contract" rather than under one of the six rules: accepting it is a defect,
// but it is not what rule 5 says. Rule 5 findings here come from the client
// audit — envelope shape, 5xx, a failure smuggled into a 2xx.

import { expectRefused, transferIdsFor } from '../lib/expect.mjs';

export const name = 'error-shape';

export async function run({ api, client, report }) {
  const src = (await api.createAccount('e-src', 'USD')).account;
  const dst = (await api.createAccount('e-dst', 'USD')).account;
  const eur = (await api.createAccount('e-eur', 'EUR')).account;
  for (const acc of [src, dst, eur]) await api.activate(acc.id);
  await api.deposit(src.id, 100);

  const t = (body, opts) => api.postTransfer(body, opts);
  const good = { source_account_id: src.id, destination_account_id: dst.id, amount: 10 };

  // --- business-rule refusals (422) ---------------------------------------
  const refusals = [
    [{ ...good, source_account_id: src.id, destination_account_id: src.id }, 'same_account', 'a transfer to itself'],
    [{ ...good, destination_account_id: eur.id }, 'currency_mismatch', 'a cross-currency transfer'],
    [{ ...good, currency: 'EUR' }, 'currency_mismatch', 'a transfer asserting the wrong currency'],
    [{ ...good, amount: 0 }, 'invalid_amount', 'a zero-amount transfer'],
    [{ ...good, amount: -100 }, 'invalid_amount', 'a negative transfer'],
    [{ ...good, amount: 1.5 }, 'invalid_amount', 'a fractional transfer'],
    [{ ...good, amount: '10' }, 'invalid_amount', 'a transfer whose amount is a string'],
    [{ ...good, amount: 5000 }, 'insufficient_funds', 'a transfer larger than the balance'],
    [{ ...good, amount: 100001 }, 'daily_limit_exceeded', 'a transfer over the daily limit'],
  ];
  for (const [body, code, what] of refusals) {
    const res = await t(body);
    expectRefused(report, 'contract', `${what} was not refused`, res, { statuses: [400, 409, 422], code });
  }

  // --- malformed requests (400) -------------------------------------------
  const malformed = [
    ['{', 'a truncated JSON body'],
    ['null', 'a JSON null body'],
    ['"string"', 'a JSON string body'],
    [`{"source_account_id":${'['.repeat(120)}${']'.repeat(120)},"destination_account_id":"${dst.id}","amount":1}`, 'a deeply nested value'],
    [`{"source_account_id":"${src.id}","destination_account_id":"${dst.id}","amount":1e400}`, 'an amount that overflows to Infinity'],
    [`{"__proto__":{"polluted":true},"source_account_id":"${src.id}","destination_account_id":"${dst.id}","amount":${5000}}`,
      'a prototype-pollution body'],
  ];
  for (const [rawBody, what] of malformed) {
    const res = await t(undefined, { rawBody });
    expectRefused(report, 'contract', `${what} was accepted`, res, { statuses: [400, 422] });
  }
  for (const amount of [true, null, [], { value: 1 }]) {
    const res = await t({ ...good, amount });
    expectRefused(report, 'contract', `a transfer with amount ${JSON.stringify(amount)} was accepted`, res, {
      statuses: [400, 422],
    });
  }
  await client.request('POST', '/transfers', { rawBody: 'source=1&amount=2', contentType: 'text/plain' });
  // over-long key on a request that is refused anyway, so it can create nothing
  await client.request('POST', '/transfers', { body: { ...good, amount: 5000 }, headers: { 'idempotency-key': 'k'.repeat(600) } });
  await client.request('POST', '/accounts', { body: { owner: 'x'.repeat(200000), currency: 'USD' } });
  await client.request('POST', '/accounts', { body: { owner: '', currency: 'USD' } });
  await client.request('POST', '/accounts', { body: { owner: 'x', currency: 'GBP' } });
  await client.request('POST', '/accounts', { body: { currency: 'USD' } });
  await client.request('POST', '/deposits', { body: { account_id: src.id, amount: 0 } });
  await client.request('POST', '/deposits', { body: { account_id: 'acc_missing', amount: 10 } });

  // --- pagination parameters (400) ----------------------------------------
  for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'limit=2.5', 'limit=-1', 'limit=99999999999999999999', 'limit=1e3']) {
    await client.request('GET', `/accounts/${src.id}/entries?${qs}`);
  }
  const forged = [
    'zzzz',
    Buffer.from('not json at all').toString('base64url'),
    Buffer.from('{"s":"abc"}').toString('base64url'),
    Buffer.from('{"s":{"nested":1}}').toString('base64url'),
    '%%%',
  ];
  for (const cursor of forged) {
    await client.request('GET', `/accounts/${src.id}/entries?cursor=${cursor}`);
  }

  // --- authentication and authorisation ------------------------------------
  const unauth = [
    ['GET', '/accounts', 'none'],
    ['GET', `/accounts/${src.id}/entries`, 'none'],
    ['POST', '/transfers', 'none'],
    ['GET', '/transfers', 'Bearer not-a-real-token'],
    ['GET', '/accounts', 'Basic abc'],
    ['GET', '/accounts', 'Bearer '],
  ];
  for (const [method, path, principal] of unauth) {
    const e = await client.request(method, path, { principal, body: method === 'POST' ? good : undefined });
    expectRefused(report, 'contract', `${method} ${path} without a valid token was not refused`, e, { statuses: [401] });
  }
  for (const [method, path] of [
    ['POST', '/admin/tick'],
    ['POST', '/admin/reset'],
  ]) {
    const e = await client.request(method, path, { body: {}, principal: 'customer' });
    expectRefused(report, 'contract', `${method} ${path} with the customer token was not refused`, e, { statuses: [403] });
  }

  // --- routing and hostile paths -------------------------------------------
  const paths = [
    ['GET', '/nope'],
    ['GET', '/accounts/acc_does_not_exist'],
    ['GET', '/accounts/acc_does_not_exist/entries'],
    ['GET', '/transfers/tr_missing'],
    ['GET', '/deposits/dep_missing'],
    ['POST', '/transfers/tr_missing/cancel'],
    ['POST', '/accounts/acc_missing/activate'],
    ['GET', '/accounts/%zz'],
    ['GET', '/accounts/..%2f..%2fetc%2fpasswd'],
    ['GET', `/accounts/acc_${'a'.repeat(2000)}`],
    ['GET', '/accounts/acc_%00null/entries'],
    ['GET', '/accounts/acc_%E2%98%A0/entries'],
    ['GET', '//accounts'],
    ['GET', '/accounts/'],
    ['DELETE', '/accounts'],
    ['PUT', `/accounts/${src.id}`],
    ['OPTIONS', '/transfers'],
    ['POST', '/health'],
    ['GET', '/openapi.json'],
    ['GET', '/health'],
  ];
  for (const [method, path] of paths) {
    await client.request(method, path, { body: method === 'PUT' || method === 'POST' ? {} : undefined });
  }

  // --- admin surface with bad input ----------------------------------------
  await client.request('POST', '/admin/tick', { body: { settle_limit: -1 }, principal: 'admin' });
  await client.request('POST', '/admin/tick', { body: { settle_limit: 'all' }, principal: 'admin' });
  await client.request('POST', '/admin/tick', { rawBody: '{oops', principal: 'admin' });

  // Nothing above was allowed to move money.
  const after = await transferIdsFor(api, src.id);
  if (after.ids.length) {
    report.violation('lifecycle', 'a refused request still created a transfer', {
      expected: `no transfer names ${src.id}: every create attempt in this scenario was illegal`,
      observed: after.items.map((x) => `${x.id}(${x.status},${x.amount})`).join(' '),
      requests: after.requests,
    });
  }
  const entries = await api.entries(src.id, { limit: 100 });
  if (entries.items.length !== 1) {
    report.violation('balance', 'a refused request still wrote a ledger entry', {
      expected: `${src.id} has exactly the one deposit entry it was funded with`,
      observed: entries.items.map((e) => `${e.id}:${e.kind}:${e.amount}`).join(' '),
      requests: entries.requests.slice(0, 3),
    });
  }
  const account = await api.getAccount(src.id);
  if (account.account?.balance !== 100) {
    report.violation('balance', 'a refused request still changed a balance', {
      expected: `${src.id} balance is still the 100 it was funded with`,
      observed: `${account.account?.balance}`,
      requests: [account.entry],
    });
  }
}
