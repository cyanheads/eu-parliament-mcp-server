/** @fileoverview Complete roster discovery and both public response contracts. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { searchMepsTool } from '../../src/mcp-server/tools/definitions/search-meps.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import {
  envelopeResponse,
  maltaOn20240313,
  rosterRecords,
} from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
const snapshotHint =
  'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.';
const stalledHint =
  'Retry the same euparl tool call later; do not treat an incomplete lookup as a complete result.';
const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
const nameHint =
  'Include at least one letter or digit in name_contains, or omit name_contains to browse the roster.';
const snapshotOf = (data: Record<string, unknown>) =>
  z.object({ snapshot: z.string() }).parse(data.page).snapshot;
afterEach(() => vi.useRealTimers());

describe('euparl_search_meps contract', () => {
  it('acquires subsequent upstream pages before diacritic and all-token matching', async () => {
    const fetcher = installToolHttp((_url, _init, index) =>
      Response.json(
        index === 0
          ? { data: [rosterRecords[0]], meta: { total: 2, next: 1 } }
          : { data: [rosterRecords[1]], meta: { total: 2 } },
      ),
    );
    const result = await runToolContract(searchMepsTool, {
      name_contains: 'DEMO, elodie',
      term: 9,
      limit: 1,
    });
    const data = expectSuccessTwin(result);
    expect(data).toMatchObject({
      items: [
        { mep_id: '900000002', name: 'Élodie DEMO', given_name: 'Élodie', family_name: 'Demo' },
      ],
      totalCount: 1,
      appliedFilters: {
        scope: 'parliamentary_term',
        term: 9,
        language: 'en',
        name_contains: 'demo elodie',
      },
      page: { offset: 0, returned: 1, has_more: false },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0]?.pathname).toBe('/api/v2/meps');
    expect(urls[0]?.searchParams.has('offset')).toBe(false);
    expect(urls[0]?.searchParams.has('limit')).toBe(false);
    expect(urls[0]?.searchParams.get('parliamentary-term')).toBe('9');
    expect(urls[1]?.searchParams.get('offset')).toBe('1');
    expect(urls[1]?.searchParams.get('limit')).toBe('50');
    expect(contractText(result)).toContain('"Élodie DEMO"');
  });

  it('does not match a name that contains only one requested token', async () => {
    installToolHttp(() => envelopeResponse(rosterRecords));
    const data = expectSuccessTwin(
      await runToolContract(searchMepsTool, { name_contains: 'Alex DEMO' }),
    );
    expect(data.items).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.notice).toBe(
      'No MEPs matched. Remove name_contains to browse, relax country or political_group, or call euparl_list_reference with topic mep_filters.',
    );
  });

  it('selects current scope and accepts blank form filters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const fetcher = installToolHttp(() => envelopeResponse(rosterRecords));
    const data = expectSuccessTwin(
      await runToolContract(searchMepsTool, {
        name_contains: '',
        country: ' ',
        political_group: '',
        gender: '',
        language: '',
        snapshot: '',
      }),
    );
    expect(data).toMatchObject({
      totalCount: 2,
      appliedFilters: { scope: 'current', as_of: '2026-10-25', language: 'en' },
    });
    expect(data.items).toEqual([
      {
        mep_id: '900000001',
        name: 'Alex EXAMPLE',
        given_name: 'Alex',
        family_name: 'Example',
        country: 'FR',
        political_group: 'PPE',
      },
      { mep_id: '900000002', name: 'Élodie DEMO', given_name: 'Élodie', family_name: 'Demo' },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe('/api/v2/meps/show-current');
  });

  it.each([
    ['S&D', 'S-D'],
    ['Verts/ALE', 'VERTS-ALE'],
    ['The Left', 'THE-LEFT'],
    ['Renew', 'RENEW'],
    ['PfE', 'PFE'],
  ])('normalizes political group alias %s', async (political_group, expected) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const data = expectSuccessTwin(
      await runToolContract(searchMepsTool, {
        country: 'fr',
        political_group,
        gender: 'female',
        term: 10,
      }),
    );
    expect(data.appliedFilters).toMatchObject({
      country: 'FR',
      political_group: expected,
      gender: 'FEMALE',
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('country-of-representation')).toBe('FR');
    expect(url.searchParams.get('political-group')).toBe(expected);
    expect(url.searchParams.get('gender')).toBe('FEMALE');
  });

  it('continues complete local pages and handles past-end offsets', async () => {
    installToolHttp(() => envelopeResponse(rosterRecords));
    const first = expectSuccessTwin(await runToolContract(searchMepsTool, { term: 9, limit: 1 }));
    expect(first).toMatchObject({
      items: [{ mep_id: '900000001' }],
      totalCount: 2,
      page: { limit: 1, returned: 1, next_offset: 1 },
      truncated: true,
      cap: 1,
    });
    const snapshot = snapshotOf(first);
    const second = expectSuccessTwin(
      await runToolContract(searchMepsTool, { term: 9, limit: 1, offset: 1, snapshot }),
    );
    expect(second).toMatchObject({
      items: [{ mep_id: '900000002' }],
      page: { returned: 1, has_more: false, snapshot },
    });
    const past = expectSuccessTwin(
      await runToolContract(searchMepsTool, { term: 9, offset: 1000, snapshot }),
    );
    expect(past).toMatchObject({
      items: [],
      totalCount: 2,
      page: { offset: 1000, returned: 0, has_more: false },
    });
  });

  it.each([' gb ', 'UK'])(
    'routes United Kingdom input %j as GB while preserving historical published group identities',
    async (country) => {
      const fetcher = installToolHttp(() =>
        envelopeResponse([
          {
            id: 'person/900000003',
            label: 'Historical member',
            'api:country-of-representation': 'GB',
            'api:political-group': 'PPE-DE',
          },
        ]),
      );
      const data = expectSuccessTwin(
        await runToolContract(searchMepsTool, {
          country,
          political_group: ' epp ',
          term: 6,
        }),
      );
      expect(data).toMatchObject({
        appliedFilters: { country: 'GB', political_group: 'PPE', term: 6 },
        items: [{ mep_id: '900000003', country: 'GB', political_group: 'PPE-DE' }],
      });
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.get('country-of-representation')).toBe('GB');
      expect(url.searchParams.get('political-group')).toBe('PPE');
    },
  );

  it('rejects a name_contains without letters or digits on both surfaces before HTTP', async () => {
    const fetcher = installToolHttp(() => envelopeResponse(rosterRecords));
    const result = await runToolContract(searchMepsTool, { name_contains: '!!!', limit: 1 });
    expectErrorTwin(result, 'invalid_filter', nameHint, JsonRpcErrorCode.ValidationError);
    expect(contractText(result)).toContain(
      'name_contains has no letter or digit after case, diacritic, and punctuation normalization.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lists a dated roster through both surfaces', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const fetcher = installToolHttp((url) =>
      envelopeResponse(
        url.searchParams.get('mandate-date') === '2024-03-13' ? maltaOn20240313.slice(0, 3) : [],
      ),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchMepsTool, {
        mandate_date: '2024-03-13',
        country: 'MT',
        limit: 2,
      }),
    );
    expect(data).toMatchObject({
      items: [
        {
          mep_id: '197394',
          name: 'Josianne CUTAJAR',
          given_name: 'Josianne',
          family_name: 'Cutajar',
          country: 'MT',
          political_group: 'S&D',
        },
        { mep_id: '118859', name: 'Roberta METSOLA', political_group: 'PPE' },
      ],
      totalCount: 3,
      appliedFilters: {
        scope: 'mandate_date',
        mandate_date: '2024-03-13',
        language: 'en',
        country: 'MT',
      },
      page: { returned: 2, next_offset: 2 },
    });
    expect(data.appliedFilters).not.toHaveProperty('as_of');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/meps/show-current');
    expect(url.searchParams.get('mandate-date')).toBe('2024-03-13');
  });

  it.each([
    [{ term: 10, mandate_date: '2024-03-13' }, 'invalid_mode_fields', modeHint],
    [
      { mandate_date: '2026-11-02' },
      'invalid_filter',
      'Use a mandate_date on or before 2026-11-01, or omit mandate_date for members in office today.',
    ],
    [
      { mandate_date: '2024-02-30' },
      'invalid_filter',
      'Pass an existing calendar day as YYYY-MM-DD.',
    ],
  ] as const)('rejects %j as %s on both surfaces before HTTP', async (input, reason, hint) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchMepsTool, input),
      reason,
      hint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('explains date-bound group codes on both surfaces when a dated group search is empty', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 204 }));
    const data = expectSuccessTwin(
      await runToolContract(searchMepsTool, {
        mandate_date: '2016-03-09',
        political_group: 'GUE/NGL',
      }),
    );
    expect(data).toMatchObject({
      items: [],
      totalCount: 0,
      appliedFilters: {
        scope: 'mandate_date',
        mandate_date: '2016-03-09',
        political_group: 'THE-LEFT',
      },
    });
    expect(data.notice).toBe(
      "No MEPs matched. Remove name_contains to browse, relax country or political_group, or call euparl_list_reference with topic mep_filters. On a mandate_date roster, political_group matches only the group code in force on that date; omit political_group and read each member's published political_group.",
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('political-group')).toBe(
      'THE-LEFT',
    );
  });

  it('renders the canonical code list on both invalid-filter surfaces before HTTP', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(searchMepsTool, { gender: 'invalid' });
    expectErrorTwin(result, 'invalid_filter', invalidHint, JsonRpcErrorCode.ValidationError);
    const message = 'Unsupported gender filter. Accepted codes: FEMALE, MALE, NAP, NKN, NST.';
    expect(result.structuredContent).toMatchObject({ error: { message } });
    expect(contractText(result)).toContain(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('detects changed roster content beyond the current page and changed scope', async () => {
    let changed = false;
    installToolHttp(() =>
      envelopeResponse(
        changed
          ? [rosterRecords[0], { ...rosterRecords[1], label: 'Changed identity' }]
          : rosterRecords,
      ),
    );
    const first = expectSuccessTwin(await runToolContract(searchMepsTool, { term: 9, limit: 1 }));
    const snapshot = snapshotOf(first);
    expectErrorTwin(
      await runToolContract(searchMepsTool, { term: 10, offset: 1, snapshot }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
    changed = true;
    expectErrorTwin(
      await runToolContract(searchMepsTool, { term: 9, offset: 1, snapshot }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('caps whole records and preserves special name data on both surfaces', async () => {
    const rows = Array.from({ length: 301 }, (_, index) => ({
      id: `person/${900000000 + index}`,
      label: index === 0 ? '**name** `code`\n[link](https://example.org) \\ end' : 'Example',
    }));
    installToolHttp(() => envelopeResponse(rows));
    const data = expectSuccessTwin(await runToolContract(searchMepsTool, { term: 9, limit: 1000 }));
    expect(data.items).toHaveLength(300);
    expect(data.items).toEqual(
      expect.arrayContaining([
        { mep_id: '900000000', name: '**name** `code`\n[link](https://example.org) \\ end' },
      ]),
    );
    expect(data).toMatchObject({
      totalCount: 301,
      page: { limit: 300, next_offset: 300 },
      cap: 300,
    });
    expect(data.notice).toBe(
      'Requested limit normalized to the effective maximum of 300 MEPs. Continue with offset 300 and the returned snapshot.',
    );
  });

  it.each([
    { country: 'ZZ' },
    { political_group: 'bogus' },
    { gender: 'bogus' },
    { language: 'xx' },
  ])('rejects invalid filters %j before HTTP', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchMepsTool, input),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a snapshot on local continuation', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchMepsTool, { offset: 1 }),
      'invalid_mode_fields',
      modeHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ term: 11 }, { offset: -1 }, { limit: 0 }, { limit: 2.5 }, { unexpected: true }])(
    'rejects schema-invalid fields %j',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract(searchMepsTool, input);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      expect(contractText(result)).toContain('euparl_search_meps');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('fails repeated incomplete roster pages rather than returning partial matches', async () => {
    const fetcher = installToolHttp(() =>
      Response.json({ data: [rosterRecords[0]], meta: { total: 2 } }),
    );
    expectErrorTwin(
      await runToolContract(searchMepsTool, {}),
      'upstream_paging_stalled',
      stalledHint,
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cancels complete roster acquisition before requesting another page', async () => {
    const controller = new AbortController();
    const fetcher = installToolHttp(() => {
      controller.abort(new DOMException('Stop roster lookup', 'AbortError'));
      return Response.json({ data: [rosterRecords[0]], meta: { total: 2 } });
    });
    const result = await runToolContract(
      searchMepsTool,
      {},
      { context: { signal: controller.signal } },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(contractText(result)).toContain('Stop roster lookup');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares its total deadline across roster acquisition', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp(() => {
      vi.setSystemTime(Date.now() + 40_001);
      return Response.json({ data: [rosterRecords[0]], meta: { total: 2 } });
    });
    const result = await runToolContract(searchMepsTool, {});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.Timeout } },
    });
    expect(contractText(result)).toContain('40-second deadline');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([400, 422])('renders upstream %i rejection with declared recovery', async (status) => {
    installToolHttp(() => new Response('private upstream body', { status }));
    const result = await runToolContract(searchMepsTool, {});
    expectErrorTwin(result, 'upstream_rejected', rejectedHint, JsonRpcErrorCode.InvalidParams);
    expect(contractText(result)).not.toContain('private upstream body');
  });

  it('reports persistent rate limiting after exactly three attempts', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 429 }));
    expectErrorTwin(
      await runToolContract(searchMepsTool, {}),
      'upstream_rate_limited',
      rateHint,
      JsonRpcErrorCode.RateLimited,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
