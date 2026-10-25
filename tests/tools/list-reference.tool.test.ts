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
afterEach(() => vi.useRealTimers());

describe('euparl_list_reference contract', () => {
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
