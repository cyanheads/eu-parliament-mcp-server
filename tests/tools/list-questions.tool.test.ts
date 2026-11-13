/** @fileoverview Exact question-citation resolution and published answer wire contracts. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { listQuestionsTool } from '../../src/mcp-server/tools/definitions/list-questions.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { envelopeResponse, questionRecord } from '../helpers/eu-parliament-fixtures.js';

const questionForms =
  'Accepted forms: a canonical identifier such as E-10-2025-000001, bare, after eli/dl/doc/ or in the exact https://data.europarl.europa.eu/eli/dl/doc/ URI, or a human citation such as E-000001/2025; prefix E, P, O, G or K in any case, sequence of one to six digits.';
const questionHint =
  "Call euparl_list_questions with mode list and the question's year for question_id values, then retry mode get with one of them.";
const row = (id: string) => ({ id: `eli/dl/doc/${id}`, identifier: id });
const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => row(`E-10-2025-${String(start + i).padStart(6, '0')}`));
const questionPath = (id: string) => `/api/v2/parliamentary-questions/${id}`;
const authority = 'http://publications.europa.eu/resource/authority/';
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

  it.each(['E', 'P', 'O', 'G', 'K'])(
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

  it.each(['P-10-2025-900001', 'O-10-2025-900001', 'G-9-2023-001001', 'K-8-2017-000001'])(
    'resolves canonical %s directly',
    async (id) => {
      const fetcher = installToolHttp(() => envelopeResponse([row(id)]));
      expect(
        expectSuccessTwin(
          await runToolContract(listQuestionsTool, { mode: 'get', question_id: id }),
        ),
      ).toMatchObject({ found: true, question: { question_id: id } });
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        questionPath(id),
      ]);
    },
  );

  it.each([
    ['G-001001/2023', ['G-9-2023-001001'], 'G-9-2023-001001'],
    ['G-001001/2024', ['G-9-2024-001001', 'G-10-2024-001001'], 'G-10-2024-001001'],
    ['K-000001/2019', ['K-8-2019-000001', 'K-9-2019-000001'], 'K-8-2019-000001'],
  ] as const)(
    'resolves interpellation citation %s through every candidate term',
    async (question_id, candidates, published) => {
      const fetcher = installToolHttp((url) =>
        url.pathname === questionPath(published)
          ? envelopeResponse([row(published)])
          : new Response(null, { status: 404 }),
      );
      expect(
        expectSuccessTwin(await runToolContract(listQuestionsTool, { mode: 'get', question_id })),
      ).toMatchObject({
        found: true,
        question: { question_id: published },
        appliedFilters: { question_id: published },
      });
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(
        candidates.map(questionPath),
      );
    },
  );

  it('rejects a term that conflicts with a canonical interpellation identifier before HTTP', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(listQuestionsTool, {
      mode: 'get',
      question_id: 'K-8-2017-000001',
      term: 9,
    });
    expectErrorTwin(
      result,
      'invalid_filter',
      'Retry with term 8, or omit term; a canonical question identifier carries its own term.',
    );
    expect(contractText(result)).toContain(
      'term 9 conflicts with question_id "K-8-2017-000001", whose term is 8.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'X-001001/2023',
    'QT-001001/2023',
    'X-10-2025-900001',
    'https://data.europarl.europa.eu/eli/dl/doc/X-10-2025-900001',
  ])(
    'rejects unsupported question prefix %s before HTTP, naming question_id, its value, the accepted forms and a next call',
    async (question_id) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract(listQuestionsTool, { mode: 'get', question_id });
      expectErrorTwin(result, 'invalid_filter', questionHint);
      const message = `question_id "${question_id}" is not a question identifier or citation. ${questionForms}`;
      expect(result.structuredContent).toMatchObject({ error: { message } });
      expect(contractText(result)).toContain(message);
      expect(contractText(result)).toContain(`Recovery: ${questionHint}`);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    (size: number) => 'E'.repeat(size),
    (size: number) => `E-${'1'.repeat(size)}`,
    (size: number) => `${'E'.repeat(size)}-000001/2025-`,
    (size: number) => `E-${'1-'.repeat(size / 2)}`,
  ])('bounds question identifier parsing CPU over long rejected input', async (shape) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const reject = async (question_id: string) => {
      const result = await runToolContract(listQuestionsTool, { mode: 'get', question_id });
      expect(result.isError).toBe(true);
    };
    for (let warmup = 0; warmup < 20; warmup++) await reject(shape(5120));
    const cpuUs: number[] = [];
    for (let size = 5120; size <= 327680; size *= 2) {
      const input = shape(size);
      let least = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 5; trial++) {
        const start = process.threadCpuUsage();
        for (let iteration = 0; iteration < 8; iteration++) await reject(input);
        const used = process.threadCpuUsage(start);
        least = Math.min(least, used.user + used.system);
      }
      expect(least).toBeLessThan(250000);
      cpuUs.push(least);
    }
    expect(cpuUs[0]).toBeGreaterThan(0);
    expect(cpuUs.at(-1)!).toBeLessThan(cpuUs[0]! * 256);
    expect(fetcher).not.toHaveBeenCalled();
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
    expectErrorTwin(
      result,
      'invalid_filter',
      'Retry with term 9 or term 10, or pass E-9-2024-900001 or E-10-2024-900001 as question_id.',
    );
    expect(contractText(result)).toContain(
      'question_id "E-900001/2024" matches questions in terms 9 and 10: E-9-2024-900001 and E-10-2024-900001.',
    );
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
      envelopeResponse(url.searchParams.get('offset') === '0' ? page(1, 1000) : []),
    );
    const first = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { limit: 1001, work_type: '', language: ' ' }),
    );
    expect(first).toMatchObject({
      page: { next_offset: 1000, limit: 1000 },
      truncated: true,
      shown: 1000,
      cap: 1000,
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 1000 questions. Continue with offset 1000.',
    );
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { offset: 1000 })),
    ).toMatchObject({
      items: [],
      page: { offset: 1000, has_more: false },
      notice:
        'The page at offset 1000 returned no questions. Restart at offset 0 or return to the previous page.',
    });
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { offset: 1000 })),
    ).toMatchObject({
      items: [],
      page: { offset: 1000, returned: 0, has_more: false },
      notice:
        'The page at offset 1000 returned no questions. Restart at offset 0 or return to the previous page.',
    });
  });

  it('keeps the no-match guidance for an empty list at offset 0', async () => {
    installToolHttp(() => new Response(null, { status: 204 }));
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { year: 2025 })),
    ).toMatchObject({
      items: [],
      page: { offset: 0, returned: 0, has_more: false },
      notice:
        'No questions matched. Remove work_type or change year; call euparl_list_reference with topic question_types.',
    });
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
    [
      { work_type: 'UNKNOWN' },
      'Call euparl_list_reference with topic question_types for every accepted code, then retry work_type with one of them.',
    ],
    [
      { work_type: 'REPORT_PLENARY' },
      'Call euparl_search_documents with source "plenary" and work_type REPORT_PLENARY, or call euparl_list_reference with topic question_types for each question work type.',
    ],
    [
      { language: 'xx' },
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
    [
      { mode: 'get', question_id: 'E-10-2025-900001', term: 9 },
      'Retry with term 10, or omit term; a canonical question identifier carries its own term.',
    ],
    [{ mode: 'get', question_id: 'not-a-citation' }, questionHint],
  ] as const)('rejects invalid filter %j', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(listQuestionsTool, input), 'invalid_filter', hint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ mode: 'get' }, 'Supply question_id for the selected mode.'],
    [
      { mode: 'get', question_id: 'E-10-2025-900001', year: 2025 },
      'Remove year, or select a mode that accepts year.',
    ],
    [
      { mode: 'get', question_id: 'E-10-2025-900001', work_type: 'QUESTION_WRITTEN' },
      'Remove work_type, or select a mode that accepts work_type.',
    ],
    [
      { mode: 'get', question_id: 'E-10-2025-900001', limit: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [
      { question_id: 'E-10-2025-900001' },
      'Remove question_id, or select a mode that accepts question_id.',
    ],
    [{ term: 10 }, 'Remove term, or select a mode that accepts term.'],
  ] as const)('rejects incompatible mode %j', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(listQuestionsTool, input), 'invalid_mode_fields', hint);
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
  it.each([
    'e-000003/2025',
    'e-10-2025-000003',
    'E-10-2025-3',
    'E-3/2025',
    'E-0003/2025',
    'https://data.europarl.europa.eu/E-10-2025-000003',
  ])('normalizes question alias %s before resolution', async (question_id) => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([{ id: 'eli/dl/doc/E-10-2025-000003', identifier: 'E-10-2025-000003' }]),
    );
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id }),
    );
    expect(data).toMatchObject({
      found: true,
      appliedFilters: { question_id: 'E-10-2025-000003' },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/E-10-2025-000003?');
  });
  it.each([
    'X-3/2025',
    'E-1234567/2025',
    'E-10-2025-1234567',
    'E-10-2025-000003-ASW',
    'https://evil.example/eli/dl/doc/E-10-2025-3',
    '../E-10-2025-3',
  ])('rejects invalid question %s with question guidance before HTTP', async (question_id) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(listQuestionsTool, { mode: 'get', question_id });
    expectErrorTwin(result, 'invalid_filter', questionHint);
    expect(contractText(result)).toContain(
      `question_id "${question_id}" is not a question identifier or citation. ${questionForms}`,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** A question participation as `/parliamentary-questions/{id}` publishes it; the role may be absent. */
const participation = (
  question: string,
  suffix: string,
  participant: { had_participant_person: string[] } | { had_participant_organization: string[] },
  participation_role?: string | string[],
) => ({
  id: `eli/dl/participation/${question}_${suffix}`,
  type: 'Participation',
  ...participant,
  ...(participation_role !== undefined && { participation_role }),
});
/**
 * Question detail as `/parliamentary-questions/{id}` published it on 2026-11-13: identity, titles,
 * creators, original language, participations and each expression's alternative title, without
 * files or answers.
 */
const liveQuestion = (
  identifier: string,
  record: {
    work_type?: string;
    date: string;
    creator: string[];
    titles: Record<string, string>;
    alternatives: Record<string, string>;
    originalLanguage: string;
    participations: ReturnType<typeof participation>[];
  },
) => ({
  id: `eli/dl/doc/${identifier}`,
  type: 'Work',
  identifier,
  work_type: `def/ep-document-types/${record.work_type ?? 'QUESTION_WRITTEN'}`,
  document_date: record.date,
  parliamentary_term: `org/ep-${identifier.split('-')[1]}`,
  creator: record.creator,
  title_dcterms: record.titles,
  is_realized_by: Object.entries(record.alternatives).map(([language, text]) => ({
    id: `eli/dl/doc/${identifier}/${language}`,
    type: 'Expression',
    title_alternative: { [language]: text },
  })),
  originalLanguage: [`${authority}language/${record.originalLanguage}`],
  workHadParticipation: record.participations,
});
const author = 'def/ep-roles/AUTHOR';
const addressee = 'def/ep-roles/ADDRESSEE';
const liveQuestions = {
  'E-10-2025-000001': liveQuestion('E-10-2025-000001', {
    date: '2025-01-01',
    creator: ['person/257064'],
    titles: { pl: 'Środki z KPO dla Polski', en: 'NRRP funds for Poland' },
    alternatives: {
      en: 'Question for written answer E-000001/2025 - to the Commission - Rule 144 - Anna Bryłka (PfE)',
      pl: 'Pytanie wymagające odpowiedzi na piśmie E-000001/2025 - do Komisji - Art. 144 Regulaminu - Anna Bryłka (PfE)',
    },
    originalLanguage: 'POL',
    participations: [
      participation(
        'E-10-2025-000001',
        '257064',
        { had_participant_person: ['person/257064'] },
        author,
      ),
      participation(
        'E-10-2025-000001',
        'COM',
        { had_participant_organization: ['org/COM'] },
        addressee,
      ),
    ],
  }),
  'E-9-2021-000001': liveQuestion('E-9-2021-000001', {
    date: '2021-01-04',
    creator: ['person/197472'],
    titles: {
      nl: 'Wereldwijde EU-sanctieregeling voor de mensenrechten',
      en: 'EU global human rights sanctions regime',
    },
    alternatives: {
      nl: 'Vraag met verzoek om schriftelijk antwoord E-000001/2021/rev.1<br/>aan de Raad<br/>Artikel 138 van het Reglement<br/>Filip De Man (ID)',
      en: 'Question for written answer E-000001/2021/rev.1<br/>to the Council<br/>Rule 138<br/>Filip De Man (ID)',
    },
    originalLanguage: 'NLD',
    participations: [
      participation(
        'E-9-2021-000001',
        'CS',
        { had_participant_organization: ['org/EU_COUNCIL'] },
        addressee,
      ),
      participation(
        'E-9-2021-000001',
        '197472',
        { had_participant_person: ['person/197472'] },
        author,
      ),
    ],
  }),
  'P-10-2025-000006': liveQuestion('P-10-2025-000006', {
    work_type: 'QUESTION_WRITTEN_PRIORITY',
    date: '2025-01-03',
    creator: ['person/125093', 'person/197734'],
    titles: {
      el: 'Το επικίνδυνο ενδεχόμενο υπογραφής ενός τουρκοσυριακού συμφώνου για τις θαλάσσιες ζώνες',
      en: 'The dangerous possibility of a Turkish-Syrian maritime zone agreement',
    },
    alternatives: {
      en: 'Priority question for written answer P-000006/2025 - to the Vice-President of the Commission / High Representative of the Union for Foreign Affairs and Security Policy - Rule 144 - Kostas Papadakis (NI), Lefteris Nikolaou-Alavanos (NI)',
      el: 'Ερώτηση προτεραιότητας με αίτημα γραπτής απάντησης P-000006/2025 - προς την Αντιπρόεδρο της Επιτροπής/Ύπατη Εκπρόσωπο της Ένωσης για Θέματα Εξωτερικής Πολιτικής και Πολιτικής Ασφάλειας - Άρθρο 144 του Κανονισμού - Κώστας Παπαδάκης (NI), Λευτέρης Νικολάου-Αλαβάνος (NI)',
    },
    originalLanguage: 'ELL',
    participations: [
      participation(
        'P-10-2025-000006',
        '197734',
        { had_participant_person: ['person/197734'] },
        author,
      ),
      participation(
        'P-10-2025-000006',
        '125093',
        { had_participant_person: ['person/125093'] },
        author,
      ),
      participation(
        'P-10-2025-000006',
        'HRVP',
        { had_participant_organization: ['org/HRVP'] },
        addressee,
      ),
    ],
  }),
  'E-8-2017-000005': liveQuestion('E-8-2017-000005', {
    date: '2017-01-03',
    creator: ['person/127330'],
    titles: { en: 'Strategy on migration policy', es: 'Estrategia en política migratoria' },
    alternatives: {
      en: 'Question for written answer E-000005/2017<br/>to the Commission<br/>Rule 130<br/>Tania González Peñas (GUE/NGL)',
      es: 'Pregunta con solicitud de respuesta escrita E-000005/2017<br/>a la Comisión<br/>Artículo 130 del Reglamento<br/>Tania González Peñas (GUE/NGL)',
    },
    originalLanguage: 'SPA',
    participations: [
      participation('E-8-2017-000005', '127330', { had_participant_person: ['person/127330'] }, [
        `${authority}role/AUT`,
        author,
      ]),
      participation(
        'E-8-2017-000005',
        'COM',
        { had_participant_organization: [`${authority}corporate-body/COM`, 'org/EU_COMMISSION'] },
        addressee,
      ),
    ],
  }),
  /**
   * Four of its 64 participations, none with a role (the Commission is one of them), and the first
   * three of its 63 creators and the first two of its 63 alternative-title authors.
   */
  'K-8-2017-000001': liveQuestion('K-8-2017-000001', {
    work_type: 'INTERPELLATION_MINOR',
    date: '2017-01-27',
    creator: ['person/124991', 'person/4432', 'person/28508'],
    titles: {
      fr: 'VP/HR - La politique israélienne de colonisation',
      en: 'VP/HR - Israeli settlement policy',
    },
    alternatives: {
      en: "Minor interpellation for written answer K-000001/2017<br/>to the Commission<br/>Rule 130a<br/>Marietje Schaake, Sophia in 't Veld",
    },
    originalLanguage: 'ENG',
    participations: [
      participation('K-8-2017-000001', '124987', { had_participant_person: ['person/124987'] }),
      participation('K-8-2017-000001', '28481', { had_participant_person: ['person/28481'] }),
      participation('K-8-2017-000001', 'COM', {
        had_participant_organization: [`${authority}corporate-body/COM`, 'org/EU_COMMISSION'],
      }),
      participation('K-8-2017-000001', '112753', { had_participant_person: ['person/112753'] }),
    ],
  }),
};

describe('euparl_list_questions addressees, alternative titles and original languages', () => {
  it.each([
    [
      'E-10-2025-000001',
      'en',
      {
        title: { value: 'NRRP funds for Poland', language: 'en' },
        alternative_title: {
          value:
            'Question for written answer E-000001/2025 - to the Commission - Rule 144 - Anna Bryłka (PfE)',
          language: 'en',
        },
        creator_ids: ['person/257064'],
        addressee_ids: ['org/COM'],
        original_languages: ['pl'],
      },
    ],
    [
      'E-10-2025-000001',
      'pl',
      {
        title: { value: 'Środki z KPO dla Polski', language: 'pl' },
        alternative_title: {
          value:
            'Pytanie wymagające odpowiedzi na piśmie E-000001/2025 - do Komisji - Art. 144 Regulaminu - Anna Bryłka (PfE)',
          language: 'pl',
        },
        addressee_ids: ['org/COM'],
        original_languages: ['pl'],
      },
    ],
    [
      'E-9-2021-000001',
      'en',
      {
        alternative_title: {
          value:
            'Question for written answer E-000001/2021/rev.1<br/>to the Council<br/>Rule 138<br/>Filip De Man (ID)',
          language: 'en',
        },
        creator_ids: ['person/197472'],
        addressee_ids: ['org/EU_COUNCIL'],
        original_languages: ['nl'],
      },
    ],
    [
      'P-10-2025-000006',
      'en',
      {
        work_type: 'def/ep-document-types/QUESTION_WRITTEN_PRIORITY',
        alternative_title: {
          value:
            'Priority question for written answer P-000006/2025 - to the Vice-President of the Commission / High Representative of the Union for Foreign Affairs and Security Policy - Rule 144 - Kostas Papadakis (NI), Lefteris Nikolaou-Alavanos (NI)',
          language: 'en',
        },
        creator_ids: ['person/125093', 'person/197734'],
        addressee_ids: ['org/HRVP'],
        original_languages: ['el'],
      },
    ],
    [
      'E-8-2017-000005',
      'en',
      {
        alternative_title: {
          value:
            'Question for written answer E-000005/2017<br/>to the Commission<br/>Rule 130<br/>Tania González Peñas (GUE/NGL)',
          language: 'en',
        },
        creator_ids: ['person/127330'],
        addressee_ids: [
          'http://publications.europa.eu/resource/authority/corporate-body/COM',
          'org/EU_COMMISSION',
        ],
        original_languages: ['es'],
      },
    ],
    [
      'K-8-2017-000001',
      'en',
      {
        work_type: 'def/ep-document-types/INTERPELLATION_MINOR',
        title: { value: 'VP/HR - Israeli settlement policy', language: 'en' },
        alternative_title: {
          value:
            "Minor interpellation for written answer K-000001/2017<br/>to the Commission<br/>Rule 130a<br/>Marietje Schaake, Sophia in 't Veld",
          language: 'en',
        },
        creator_ids: ['person/124991', 'person/4432', 'person/28508'],
        addressee_ids: [],
        original_languages: ['en'],
      },
    ],
  ] as const)(
    'returns %s in %s with its published addressees, original language and alternative title in one request',
    async (question_id, language, expected) => {
      const fetcher = installToolHttp(() => envelopeResponse([liveQuestions[question_id]]));
      const result = await runToolContract(listQuestionsTool, {
        mode: 'get',
        question_id,
        language,
      });
      const data = expectSuccessTwin(result);
      expect(data).toMatchObject({ found: true, question: { question_id, ...expected } });
      expect(data).not.toHaveProperty('notice');
      expect(contractText(result)).toContain(
        `result.question.alternative_title.value: \` ${JSON.stringify(expected.alternative_title.value)} \``,
      );
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        questionPath(question_id),
      ]);
    },
  );

  it('returns an EU authority URI published in place of a Parliament code, as addressee_ids describes', async () => {
    const id = 'P-9-2022-000009';
    const hrufasp = `${authority}corporate-body/HRUFASP`;
    installToolHttp(() =>
      envelopeResponse([
        liveQuestion(id, {
          work_type: 'QUESTION_WRITTEN_PRIORITY',
          date: '2022-01-04',
          creator: ['person/197400'],
          titles: { en: 'Example priority question' },
          alternatives: { en: 'Priority question for written answer P-000009/2022' },
          originalLanguage: 'ENG',
          participations: [
            participation(id, 'HRUFASP', { had_participant_organization: [hrufasp] }, addressee),
          ],
        }),
      ]),
    );
    const result = await runToolContract(listQuestionsTool, { mode: 'get', question_id: id });
    expect(expectSuccessTwin(result)).toMatchObject({
      question: { question_id: id, addressee_ids: [hrufasp] },
    });
    expect(contractText(result)).toContain(
      `result.question.addressee_ids[0]: [\` "${hrufasp}" \`]`,
    );
    const described = z
      .object({
        properties: z.object({
          question: z.object({
            properties: z.object({ addressee_ids: z.object({ description: z.string() }) }),
          }),
        }),
      })
      .parse(z.toJSONSchema(listQuestionsTool.output)).properties.question.properties
      .addressee_ids.description;
    expect(described).toContain(
      'org/COM, org/EU_COMMISSION, org/EU_COUNCIL or org/HRVP; some records publish an EU authority URI (http://publications.europa.eu/resource/authority/corporate-body/…) beside such a code or in its place;',
    );
  });

  it('falls back to the English alternative title with the shared language notice', async () => {
    installToolHttp(() => envelopeResponse([liveQuestions['E-10-2025-000001']]));
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, {
        mode: 'get',
        question_id: 'E-10-2025-000001',
        language: 'fr',
      }),
    );
    expect(data.question).toMatchObject({
      title: { value: 'NRRP funds for Poland', language: 'en' },
      alternative_title: {
        value:
          'Question for written answer E-000001/2025 - to the Commission - Rule 144 - Anna Bryłka (PfE)',
        language: 'en',
      },
      addressee_ids: ['org/COM'],
      original_languages: ['pl'],
    });
    expect(data.notice).toBe(
      'Requested language fr unavailable; returned published en text. Requested file language fr unavailable; returned published en files.',
    );
  });

  it('reads a singleton participation, role arrays and reference objects, keeping every addressee in published order', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          ...row('O-10-2025-900001'),
          workHadParticipation: {
            id: 'eli/dl/participation/O-10-2025-900001_HRVP',
            had_participant_organization: { id: 'org/HRVP' },
            participation_role: [addressee],
          },
          originalLanguage: `${authority}language/DEU`,
        },
      ]),
    );
    expect(
      expectSuccessTwin(
        await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'O-10-2025-900001' }),
      ).question,
    ).toMatchObject({ addressee_ids: ['org/HRVP'], original_languages: ['de'] });
    installToolHttp(() =>
      envelopeResponse([
        {
          ...row('O-10-2025-900002'),
          creator: ['org/ITRE', 'person/257047'],
          workHadParticipation: [
            {
              id: 'eli/dl/participation/O-10-2025-900002_ITRE',
              had_participant_organization: ['org/ITRE'],
              participation_role: [`${authority}role/AUT`, author],
            },
            {
              id: 'eli/dl/participation/O-10-2025-900002_CS',
              had_participant_organization: 'org/EU_COUNCIL',
              participation_role: addressee,
            },
            {
              id: 'eli/dl/participation/O-10-2025-900002_COM',
              had_participant_organization: [{ id: 'org/EU_COMMISSION' }, 'org/COM'],
              participation_role: addressee,
            },
          ],
          originalLanguage: [`${authority}language/FRA`, `${authority}language/DEU`],
        },
      ]),
    );
    expect(
      expectSuccessTwin(
        await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'O-10-2025-900002' }),
      ).question,
    ).toMatchObject({
      creator_ids: ['org/ITRE', 'person/257047'],
      addressee_ids: ['org/EU_COUNCIL', 'org/EU_COMMISSION', 'org/COM'],
      original_languages: ['fr', 'de'],
    });
  });

  it('returns empty addressees and languages and no alternative title when none is published, leaving every other field as it was', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([questionRecord]));
    const data = expectSuccessTwin(
      await runToolContract(listQuestionsTool, { mode: 'get', question_id: 'E-10-2025-900001' }),
    );
    const english = {
      url: 'https://data.europarl.europa.eu/distribution/example/opinion_en.pdf',
      language: 'en',
    };
    expect(data.question).toEqual({
      question_id: 'E-10-2025-900001',
      title: { value: 'Example opinion', language: 'en' },
      date: '2025-01-15',
      work_type: 'def/ep-document-types/QUESTION_WRITTEN',
      term_id: 'org/ep-10',
      creator_ids: ['person/900000001'],
      addressee_ids: [],
      original_languages: [],
      links: [english],
      answers: [{ document_id: 'E-10-2025-900001-ASW', date: '2025-02-15', links: [english] }],
      source_url: 'https://data.europarl.europa.eu/eli/dl/doc/E-10-2025-900001',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps list rows to their sparse identity when a row carries roles, languages and alternative titles', async () => {
    installToolHttp(() => envelopeResponse([liveQuestions['E-10-2025-000001']]));
    expect(
      expectSuccessTwin(await runToolContract(listQuestionsTool, { year: 2025 })).items,
    ).toEqual([
      {
        question_id: 'E-10-2025-000001',
        work_type: 'def/ep-document-types/QUESTION_WRITTEN',
        source_url: 'https://data.europarl.europa.eu/eli/dl/doc/E-10-2025-000001',
      },
    ]);
  });
});
