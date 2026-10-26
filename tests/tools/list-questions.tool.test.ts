/** @fileoverview Exact question-citation resolution and published answer wire contracts. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listQuestionsTool } from '../../src/mcp-server/tools/definitions/list-questions.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { envelopeResponse, questionRecord } from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
const row = (id: string) => ({ id: `eli/dl/doc/${id}`, identifier: id });
const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => row(`E-10-2025-${String(start + i).padStart(6, '0')}`));
afterEach(() => vi.useRealTimers());

describe('euparl_list_questions contract', () => {
  it('maps list filters, normalizes blanks and case, and preserves sparse identities', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([row('E-10-2025-900001')]));
    expect(
      expectSuccessTwin(
        await runToolContract(listQuestionsTool, {
          year: 2025,
          work_type: 'question_written',
          language: ' FR ',
          question_id: '',
        }),
      ),
    ).toMatchObject({
      mode: 'list',
      items: [
        {
          question_id: 'E-10-2025-900001',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/E-10-2025-900001',
        },
      ],
      appliedFilters: { year: 2025, work_type: 'QUESTION_WRITTEN', language: 'fr' },
    });
    expect(
      Object.fromEntries(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams),
    ).toMatchObject({ year: '2025', 'work-type': 'QUESTION_WRITTEN', offset: '0', limit: '20' });
  });

  it.each(['E', 'P', 'O'])(
    'resolves %s human citation directly with explicit term',
    async (prefix) => {
      const id = `${prefix}-10-2025-900001`;
      const fetcher = installToolHttp(() => envelopeResponse([row(id)]));
      expect(
        expectSuccessTwin(
          await runToolContract(listQuestionsTool, {
            mode: 'get',
            question_id: `${prefix}-900001/2025`,
            term: 10,
          }),
        ),
      ).toMatchObject({
        found: true,
        question: { question_id: id, creator_ids: [], links: [], answers: [] },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
        `/api/v2/parliamentary-questions/${id}`,
      );
    },
  );

  it.each([
    'E-10-2025-900001',
    'eli/dl/doc/E-10-2025-900001',
    'https://data.europarl.europa.eu/eli/dl/doc/E-10-2025-900001',
  ])('bypasses scanning with canonical %s', async (question_id) => {
    const fetcher = installToolHttp(() => envelopeResponse([questionRecord]));
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id, language: 'fr' }),
    );
    expect(data).toMatchObject({
      found: true,
      question: {
        question_id: 'E-10-2025-900001',
        creator_ids: ['person/900000001'],
        links: [
          { url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.pdf' },
          { url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.html' },
        ],
        answers: [
          {
            document_id: 'E-10-2025-900001-ASW',
            date: '2025-02-15',
            links: [{ language: 'fr' }, { language: 'fr' }],
          },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves mixed answer references, nested file links, hostile-looking titles and missing-answer uncertainty', async () => {
    const title = 'Question `code` **bold** [source](https://example.org)\nnext line';
    installToolHttp(() =>
      envelopeResponse([
        {
          ...questionRecord,
          title_dcterms: { en: title },
          inverse_answers_to: [
            'eli/dl/doc/E-10-2025-900001-ASW',
            ...questionRecord.inverse_answers_to,
          ],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id: questionRecord.id }),
    );
    expect(data).toMatchObject({
      question: {
        title: { language: 'en', value: title },
        answers: [
          { document_id: 'E-10-2025-900001-ASW', links: [] },
          {
            document_id: 'E-10-2025-900001-ASW',
            links: [{ url: 'https://data.europarl.europa.eu/distribution/example/opinion_en.pdf' }],
          },
        ],
      },
    });
    installToolHttp(() => envelopeResponse([row('E-10-2025-900001')]));
    const sparse = await runToolContract(listQuestionsTool, {
      mode: 'get',
      question_id: questionRecord.id,
    });
    expect(expectSuccessTwin(sparse)).toMatchObject({
      question: { answers: [], links: [], creator_ids: [] },
    });
    expect(contractText(sparse)).not.toMatch(/unanswered|no answer exists/i);
  });

  it('resolves ordinary-year citations directly without a catalogue scan', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([questionRecord]));
    expect(
      expectSuccessTwin(
        await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'E-900001/2025' }),
      ),
    ).toMatchObject({ found: true, question: { question_id: 'E-10-2025-900001' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const urls = fetcher.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0]?.searchParams.has('year')).toBe(false);
    expect(urls[0]?.pathname).toBe('/api/v2/parliamentary-questions/E-10-2025-900001');
  });

  it('checks both overlapping terms and rejects ambiguous published identities', async () => {
    const fetcher = installToolHttp((_url, _init, index) =>
      index === 0
        ? envelopeResponse([row('E-9-2024-900001')])
        : envelopeResponse([row('E-10-2024-900001')]),
    );
    const result = await runToolContract(listQuestionsTool, {
      mode: 'get',
      question_id: 'E-900001/2024',
    });
    expectErrorTwin(result, 'invalid_filter', invalidHint);
    expect(contractText(result)).toContain('Supply term');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).pathname).toBe(
      '/api/v2/parliamentary-questions/E-10-2024-900001',
    );
  });

  it('returns a miss only after all election-year candidates are missing', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 404 }));
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'E-900001/2024' }),
    );
    expect(data).toMatchObject({ mode: 'get', found: false });
    expect(data.notice).toContain('citation year');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['P-9-2024-900001', 'E-9-2023-900001', 'E-10-2024-900001'])(
    'rejects mismatched candidate identity %s instead of selecting it',
    async (kind) => {
      installToolHttp(() => envelopeResponse([row(kind)]));
      const result = await runToolContract(listQuestionsTool, {
        mode: 'get',
        question_id: 'E-900001/2024',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.SerializationError },
      });
      expect(contractText(result)).toContain('different question identifier');
    },
  );

  it('does not turn a second-candidate deadline into a miss or return the first hit', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp(async (_url, _init, index) => {
      if (index === 0) return envelopeResponse([row('E-9-2024-900001')]);
      vi.advanceTimersByTime(40_001);
      return envelopeResponse([]);
    });
    const result = await runToolContract(listQuestionsTool, {
      mode: 'get',
      question_id: 'E-900001/2024',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(contractText(result)).toContain('deadline');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('renders cap disclosure, second page, and offset beyond the end', async () => {
    installToolHttp((url) =>
      envelopeResponse(url.searchParams.get('offset') === '0' ? page(1, 100) : []),
    );
    const first = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { limit: 1000, work_type: '', language: ' ' }),
    );
    expect(first).toMatchObject({
      page: { next_offset: 100, limit: 100 },
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 100. Continue with offset 100.',
    );
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { offset: 100 })),
    ).toMatchObject({ items: [], page: { offset: 100, has_more: false } });
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { offset: 1000 })),
    ).toMatchObject({ items: [], page: { offset: 1000, returned: 0, has_more: false } });
  });

  it.each([204, 404])('renders HTTP %i detail miss with year-list guidance', async (status) => {
    installToolHttp(() => new Response(null, { status }));
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'E-10-2025-900001' }),
    );
    expect(data).toMatchObject({ found: false });
    expect(data.notice).toContain('citation year');
    expect(data).not.toHaveProperty('question');
  });

  it.each([
    { work_type: 'UNKNOWN' },
    { language: 'xx' },
    { mode: 'get', question_id: 'E-10-2025-900001', term: 9 },
    { mode: 'get', question_id: 'not-a-citation' },
  ] as const)('rejects invalid filter %j', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(listQuestionsTool, input), 'invalid_filter', invalidHint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'get' },
    { mode: 'get', question_id: 'E-10-2025-900001', year: 2025 },
    { mode: 'get', question_id: 'E-10-2025-900001', work_type: 'QUESTION_WRITTEN' },
    { mode: 'get', question_id: 'E-10-2025-900001', limit: 1 },
    { question_id: 'E-10-2025-900001' },
    { term: 10 },
  ] as const)('rejects incompatible mode %j', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(listQuestionsTool, input),
      'invalid_mode_fields',
      modeHint,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 429])('renders HTTP %i recovery', async (status) => {
    const fetcher = installToolHttp(() => new Response(null, { status }));
    expectErrorTwin(
      await runToolContract(listQuestionsTool, {}),
      status === 429 ? 'upstream_rate_limited' : 'upstream_rejected',
      status === 429
        ? 'Wait for the reported retry interval, then repeat the same euparl tool call.'
        : 'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.',
    );
    expect(fetcher).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
  });

  it('rejects unsupported author filtering rather than silently ignoring it', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { mode: 'list' as const, author: 'person/1' };
    expectErrorTwin(
      await runToolContract(listQuestionsTool, input),
      'invalid_arguments',
      'Unknown key author. This tool accepts: mode, year, work_type, question_id, term, offset, limit, language.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a different detail identity without returning it as the requested question', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([row('E-9-2025-900001')]));
    const result = await runToolContract(listQuestionsTool, {
      mode: 'get',
      question_id: 'E-10-2025-900001',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(contractText(result)).toContain('different question identifier');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
