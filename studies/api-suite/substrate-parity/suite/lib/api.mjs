// Domain helpers over the raw client: the vocabulary the scenarios speak
// (create / activate / fund / transfer / settle / close / paginate), plus the
// enumeration helper that audits rule 4 on every listing the suite ever walks.

import { ScenarioAbort } from './client.mjs';

export function makeApi(client, report) {
  async function ok(entry, what, expectedStatuses) {
    if (entry.transportError) {
      throw new ScenarioAbort(`${what}: no response (${entry.transportError})`, [entry]);
    }
    if (!expectedStatuses.includes(entry.status)) {
      throw new ScenarioAbort(
        `${what}: expected ${expectedStatuses.join('/')} but got ${entry.status} ${entry.responseText.slice(0, 200)}`,
        [entry],
      );
    }
    if (entry.json === null || typeof entry.json !== 'object') {
      throw new ScenarioAbort(`${what}: response body is not a JSON object (${entry.responseText.slice(0, 200)})`, [entry]);
    }
    return entry;
  }

  const api = {
    async reset(seed) {
      const e = await client.request('POST', '/admin/reset', { body: { seed }, principal: 'admin' });
      await ok(e, 'POST /admin/reset', [200]);
      return { entry: e, result: e.json };
    },

    async health() {
      const e = await client.request('GET', '/health', { principal: 'none' });
      return { entry: e, body: e.json };
    },

    async createAccount(owner, currency = 'USD') {
      const e = await client.request('POST', '/accounts', { body: { owner, currency } });
      await ok(e, `POST /accounts (${owner})`, [201]);
      const account = e.json;
      if (account.status !== 'pending') {
        report.violation('lifecycle', 'a new account was not created in status "pending"', {
          expected: 'status "pending" — an account cannot transact before activation',
          observed: `status ${JSON.stringify(account.status)}`,
          requests: [e],
        });
      }
      return { entry: e, account };
    },

    async activate(accountId) {
      const e = await client.request('POST', `/accounts/${accountId}/activate`);
      await ok(e, `POST /accounts/${accountId}/activate`, [200]);
      return { entry: e, account: e.json };
    },

    async close(accountId) {
      const e = await client.request('POST', `/accounts/${accountId}/close`);
      return { entry: e, account: e.json };
    },

    async getAccount(accountId) {
      const e = await client.request('GET', `/accounts/${accountId}`);
      return { entry: e, account: e.json };
    },

    /** Raw variants: the caller expects a refusal, so no aborting on non-2xx. */
    async postActivateRaw(accountId) {
      return client.request('POST', `/accounts/${accountId}/activate`);
    },

    async postDepositRaw(accountId, amount) {
      return client.request('POST', '/deposits', { body: { account_id: accountId, amount } });
    },

    async deposit(accountId, amount) {
      const e = await client.request('POST', '/deposits', { body: { account_id: accountId, amount } });
      await ok(e, `POST /deposits (${accountId} ${amount})`, [201]);
      const deposit = e.json;
      if (deposit.status !== 'settled') {
        report.violation('errorshape', 'a 201 deposit came back in a non-settled state', {
          expected: 'deposits settle immediately: status "settled"',
          observed: `status ${JSON.stringify(deposit.status)}`,
          requests: [e],
        });
      }
      return { entry: e, deposit };
    },

    /** Raw create-transfer; caller decides what the outcome should be. */
    async postTransfer(body, { idempotencyKey, principal = 'customer', rawBody } = {}) {
      const headers = {};
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      const e = await client.request('POST', '/transfers', { body, rawBody, headers, principal });
      return e;
    },

    /** Create a transfer that is expected to succeed. */
    async transfer(sourceId, destinationId, amount, opts = {}) {
      const body = { source_account_id: sourceId, destination_account_id: destinationId, amount };
      if (opts.currency) body.currency = opts.currency;
      const e = await api.postTransfer(body, opts);
      await ok(e, `POST /transfers ${sourceId}->${destinationId} ${amount}`, opts.idempotencyKey ? [201, 200] : [201]);
      const transfer = e.json;
      if (e.status === 201 && transfer.status !== 'pending') {
        report.violation('errorshape', 'a 201 transfer came back already in a terminal state', {
          expected: 'a newly created transfer is "pending" until a tick settles it',
          observed: `status ${JSON.stringify(transfer.status)} failure_reason=${JSON.stringify(transfer.failure_reason)}`,
          requests: [e],
          note: 'a refused transfer must be a 4xx, not a 2xx carrying the failure in a field',
        });
      }
      return { entry: e, transfer, body };
    },

    async getTransfer(transferId) {
      const e = await client.request('GET', `/transfers/${transferId}`);
      return { entry: e, transfer: e.json };
    },

    async cancel(transferId) {
      const e = await client.request('POST', `/transfers/${transferId}/cancel`);
      return { entry: e, transfer: e.json };
    },

    async tick(body = {}) {
      const e = await client.request('POST', '/admin/tick', { body, principal: 'admin' });
      await ok(e, 'POST /admin/tick', [200]);
      return { entry: e, result: e.json };
    },

    /**
     * Walk one cursor enumeration from the beginning, auditing rule 4:
     * no entry id twice within the enumeration, and the walk terminates.
     */
    async enumerate(path, { limit, rule = 'pagination', label = path, between, maxPages = 40 } = {}) {
      const sep = path.includes('?') ? '&' : '?';
      const items = [];
      const seen = new Map(); // id -> page index where first seen
      const cursors = [];
      const entries = [];
      let cursor = null;
      let pages = 0;
      let emptyPages = 0;
      let duplicate = null;

      for (;;) {
        const qs = `${limit ? `limit=${limit}` : ''}${cursor != null ? `${limit ? '&' : ''}cursor=${encodeURIComponent(cursor)}` : ''}`;
        const e = await client.request('GET', `${path}${qs ? sep + qs : ''}`);
        entries.push(e);
        if (e.transportError || e.status !== 200 || !e.json || !Array.isArray(e.json.items)) {
          throw new ScenarioAbort(
            `enumeration of ${label} broke on page ${pages}: ${e.transportError ?? `${e.status} ${e.responseText.slice(0, 200)}`}`,
            entries.slice(-3),
          );
        }
        pages += 1;
        const page = e.json.items;
        if (page.length === 0) emptyPages += 1;
        for (const item of page) {
          const id = item?.id;
          if (typeof id !== 'string') continue;
          if (seen.has(id) && !duplicate) {
            duplicate = { id, firstPage: seen.get(id), againPage: pages - 1 };
            report.violation(rule, 'an id was returned twice inside one cursor enumeration', {
              dedupe: label,
              expected: `walking ${label} from no cursor and following next_cursor returns each id at most once`,
              observed: `${id} appeared on page ${seen.get(id)} and again on page ${pages - 1} (limit=${limit ?? 'default'})`,
              requests: entries.slice(Math.max(0, seen.get(id) - 1)).slice(0, 6),
            });
          }
          if (!seen.has(id)) seen.set(id, pages - 1);
          items.push(item);
        }

        const next = e.json.next_cursor;
        if (next === undefined) {
          report.warn('page without next_cursor', `${label} returned a page with no next_cursor member; the suite treated it as the last page`);
          break;
        }
        if (next === null) break;
        if (typeof next !== 'string') {
          report.violation(rule, 'next_cursor is neither a string nor null', {
            dedupe: label,
            expected: 'next_cursor: string | null',
            observed: JSON.stringify(next),
            requests: [e],
          });
          break;
        }
        if (cursors.includes(next)) {
          report.violation(rule, 'the cursor chain does not terminate: a cursor repeated', {
            dedupe: label,
            expected: `following next_cursor from ${label} terminates`,
            observed: `cursor ${JSON.stringify(next)} was handed back a second time after ${pages} pages`,
            requests: entries.slice(-3),
          });
          break;
        }
        cursors.push(next);
        cursor = next;
        if (pages >= maxPages) {
          // Stopping at our own cap is not by itself proof of non-termination:
          // a service that simply ignores `limit` would need more pages and
          // still finish. Only call it a violation when the walk has clearly
          // run away — far more rows than this suite ever wrote, or a run of
          // empty pages that a terminating enumeration would never produce.
          const runaway = items.length >= 150 || emptyPages >= 3;
          if (runaway) {
            report.violation(rule, 'the cursor chain does not terminate', {
              dedupe: label,
              expected: `following next_cursor from ${label} terminates`,
              observed: `still handing back a next_cursor after ${pages} pages / ${items.length} items (${emptyPages} of them empty, limit=${limit ?? 'default'})`,
              requests: entries.slice(-3),
            });
          } else {
            report.warn(
              'enumeration hit the suite page cap',
              `${label} still had a next_cursor after ${pages} pages of at most ${limit ?? 'default'} (${items.length} rows so far); the suite stopped walking to protect its request budget`,
            );
          }
          break;
        }
        if (between) await between(pages);
      }

      return { items, pages, cursors, requests: entries, duplicate, unique: [...seen.keys()] };
    },

    async entries(accountId, opts = {}) {
      return api.enumerate(`/accounts/${accountId}/entries`, { label: `entries of ${accountId}`, ...opts });
    },

    async listAccounts({ includeClosed = true, limit = 100 } = {}) {
      const res = await api.enumerate(`/accounts${includeClosed ? '?include_closed=true' : ''}`, {
        limit,
        label: 'GET /accounts',
        rule: 'pagination',
        maxPages: 12,
      });
      return res;
    },

    async listTransfers({ accountId, limit = 100 } = {}) {
      const res = await api.enumerate(`/transfers${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`, {
        limit,
        label: 'GET /transfers',
        rule: 'pagination',
        maxPages: 12,
      });
      return res;
    },
  };

  return api;
}

export function feeFor(amount) {
  // documented: fee = 25 + round_half_away_from_zero(amount * 15 / 10000)
  const bps = (amount * 15) / 10000;
  return 25 + Math.sign(bps) * Math.round(Math.abs(bps));
}
