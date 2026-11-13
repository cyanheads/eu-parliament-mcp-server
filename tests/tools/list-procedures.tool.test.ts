/** @fileoverview Procedure discovery wire contracts with sparse upstream records. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProceduresTool } from '../../src/mcp-server/tools/definitions/list-procedures.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { envelopeResponse } from '../helpers/eu-parliament-fixtures.js';

const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
const windowHint =
  'Narrow process_type to retrieve a smaller procedure set. Restart paging at offset 0 after narrowing.';
const snapshotHint =
  'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.';
const stalledHint =
  'Retry the same euparl tool call later; do not treat an incomplete lookup as a complete result.';
const orderingNotice =
  'Parliament serves each page of the unfiltered procedure listing from one of two orderings, so pages reached through next_offset can repeat some procedures and omit others. Set process_type for a complete walk in procedure_id order.';
/** Upstream procedure page honoring the requested offset and limit, total past the window. */
const procedurePage = (url: URL) => {
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  return Response.json({
    data: Array.from({ length: limit }, (_, index) => ({
      id: `eli/dl/proc/2025-${String(offset + index).padStart(4, '0')}`,
    })),
    meta: { total: 20000 },
  });
};
afterEach(() => vi.useRealTimers());

describe('euparl_list_procedures contract', () => {
  it('renders the search wall and rejects inaccessible continuation', async () => {
    const fetcher = installToolHttp(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: 'eli/dl/proc/2025-9001' }], meta: { total: 10000 } }),
        ),
    );
    const result = await runToolContract(listProceduresTool, { offset: 9999, limit: 1 });
    const data = expectSuccessTwin(result);
    expect(data).toMatchObject({ truncated: true, page: { has_more: true, returned: 1 } });
    expect(data.page).not.toHaveProperty('next_offset');
    expect(data).not.toHaveProperty('totalCount');
    expect(contractText(result)).not.toContain('Continue with offset');
    expectErrorTwin(
      await runToolContract(listProceduresTool, { offset: 10000, limit: 1 }),
      'invalid_filter',
      windowHint,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('states the exhausted-window route without process_type on both surfaces', async () => {
    installToolHttp(procedurePage);
    const data = expectSuccessTwin(
      await runToolContract(listProceduresTool, { offset: 9900, limit: 1000 }),
    );
    expect(data.page).not.toHaveProperty('next_offset');
    expect(data.notice).toContain(
      'The 10000-result search window is exhausted; further matches cannot be ruled out. Narrow process_type to retrieve a smaller procedure set.',
    );
  });
  it('honors a large process_type page on both surfaces without an output cap', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `2025-${String(i).padStart(4, '0')}`);
    const fetcher = installToolHttp(() =>
      Response.json({
        data: ids.toReversed().map((id) => ({ id: `eli/dl/proc/${id}` })),
        meta: { total: 400 },
      }),
    );
    const result = await runToolContract(listProceduresTool, { process_type: 'COD', limit: 5000 });
    const data = expectSuccessTwin(result);
    expect((data.items as { procedure_id: string }[]).map((row) => row.procedure_id)).toEqual(ids);
    expect(data).toMatchObject({
      page: { offset: 0, limit: 5000, returned: 400, has_more: false },
      totalCount: 400,
    });
    expect(data).not.toHaveProperty('notice');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('10000');
  });
  it.each([
    [9900, 100],
    [9950, 50],
  ])(
    'narrows offset %i with limit 1000 to the %i rows left in the window',
    async (offset, rows) => {
      const fetcher = installToolHttp(procedurePage);
      const result = await runToolContract(listProceduresTool, { offset, limit: 1000 });
      const data = expectSuccessTwin(result);
      expect(data.items).toHaveLength(rows);
      expect(data).toMatchObject({ page: { offset, limit: rows, returned: rows, has_more: true } });
      expect(data.page).not.toHaveProperty('next_offset');
      expect(data.notice).toContain(
        `Requested limit normalized to ${rows}: offset plus limit cannot pass the 10000-result search window.`,
      );
      expect(data.notice).toContain('The 10000-result search window is exhausted');
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe(
        String(rows),
      );
    },
  );
  it('normalizes type aliases and renders exact sparse records plus active source links', async () => {
    const reference = '2025/9001(COD) `quoted`\n**literal markdown**';
    const fetcher = installToolHttp(
      () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'eli/dl/proc/2025-9001',
                process_id: '2025-9001',
                label: reference,
                process_type: 'def/ep-procedure-types/COD',
              },
              { id: 'eli/dl/proc/2025-9002' },
            ],
            meta: { total: 2 },
          }),
        ),
    );
    const data = expectSuccessTwin(
      await runToolContract(listProceduresTool, {
        process_type: ' cod ',
        language: 'EN',
        limit: 1000,
      }),
    );
    expect(data).toMatchObject({
      items: [
        {
          procedure_id: '2025-9001',
          reference,
          process_type: 'def/ep-procedure-types/COD',
          source_url: 'https://data.europarl.europa.eu/eli/dl/proc/2025-9001',
        },
        {
          procedure_id: '2025-9002',
          source_url: 'https://data.europarl.europa.eu/eli/dl/proc/2025-9002',
        },
      ],
      page: { limit: 1000, returned: 2, has_more: false, snapshot: expect.any(String) },
      appliedFilters: { process_type: 'COD' },
      totalCount: 2,
    });
    expect(data).not.toHaveProperty('notice');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('process-type')).toBe('COD');
    expect(url.searchParams.get('limit')).toBe('10000');
    expect(data.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: expect.anything() })]),
    );
  });

  it('omits blank optional filters and keeps unknown upstream totals absent', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([{ id: 'eli/dl/proc/2025-9001' }]));
    const data = expectSuccessTwin(
      await runToolContract(listProceduresTool, { process_type: ' ', language: '' }),
    );
    expect(data.appliedFilters).toEqual({});
    expect(data).not.toHaveProperty('totalCount');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.has('process-type')).toBe(
      false,
    );
  });

  it('pages upstream by offset without requiring or inventing snapshots', async () => {
    const fetcher = installToolHttp((_url, _init, index) =>
      envelopeResponse([{ id: `eli/dl/proc/2025-${index === 0 ? '9001' : '9002'}` }]),
    );
    expect(
      expectSuccessTwin(await runToolContract(listProceduresTool, { limit: 1 })),
    ).toMatchObject({
      page: { next_offset: 1, has_more: true },
      truncated: true,
      shown: 1,
      cap: 1,
    });
    const next = expectSuccessTwin(
      await runToolContract(listProceduresTool, { limit: 1, offset: 1 }),
    );
    expect(next).toMatchObject({ items: [{ procedure_id: '2025-9002' }], page: { offset: 1 } });
    expect(next.page).not.toHaveProperty('snapshot');
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('offset')).toBe('1');
  });

  it('pages unfiltered procedures at the caller offset and limit with an exact smaller total', async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `2025-${String(index).padStart(4, '0')}`);
    const fetcher = installToolHttp((url) => {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Response.json({
        data: ids.slice(offset, offset + limit).map((id) => ({ id: `eli/dl/proc/${id}` })),
        meta: { total: ids.length },
      });
    });
    const middle = expectSuccessTwin(
      await runToolContract(listProceduresTool, { offset: 20, limit: 20 }),
    );
    expect(middle).toMatchObject({
      items: ids.slice(20, 40).map((procedure_id) => ({ procedure_id })),
      page: { offset: 20, limit: 20, returned: 20, has_more: true, next_offset: 40 },
      totalCount: 45,
    });
    const last = expectSuccessTwin(
      await runToolContract(listProceduresTool, { offset: 40, limit: 20 }),
    );
    expect(last).toMatchObject({
      items: ids.slice(40).map((procedure_id) => ({ procedure_id })),
      page: { offset: 40, limit: 20, returned: 5, has_more: false },
      totalCount: 45,
    });
    expect(last.page).not.toHaveProperty('next_offset');
    expect(last.page).not.toHaveProperty('snapshot');
    expect(fetcher.mock.calls.map(([url]) => [...new URL(String(url)).searchParams])).toEqual([
      [
        ['offset', '20'],
        ['limit', '20'],
        ['format', 'application/ld+json'],
      ],
      [
        ['offset', '40'],
        ['limit', '20'],
        ['format', 'application/ld+json'],
      ],
    ]);
  });

  describe('process_type local collection over two upstream orderings', () => {
    /** 23 sparse and full rows; a letter-suffixed ID sorts after its bare number. */
    const rows = Array.from({ length: 23 }, (_, index) => {
      const id = `${2023 + (index % 3)}-${String(100 - index).padStart(4, '0')}${index === 5 ? 'A' : ''}`;
      return {
        id: `eli/dl/proc/${id}`,
        ...(index % 3 === 0 && {
          process_id: id,
          label: `${id.replace('-', '/')}(COD)`,
          process_type: 'def/ep-procedure-types/COD',
        }),
      };
    });
    const sortedIds = rows
      .map((row) => row.id.slice('eli/dl/proc/'.length))
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    /** Parliament serves each request from one of two orderings of the same set, alternating here. */
    const twoOrderings = (url: URL, _init: RequestInit | undefined, index: number) => {
      const step = index % 2 === 0 ? 7 : 11;
      const ordering = rows.map((_, position) => rows[(position * step) % rows.length]!);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Response.json({
        data: ordering.slice(offset, offset + limit),
        meta: { total: rows.length },
      });
    };
    const walk = async (limits: number[], passSnapshot: boolean) => {
      const seen: string[] = [];
      const snapshots = new Set<unknown>();
      let offset = 0;
      let snapshot: unknown;
      for (let call = 0; call < 30; call++) {
        const data = expectSuccessTwin(
          await runToolContract(listProceduresTool, {
            process_type: 'COD',
            offset,
            limit: limits[call % limits.length],
            ...(passSnapshot && typeof snapshot === 'string' && { snapshot }),
          }),
        );
        expect(data.totalCount).toBe(rows.length);
        const page = data.page as { next_offset?: number; snapshot?: unknown };
        seen.push(...(data.items as { procedure_id: string }[]).map((item) => item.procedure_id));
        snapshots.add(page.snapshot);
        snapshot = page.snapshot;
        if (page.next_offset === undefined) break;
        offset = page.next_offset;
      }
      return { seen, snapshots };
    };

    it.each([
      ['a constant limit', [5], true],
      ['a limit changing between calls', [3, 7, 4, 9, 2], true],
      ['a constant limit without passing the snapshot', [5], false],
    ])(
      'yields every procedure exactly once in procedure_id order at %s',
      async (_, limits, passSnapshot) => {
        const fetcher = installToolHttp(twoOrderings);
        const { seen, snapshots } = await walk(limits, passSnapshot);
        expect(seen).toEqual(sortedIds);
        expect(snapshots.size).toBe(1);
        expect([...snapshots][0]).toMatch(/^[a-f0-9]{64}$/);
        for (const [url] of fetcher.mock.calls)
          expect([...new URL(String(url)).searchParams]).toEqual([
            ['offset', '0'],
            ['limit', '10000'],
            ['process-type', 'COD'],
            ['format', 'application/ld+json'],
          ]);
      },
    );

    it('fails snapshot_changed for a changed set and still serves the continuation without a snapshot', async () => {
      const added = { id: 'eli/dl/proc/2023-0001' };
      installToolHttp((url, init, index) =>
        index === 0
          ? twoOrderings(url, init, index)
          : Response.json({ data: [...rows, added], meta: { total: rows.length + 1 } }),
      );
      const first = expectSuccessTwin(
        await runToolContract(listProceduresTool, { process_type: 'COD', limit: 5 }),
      );
      const { snapshot } = first.page as { snapshot: string };
      expectErrorTwin(
        await runToolContract(listProceduresTool, {
          process_type: 'COD',
          offset: 5,
          limit: 5,
          snapshot,
        }),
        'snapshot_changed',
        snapshotHint,
        JsonRpcErrorCode.Conflict,
      );
      const unchecked = expectSuccessTwin(
        await runToolContract(listProceduresTool, { process_type: 'COD', offset: 5, limit: 5 }),
      );
      expect(unchecked).toMatchObject({
        items: ['2023-0001', ...sortedIds].slice(5, 10).map((procedure_id) => ({ procedure_id })),
        page: { offset: 5, returned: 5, next_offset: 10 },
        totalCount: rows.length + 1,
      });
      expect((unchecked.page as { snapshot: string }).snapshot).not.toBe(snapshot);
    });

    it.each([{}, { process_type: ' ' }])(
      'rejects a snapshot without process_type (%j) before HTTP',
      async (filter) => {
        const fetcher = installToolHttp(twoOrderings);
        expectErrorTwin(
          await runToolContract(listProceduresTool, { ...filter, snapshot: 'a'.repeat(64) }),
          'invalid_mode_fields',
          'Remove snapshot, or repeat the call with the process_type of the listing that returned it.',
          JsonRpcErrorCode.ValidationError,
        );
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it('fails upstream_paging_stalled on both surfaces when a response holds fewer rows than meta.total', async () => {
      const fetcher = installToolHttp(() =>
        Response.json({ data: rows.slice(0, 20), meta: { total: rows.length } }),
      );
      const result = await runToolContract(listProceduresTool, { process_type: 'COD' });
      expectErrorTwin(
        result,
        'upstream_paging_stalled',
        stalledHint,
        JsonRpcErrorCode.ServiceUnavailable,
      );
      expect(contractText(result)).toContain('20 distinct procedures in 20 rows');
      expect(contractText(result)).not.toContain('procedure_id');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([rows.length, 10_000])(
      'serves offset %i, at or past the end of the set, as an empty page after one request',
      async (offset) => {
        const fetcher = installToolHttp(twoOrderings);
        const data = expectSuccessTwin(
          await runToolContract(listProceduresTool, { process_type: 'COD', offset }),
        );
        expect(data).toMatchObject({
          items: [],
          page: { offset, limit: 20, returned: 0, has_more: false },
          totalCount: rows.length,
        });
        expect(data.page).toHaveProperty('snapshot');
        expect(data.notice).toBe(
          `The offset ${offset} is at or beyond the complete collection of ${rows.length} items. Restart at offset 0 or return to the previous page.`,
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['HTTP 204', () => new Response(null, { status: 204 })],
      ['an empty 200 envelope', () => Response.json({ data: [], meta: { total: 0 } })],
    ])('lists an empty process_type set from %s with totalCount 0', async (_, respond) => {
      installToolHttp(respond);
      const data = expectSuccessTwin(
        await runToolContract(listProceduresTool, { process_type: 'BUI' }),
      );
      expect(data).toMatchObject({
        items: [],
        page: { offset: 0, returned: 0, has_more: false },
        totalCount: 0,
        notice:
          'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.',
      });
    });

    it('discloses two upstream orderings on every unfiltered page and never on process_type pages', async () => {
      installToolHttp(twoOrderings);
      for (const offset of [0, 5]) {
        const unfiltered = expectSuccessTwin(
          await runToolContract(listProceduresTool, { offset, limit: 5 }),
        );
        expect(unfiltered.notice).toContain(orderingNotice);
        expect(unfiltered.page).not.toHaveProperty('snapshot');
      }
      const typed = expectSuccessTwin(
        await runToolContract(listProceduresTool, { process_type: 'COD', limit: 5 }),
      );
      expect(typed.notice).toBe('Continue with offset 5 and the returned snapshot.');
    });
  });

  it.each([
    [
      204,
      0,
      'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.',
    ],
    [
      404,
      0,
      'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.',
    ],
    [
      204,
      1000,
      'The page at offset 1000 returned no procedures. Restart at offset 0 or return to the previous page.',
    ],
    [
      404,
      1000,
      'The page at offset 1000 returned no procedures. Restart at offset 0 or return to the previous page.',
    ],
  ] as const)(
    'renders unfiltered empty HTTP %i at offset %i with guidance for that position',
    async (status, offset, notice) => {
      installToolHttp(() => new Response(null, { status }));
      const data = expectSuccessTwin(await runToolContract(listProceduresTool, { offset }));
      expect(data).toMatchObject({
        items: [],
        page: { offset, returned: 0, has_more: false },
        notice: `${notice} ${orderingNotice}`,
      });
      expect(data).not.toHaveProperty('totalCount');
    },
  );

  it.each([
    [
      { process_type: 'XYZ' },
      'Unsupported process_type filter "XYZ". Accepted codes: ACI, APP, AVC, BUD, CNS, COD, DEC, NLE, SYN, BUI, COS, DEA, DCE, IMM, INI, INL, INS, REG, RPS, RSO, RSP, GBD.',
      'Call euparl_list_reference with topic procedure_types for every accepted code, then retry process_type with one of them.',
    ],
    [
      { language: 'xx' },
      'Unsupported language filter "xx". Accepted codes: bg, es, cs, da, de, et, el, en, fr, ga, hr, it, lv, lt, hu, mt, nl, pl, pt, ro, sk, sl, fi, sv.',
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
  ] as const)(
    'returns invalid_filter naming the value, every accepted code and its recovery for %j',
    async (input, message, hint) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const failure = await runToolContract(listProceduresTool, input);
      expectErrorTwin(failure, 'invalid_filter', hint, JsonRpcErrorCode.ValidationError);
      expect(contractText(failure)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported source filters at schema boundary', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { year: 2025, offset: 0 };
    const result = await runToolContract(listProceduresTool, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(contractText(result)).toContain('euparl_list_procedures');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders upstream rejection with recovery and no upstream trace', async () => {
    const fetcher = installToolHttp(() => new Response('private trace', { status: 422 }));
    const result = await runToolContract(listProceduresTool, {});
    expectErrorTwin(result, 'upstream_rejected', rejectedHint, JsonRpcErrorCode.InvalidParams);
    expect(contractText(result)).not.toContain('private trace');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders persistent rate limiting after exactly three fake-timed attempts', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp(
      () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }),
      async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    );
    const pending = runToolContract(listProceduresTool, {});
    await vi.runAllTimersAsync();
    expectErrorTwin(await pending, 'upstream_rate_limited', rateHint, JsonRpcErrorCode.RateLimited);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
