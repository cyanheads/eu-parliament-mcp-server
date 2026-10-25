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

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
afterEach(() => vi.useRealTimers());

describe('euparl_list_procedures contract', () => {
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
      page: { limit: 100, returned: 2, has_more: false },
      appliedFilters: { process_type: 'COD' },
      totalCount: 2,
    });
    expect(data.notice).toBe('Requested limit normalized to the effective maximum of 100.');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('process-type')).toBe('COD');
    expect(url.searchParams.get('limit')).toBe('100');
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

  it.each([204, 404])(
    'renders empty HTTP %i including past-end offset and guidance',
    async (status) => {
      installToolHttp(() => new Response(null, { status }));
      const data = expectSuccessTwin(await runToolContract(listProceduresTool, { offset: 1000 }));
      expect(data).toMatchObject({
        items: [],
        page: { offset: 1000, returned: 0, has_more: false },
        notice:
          'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.',
      });
      expect(data).not.toHaveProperty('totalCount');
    },
  );

  it.each([{ process_type: 'unsupported' }, { language: 'xx' }])(
    'returns invalid_filter and its exact recovery for %j',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(listProceduresTool, input),
        'invalid_filter',
        invalidHint,
        JsonRpcErrorCode.ValidationError,
      );
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
