/** @fileoverview Reference-tool success and error wire contracts through real HTTP parsing. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '../../src/mcp-server/tools/definitions/list-reference.tool.js';
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
const modeHint =
  'Choose organizations with organization_ids, or omit organization_ids for another reference topic.';
const body = {
  id: 'org/5144',
  identifier: '5144',
  label: 'DLAT',
  prefLabel: {
    en: 'Delegation to the Euro-Latin American Parliamentary Assembly',
    fr: 'Délégation exemple',
  },
  classification: 'def/ep-entities/DELEGATION_PARLIAMENTARY_ASSEMBLY',
  temporal: { startDate: '2019-07-02', endDate: '2024-07-15' },
};
afterEach(() => vi.useRealTimers());

describe('euparl_list_reference contract', () => {
  it('resolves ordered organization aliases and duplicate IDs with per-item misses on both surfaces', async () => {
    const fetcher = installToolHttp((url) =>
      url.pathname.endsWith('/999999999')
        ? new Response(null, { status: 404 })
        : envelopeResponse([body]),
    );
    const data = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: [
          '5144',
          '999999999',
          'org/5144',
          'https://data.europarl.europa.eu/org/5144',
        ],
        language: 'fr',
      }),
    );
    expect(data).toMatchObject({
      items: [
        {
          found: true,
          organization_id: '5144',
          id: 'org/5144',
          label: { value: 'DLAT', language: 'mul' },
          name: { value: 'Délégation exemple', language: 'fr' },
          start_date: '2019-07-02',
          end_date: '2024-07-15',
        },
        {
          found: false,
          organization_id: '999999999',
          code: '999999999',
          source_url: 'https://data.europarl.europa.eu/org/999999999',
        },
        { found: true, organization_id: '5144' },
        { found: true, organization_id: '5144' },
      ],
      totalCount: 4,
      page: { returned: 4, has_more: false },
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v2/corporate-bodies/5144',
      '/api/v2/corporate-bodies/999999999',
      '/api/v2/corporate-bodies/5144',
      '/api/v2/corporate-bodies/5144',
    ]);
  });
  it('enriches historical bodies with published names and sparse dates without extra HTTP', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        body,
        { id: 'org/2', prefLabel: { de: 'Zweite' }, temporal: { startDate: '2024-07-16' } },
        { id: 'org/3' },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(listReferenceTool, { topic: 'committees', language: 'pl' }),
    );
    expect(data.items).toEqual([
      {
        code: '5144',
        id: 'org/5144',
        label: { value: 'DLAT', language: 'mul' },
        name: {
          value: 'Delegation to the Euro-Latin American Parliamentary Assembly',
          language: 'en',
        },
        classification: body.classification,
        start_date: '2019-07-02',
        end_date: '2024-07-15',
      },
      {
        code: 'org/2',
        id: 'org/2',
        name: { value: 'Zweite', language: 'de' },
        start_date: '2024-07-16',
      },
      { code: 'org/3', id: 'org/3' },
    ]);
    expect(data.notice).toContain('returned published de text');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caps organization lookups at 20 and reaches the second page and past-end without snapshots', async () => {
    const ids = Array.from({ length: 23 }, (_, index) => String(index + 1));
    const fetcher = installToolHttp((url) =>
      envelopeResponse([{ id: `org/${url.pathname.split('/').at(-1)}` }]),
    );
    const first = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ids,
        limit: 1000,
      }),
    );
    expect(first).toMatchObject({
      totalCount: 23,
      cap: 20,
      shown: 20,
      truncated: true,
      page: { limit: 20, returned: 20, next_offset: 20 },
    });
    expect(first.notice).toContain('effective maximum of 20');
    expect(fetcher).toHaveBeenCalledTimes(20);
    const last = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ids,
        offset: 20,
        limit: 1000,
      }),
    );
    expect(last).toMatchObject({
      items: [{ organization_id: '21' }, { organization_id: '22' }, { organization_id: '23' }],
      page: { returned: 3, has_more: false },
    });
    const past = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ids,
        offset: 100,
      }),
    );
    expect(past).toMatchObject({ items: [], page: { returned: 0, has_more: false } });
    expect(past.notice).toContain('offset');
    expect(fetcher).toHaveBeenCalledTimes(23);
  });
  it.each([204, 404])('reports only HTTP%i as an organization miss', async (status) => {
    installToolHttp(() => new Response(null, { status }));
    expect(
      expectSuccessTwin(
        await runToolContract(listReferenceTool, {
          topic: 'organizations',
          organization_ids: ['5144'],
        }),
      ),
    ).toMatchObject({ items: [{ found: false, organization_id: '5144' }] });
  });
  it.each([
    { rows: [] },
    { rows: [{ id: 'org/5145' }] },
    { rows: [{ id: 'org/5144' }, { id: 'org/5144' }] },
  ])('fails unexpected successful organization detail %j', async ({ rows }) => {
    installToolHttp(() => envelopeResponse(rows));
    const response = await runToolContract(listReferenceTool, {
      topic: 'organizations',
      organization_ids: ['5144'],
    });
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.SerializationError } },
    });
    expect(contractText(response)).toContain('organization');
  });
  it.each([
    { topic: 'organizations' as const },
    { topic: 'organizations' as const, organization_ids: [] },
    { topic: 'coverage' as const, organization_ids: ['5144'] },
    { topic: 'coverage' as const, organization_ids: [] },
  ])('rejects incompatible organization fields before HTTP %j', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(listReferenceTool, input),
      'invalid_mode_fields',
      modeHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates IDs beyond the selected page before making any HTTP requests', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ['5144', 'https://evil.example/org/5144'],
        limit: 1,
      }),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('propagates upstream organization rejection after a successful first item', async () => {
    const fetcher = installToolHttp((_url, _init, index) =>
      index === 0 ? envelopeResponse([body]) : new Response(null, { status: 422 }),
    );
    expectErrorTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ['5144', '2'],
      }),
      'upstream_rejected',
      rejectedHint,
      JsonRpcErrorCode.InvalidParams,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps organization rate-limit recovery after bounded retries', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 429 }));
    expectErrorTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ['5144'],
      }),
      'upstream_rate_limited',
      rateHint,
      JsonRpcErrorCode.RateLimited,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('cancels a later organization lookup instead of returning earlier successes', async () => {
    const controller = new AbortController();
    const fetcher = installToolHttp((_url, init, index) => {
      if (index === 0) return envelopeResponse([body]);
      controller.abort(new DOMException('Organization lookup stopped', 'AbortError'));
      init?.signal?.throwIfAborted();
      throw new Error('Cancellation did not reach fetch');
    });
    const response = await runToolContract(
      listReferenceTool,
      { topic: 'organizations', organization_ids: ['5144', '2', '3'] },
      { context: { signal: controller.signal } },
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(contractText(response)).toContain('Organization lookup stopped');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps historical body discovery and published short labels without inferred intervals', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([{ id: 'org/5144', label: 'DLAT' }]));
    const data = expectSuccessTwin(
      await runToolContract(listReferenceTool, { topic: 'committees' }),
    );
    expect(data.items).toEqual([
      { code: 'org/5144', id: 'org/5144', label: { value: 'DLAT', language: 'mul' } },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe('/api/v2/corporate-bodies');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    'procedure_types',
    'document_types',
    'question_types',
    'activity_types',
    'mep_filters',
    'identifiers',
    'coverage',
  ] as const)('renders every complete offline %s entry without HTTP', async (topic) => {
    const fetcher = installToolHttp(() => {
      throw new Error('Static reference requested network');
    });
    const result = await runToolContract(listReferenceTool, { topic, limit: 100 });
    const data = expectSuccessTwin(result);
    expect(data).toMatchObject({
      topic,
      page: { offset: 0, limit: 100, has_more: false },
      appliedFilters: { topic, language: 'en' },
    });
    expect(data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.any(String), description: expect.any(String) }),
      ]),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['committees', 'COMMITTEE_PARLIAMENTARY_STANDING'],
    ['political_groups', 'EU_POLITICAL_GROUP'],
  ] as const)(
    'requests live %s with exact classification and preserves hostile-looking source strings',
    async (topic, classification) => {
      const label =
        'Example `code` **bold** [title](https://example.org)\nsecond line | <tag> \\ slash';
      const fetcher = installToolHttp(() =>
        envelopeResponse([
          {
            id: 'org/900001',
            identifier: 'EXAMPLE',
            label: { fr: label, en: 'English source' },
            classification: `def/ep-entities/${classification}`,
          },
        ]),
      );
      const result = await runToolContract(listReferenceTool, { topic, language: ' FR ' });
      expect(expectSuccessTwin(result)).toMatchObject({
        items: [
          {
            code: 'EXAMPLE',
            id: 'org/900001',
            label: { value: label, language: 'fr' },
            classification: `def/ep-entities/${classification}`,
          },
        ],
        appliedFilters: { language: 'fr' },
      });
      expect(
        new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('body-classification'),
      ).toBe(classification);
    },
  );

  it('reports actual fallback language and leaves sparse fields absent', async () => {
    installToolHttp(() =>
      envelopeResponse([{ id: 'org/900001', label: { de: 'Beispiel' } }, { id: 'org/900002' }]),
    );
    const data = expectSuccessTwin(
      await runToolContract(listReferenceTool, { topic: 'committees', language: 'pl' }),
    );
    expect(data).toMatchObject({
      items: [
        { code: 'org/900001', label: { value: 'Beispiel', language: 'de' } },
        { code: 'org/900002', id: 'org/900002' },
      ],
    });
    expect(data.notice).toBe('Requested language pl unavailable; returned published de text.');
  });

  it('normalizes a blank language and applies static continuation without a snapshot', async () => {
    installToolHttp(() => {
      throw new Error('Static reference requested network');
    });
    const first = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'procedure_types',
        language: ' ',
        limit: 1,
      }),
    );
    expect(first).toMatchObject({
      items: [{ code: 'ACI' }],
      page: { next_offset: 1 },
      truncated: true,
      shown: 1,
      cap: 1,
      notice: 'Continue with offset 1.',
    });
    expect(
      expectSuccessTwin(
        await runToolContract(listReferenceTool, { topic: 'procedure_types', offset: 1, limit: 1 }),
      ),
    ).toMatchObject({ items: [{ code: 'APP' }], page: { offset: 1 } });
    expect(
      expectSuccessTwin(
        await runToolContract(listReferenceTool, { topic: 'procedure_types', offset: 1000 }),
      ),
    ).toMatchObject({ items: [], page: { returned: 0, has_more: false } });
  });

  it('discloses the effective cap and preserves empty live-list guidance', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 204 }));
    const data = expectSuccessTwin(
      await runToolContract(listReferenceTool, { topic: 'political_groups', limit: 1000 }),
    );
    expect(data).toMatchObject({ items: [], page: { limit: 100, returned: 0, has_more: false } });
    expect(data.notice).toBe(
      'Requested limit normalized to the effective maximum of 100. No reference entries matched. Call euparl_list_reference with topic identifiers to inspect accepted identifiers.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
  });

  it('rejects unsupported language with declared recovery before network', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(listReferenceTool, { topic: 'coverage', language: 'xx' }),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 422])('renders upstream HTTP %i rejection with exact recovery', async (status) => {
    const fetcher = installToolHttp(() => new Response('private upstream trace', { status }));
    const result = await runToolContract(listReferenceTool, { topic: 'committees' });
    expectErrorTwin(result, 'upstream_rejected', rejectedHint, JsonRpcErrorCode.InvalidParams);
    expect(contractText(result)).not.toContain('private upstream trace');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries persistent rate limits under fake timers then renders declared recovery', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp(
      () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }),
      async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    );
    const pending = runToolContract(listReferenceTool, { topic: 'committees' });
    await vi.runAllTimersAsync();
    expectErrorTwin(await pending, 'upstream_rate_limited', rateHint, JsonRpcErrorCode.RateLimited);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('schema-rejects incompatible snapshot fields without HTTP', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { topic: 'coverage' as const, snapshot: 'not supported' };
    const result = await runToolContract(listReferenceTool, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(contractText(result)).toContain('euparl_list_reference');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
