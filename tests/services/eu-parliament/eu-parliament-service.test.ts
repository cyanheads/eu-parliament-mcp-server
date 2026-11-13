/** @fileoverview Complete acquisition workflows tested through injected HTTP responses. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  type DocumentsInput,
  EuParliamentService,
} from '../../../src/services/eu-parliament/eu-parliament-service.js';
import {
  decisionRecord,
  documentRecord,
  envelopeResponse,
  maltaOn20240313,
  mepRecord,
  questionRecord,
  rosterRecords,
} from '../../helpers/eu-parliament-fixtures.js';

/** Records limit-clamp counter increments; the rest of the framework utils module is real. */
const telemetry = vi.hoisted(() => {
  const add = vi.fn();
  return { add, createCounter: vi.fn(() => ({ add })) };
});
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: telemetry.createCounter,
}));

const context = () => ({ signal: new AbortController().signal });
const makeService = (fetcher: typeof fetch, now?: () => number) =>
  new EuParliamentService({ fetch: fetcher, wait: async () => {}, ...(now && { now }) });
const questionRow = (id: string) => ({ id: `eli/dl/doc/${id}`, identifier: id });

describe('Parliament domain workflows', () => {
  it.each(['documents', 'speeches'] as const)(
    'walks 500 %s once with changing caller limits and fixed sorted geometry',
    async (family) => {
      const queries: URLSearchParams[] = [];
      const service = makeService(async (url) => {
        const query = new URL(String(url)).searchParams;
        queries.push(query);
        const offset = Number(query.get('offset'));
        const limit = Number(query.get('limit'));
        const prefix = family === 'speeches' ? 'eli/dl/event/' : 'eli/dl/doc/';
        return Response.json({
          data: Array.from({ length: Math.max(0, Math.min(limit, 500 - offset)) }, (_, i) => ({
            id: `${prefix}ID-${String(offset + i).padStart(3, '0')}`,
          })),
          meta: { total: 500 },
        });
      });
      const walk = async (limits: number[]) => {
        const seen: string[] = [];
        let offset = 0;
        for (let index = 0; offset < 500; index++) {
          const input = { offset, limit: limits[index % limits.length]! };
          const result =
            family === 'speeches'
              ? await service.searchSpeeches(input, context())
              : await service.searchDocuments(input, context());
          if (result.data.mode !== 'search') throw new Error('Expected search');
          seen.push(
            ...result.data.items.map((row) =>
              'speech_id' in row ? row.speech_id : row.document_id,
            ),
          );
          if (!result.data.page.has_more) break;
          offset = result.data.page.next_offset!;
        }
        return seen;
      };
      const expected = Array.from({ length: 500 }, (_, i) => `ID-${String(i).padStart(3, '0')}`);
      expect(await walk([100])).toEqual(expected);
      expect(await walk([37, 63, 201, 19, 180])).toEqual(expected);
      expect(queries.length).toBeGreaterThan(10);
      for (const query of queries) {
        expect(query.get('limit')).toBe('100');
        expect(Number(query.get('offset')) % 100).toBe(0);
        expect(query.get('sort-by')).toBe(
          family === 'speeches' ? 'sitting-date:asc,numbering:asc' : 'doc-id:asc',
        );
      }
    },
  );
  it('keeps the original operation deadline across aligned pages and returns no partial success', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now += 20000;
      return envelopeResponse(
        Array.from({ length: 100 }, (_, i) => ({ id: `eli/dl/event/S-${i}` })),
      );
    });
    await expect(
      makeService(fetcher, () => now).searchSpeeches({ limit: 1000 }, context()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  describe('adopted-text search rows', () => {
    const pool = Array.from(
      { length: 250 },
      (_, i) => `TA-9-2024-${String(i + 1).padStart(4, '0')}`,
    );
    /** Each aligned page answers in reverse document_id order, as `language=` pages can. */
    const upstream = (extra: (id: string) => Record<string, unknown> = () => ({})) => {
      const queries: URLSearchParams[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const query = new URL(String(url)).searchParams;
        queries.push(query);
        const offset = Number(query.get('offset'));
        return Response.json({
          data: pool
            .slice(offset, offset + Number(query.get('limit')))
            .toReversed()
            .map((id) => ({ id: `eli/dl/doc/${id}`, identifier: id, ...extra(id) })),
          meta: { total: pool.length },
        });
      });
      return { fetcher, queries };
    };
    const search = async (service: EuParliamentService, input: DocumentsInput) => {
      const result = await service.searchDocuments(input, context());
      if (result.data.mode !== 'search') throw new Error('Expected search');
      return { ...result.data, enrichment: result.enrichment };
    };
    it('reorders every aligned page by document_id, so a walk at any caller limit reads the set once in order', async () => {
      const { fetcher, queries } = upstream((id) => ({ title_dcterms: { en: `Title ${id}` } }));
      const service = makeService(fetcher);
      const walk = async (limits: number[]) => {
        const seen: string[] = [];
        for (let index = 0, offset = 0; ; index++) {
          const page = await search(service, { offset, limit: limits[index % limits.length]! });
          seen.push(...page.items.map((row) => row.document_id));
          if (!page.page.has_more) return seen;
          offset = page.page.next_offset!;
        }
      };
      expect(await walk([100])).toEqual(pool);
      expect(await walk([37, 63, 100, 19])).toEqual(pool);
      for (const query of queries) {
        expect(Object.fromEntries(query)).toMatchObject({
          limit: '100',
          'sort-by': 'doc-id:asc',
          language: 'en',
          'search-language': 'en',
        });
        expect(query.has('view')).toBe(false);
        expect(Number(query.get('offset')) % 100).toBe(0);
      }
    });
    it('narrows a sorted call to 100 rows from at most two aligned requests', async () => {
      const { fetcher, queries } = upstream();
      const service = makeService(fetcher);
      const first = await search(service, { limit: 1000 });
      expect(first.items.map((row) => row.document_id)).toEqual(pool.slice(0, 100));
      expect(first.page).toMatchObject({ offset: 0, limit: 100, returned: 100, next_offset: 100 });
      expect(first.enrichment.notice).toContain(
        'Requested limit normalized to the effective maximum of 100 adopted texts.',
      );
      expect(queries.map((query) => query.get('offset'))).toEqual(['0']);
      const spanning = await search(service, { offset: 150, limit: 5000 });
      expect(spanning.items.map((row) => row.document_id)).toEqual(pool.slice(150, 250));
      expect(spanning.page).toMatchObject({ offset: 150, limit: 100, returned: 100 });
      expect(queries.map((query) => query.get('offset'))).toEqual(['0', '100', '200']);
    });
    it('returns the requested-language title, date and procedure_ids and counts rows without that title', async () => {
      const rows: Record<string, Record<string, unknown>> = {
        'TA-9-2024-0001': {
          label: 'T9-0001/2024',
          title_dcterms: { hr: 'Naslov' },
          document_date: '2024-01-16',
          inverse_created_a_realization_of: [
            'eli/dl/event/MTG-PL-2024-01-16-PVCRE-ITM-1',
            'eli/dl/proc/2023-0001',
            { id: 'https://data.europarl.europa.eu/eli/dl/proc/2023-0002' },
          ],
        },
        'TA-9-2024-0002': { title_dcterms: { en: 'English only' }, document_date: '2024-01-17' },
        'TA-9-2024-0003': {
          is_realized_by: ['eli/dl/doc/TA-9-2024-0003/es', 'eli/dl/doc/TA-9-2024-0003/it'],
        },
        'TA-9-2024-0004': {
          title_dcterms: { hr: 'Drugi naslov' },
          is_realized_by: [
            { id: 'e', is_embodied_by: [{ id: 'm', issued: ['2024-01-18', '2024-01-19'] }] },
          ],
        },
      };
      const { fetcher } = upstream((id) => rows[id] ?? { title_dcterms: { hr: id } });
      const page = await search(makeService(fetcher), { language: 'HR', limit: 4 });
      expect(page.items).toEqual([
        {
          document_id: 'TA-9-2024-0001',
          identifier: 'TA-9-2024-0001',
          label: 'T9-0001/2024',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0001',
          title: { value: 'Naslov', language: 'hr' },
          date: '2024-01-16',
          procedure_ids: ['2023-0001', '2023-0002'],
        },
        {
          document_id: 'TA-9-2024-0002',
          identifier: 'TA-9-2024-0002',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0002',
          date: '2024-01-17',
          procedure_ids: [],
        },
        {
          document_id: 'TA-9-2024-0003',
          identifier: 'TA-9-2024-0003',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0003',
          procedure_ids: [],
        },
        {
          document_id: 'TA-9-2024-0004',
          identifier: 'TA-9-2024-0004',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0004',
          title: { value: 'Drugi naslov', language: 'hr' },
          procedure_ids: [],
        },
      ]);
      expect(page.enrichment.notice).toBe(
        "2 rows on this page have no title in hr, the only language the adopted-text list returns; mode get with a row's document_id reads its title in another published language.",
      );
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('language')).toBe('hr');
    });
    it('sends one keyword request in the requested language, keeps relevance order and caps it at 100 rows', async () => {
      const { fetcher, queries } = upstream((id) => ({ title_dcterms: { en: id } }));
      const page = await search(makeService(fetcher), { text: 'budget', offset: 100, limit: 1000 });
      expect(page.items.map((row) => row.document_id)).toEqual(pool.slice(100, 200).toReversed());
      expect(page.page).toMatchObject({ offset: 100, limit: 100, returned: 100 });
      expect(page.enrichment.notice).toContain(
        'Requested limit normalized to the effective maximum of 100 keyword adopted texts.',
      );
      expect(queries).toHaveLength(1);
      expect(Object.fromEntries(queries[0]!)).toEqual({
        offset: '100',
        limit: '100',
        text: 'budget',
        'search-language': 'en',
        language: 'en',
        format: 'application/ld+json',
      });
    });
    it.each(['committee', 'plenary'] as const)(
      'keeps %s rows, bounds and requests as they are',
      async (source) => {
        const { fetcher, queries } = upstream(() => ({
          label: 'X9-0001/2024',
          work_type: 'def/ep-document-types/REPORT_PLENARY',
          title_dcterms: { en: 'Not read from family lists' },
          document_date: '2024-01-16',
          inverse_created_a_realization_of: 'eli/dl/proc/2023-0001',
        }));
        const page = await search(makeService(fetcher), { source, limit: 1000 });
        expect(page.items[0]).toEqual({
          document_id: 'TA-9-2024-0250',
          identifier: 'TA-9-2024-0250',
          label: 'X9-0001/2024',
          work_type: 'def/ep-document-types/REPORT_PLENARY',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0250',
        });
        expect(page.page).toMatchObject({ offset: 0, limit: 1000, returned: 250 });
        expect(page.enrichment).not.toHaveProperty('notice');
        expect(queries).toHaveLength(1);
        expect(Object.fromEntries(queries[0]!)).toEqual({
          offset: '0',
          limit: '1000',
          format: 'application/ld+json',
        });
      },
    );
  });
  it('slices sorted fixed upstream speech pages across boundaries independently of caller geometry', async () => {
    const calls: { offset: number; limit: number; sort: string | null }[] = [];
    const service = makeService(async (url) => {
      const query = new URL(String(url)).searchParams;
      const offset = Number(query.get('offset'));
      const limit = Number(query.get('limit'));
      calls.push({ offset, limit, sort: query.get('sort-by') });
      return Response.json({
        data: Array.from({ length: Math.min(limit, 250 - offset) }, (_, i) => ({
          id: `eli/dl/event/S-${offset + i}`,
        })),
        meta: { total: 250 },
      });
    });
    const page = await service.searchSpeeches({ offset: 97, limit: 110 }, context());
    if (page.data.mode !== 'search') throw new Error('Expected search');
    expect(page.data.items.map((row) => row.speech_id)).toEqual(
      Array.from({ length: 110 }, (_, i) => `S-${97 + i}`),
    );
    expect(calls).toEqual(
      [0, 100, 200].map((offset) => ({
        offset,
        limit: 100,
        sort: 'sitting-date:asc,numbering:asc',
      })),
    );
    expect(page.data.page).toMatchObject({
      offset: 97,
      limit: 110,
      returned: 110,
      next_offset: 207,
    });
  });
  it('explains local past-end pages with exact totals after validating the snapshot', async () => {
    const service = makeService(async () => envelopeResponse([{ id: 'eli/dl/proc/2025-0001' }]));
    const page = await service.listProcedures({ process_type: 'INL', offset: 1 }, context());
    expect(page.enrichment.notice).toBe(
      'The offset 1 is at or beyond the complete collection of 1 items. Restart at offset 0 or return to the previous page.',
    );
    await expect(
      service.listProcedures({ process_type: 'INL', offset: 1, snapshot: 'stale' }, context()),
    ).rejects.toMatchObject({ data: { reason: 'snapshot_changed' } });
  });
  it('honors a large local decision page with complete relation arrays', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `eli/dl/doc/D-${i}`);
    const service = makeService(async () =>
      envelopeResponse(
        Array.from({ length: 105 }, (_, i) => ({
          id: `eli/dl/event/D-${i}`,
          decided_on_a_realization_of: ids,
        })),
      ),
    );
    const response = await service.getPlenaryVotes(
      { sitting_id: '2025-01-15', limit: 1000 },
      context(),
    );
    if (response.data.mode !== 'decisions') throw new Error('Expected decisions');
    expect(response.data.decisions).toHaveLength(105);
    expect(response.data.decisions?.at(-1)?.document_ids).toHaveLength(500);
    expect(response.data.page).toMatchObject({ limit: 1000, returned: 105, has_more: false });
  });
  it.each([1, 20])(
    'paces exactly %i selected organization GETs without hidden enrichment calls',
    async (count) => {
      let now = 0;
      const starts: number[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        starts.push(now);
        return envelopeResponse([{ id: `org/${new URL(String(url)).pathname.split('/').at(-1)}` }]);
      });
      const service = new EuParliamentService({
        fetch: fetcher,
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
      });
      const result = await service.listReference(
        {
          topic: 'organizations',
          organization_ids: Array.from({ length: count }, (_, index) => String(index + 1)),
        },
        context(),
      );
      expect(result.data.items).toHaveLength(count);
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(starts).toEqual(Array.from({ length: count }, (_, index) => index * 700));
    },
  );
  it('keeps one shared 40-second deadline across later organization detail reads', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      now += 20_000;
      return envelopeResponse([{ id: `org/${new URL(String(url)).pathname.split('/').at(-1)}` }]);
    });
    await expect(
      makeService(fetcher, () => now).listReference(
        { topic: 'organizations', organization_ids: ['1', '2', '3'] },
        context(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retries an unavailable organization detail without turning failure into a miss', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(
      makeService(fetcher).listReference(
        { topic: 'organizations', organization_ids: ['1', '2'] },
        context(),
      ),
    ).rejects.toMatchObject({ data: { status: 503, retryable: true } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('caps a complete filtered decision collection without losing its total', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      envelopeResponse(
        Array.from({ length: 101 }, (_, index) => ({
          id: decisionRecord.id,
          activity_id: `DEC-${index}`,
          decided_on_a_realization_of: 'eli/dl/doc/A-1-AM-1',
        })),
      ),
    );
    const result = await makeService(fetcher).getPlenaryVotes(
      { sitting_id: '2025-01-15', document_id: 'eli/dl/doc/A-1', limit: 1000 },
      context(),
    );
    expect(result.data).toMatchObject({ page: { returned: 101, limit: 1000, has_more: false } });
    expect(result.enrichment).toMatchObject({
      totalCount: 101,
      appliedFilters: { document_id: 'A-1' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['sittings', 'decision', 'voters'] as const)(
    'rejects document filters in %s mode before HTTP',
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        makeService(fetcher).getPlenaryVotes({ mode, document_id: 'A-1' }, context()),
      ).rejects.toMatchObject({ data: { reason: 'invalid_mode_fields' } });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  describe('decisions document_id citations and letter case', () => {
    const decision = (id: string, relation: Record<string, string>) => ({
      id: `eli/dl/event/MTG-PL-2024-03-13-${id}`,
      activity_id: id,
      ...relation,
    });
    const sitting = () =>
      vi.fn<typeof fetch>().mockImplementation(async () =>
        envelopeResponse([
          decision('DEC-1', { decided_on_a_realization_of: 'eli/dl/doc/A-9-2023-0188' }),
          decision('DEC-2', {
            decided_on_a_part_of_a_realization_of: 'eli/dl/doc/A-9-2023-0188-AM-001',
          }),
          decision('DEC-3', { decided_on_a_realization_of: 'eli/dl/doc/A-9-2023-0189' }),
          decision('DEC-4', { decided_on_a_realization_of: 'eli/dl/doc/B-10-2024-0156' }),
          decision('DEC-5', { recorded_in_a_realization_of: 'eli/dl/doc/QOB-10-2024-0156' }),
        ]),
      );
    const select = async (document_id: string) => {
      const fetcher = sitting();
      const result = await makeService(fetcher).getPlenaryVotes(
        { sitting_id: '2024-03-13', document_id },
        context(),
      );
      if (result.data.mode !== 'decisions') throw new Error('Expected decisions');
      expect(fetcher).toHaveBeenCalledTimes(1);
      return {
        ids: result.data.decisions.map((row) => row.decision_id),
        total: result.enrichment.totalCount,
        snapshot: result.data.page.snapshot,
        document_id: result.enrichment.appliedFilters.document_id,
      };
    };
    it('selects the same decisions, total and snapshot for a report citation in any letter case', async () => {
      const canonical = await select('A-9-2023-0188');
      expect(canonical).toMatchObject({
        ids: ['DEC-1', 'DEC-2'],
        total: 2,
        document_id: 'A-9-2023-0188',
      });
      for (const citation of ['a-9-2023-0188', 'A9-0188/2023', 'p9_a(2023)0188'])
        expect(await select(citation)).toEqual(canonical);
    });
    it('maps a B citation to the B- motion only', async () => {
      const motion = await select('B-10-2024-0156');
      expect(motion).toMatchObject({ ids: ['DEC-4'], total: 1, document_id: 'B-10-2024-0156' });
      expect(await select('B10-0156/2024')).toEqual(motion);
    });
    it.each(['A9-188/2023', 'AD-PE786.674', 'E-000003/2025'])(
      'rejects %s with the accepted document_id forms before HTTP',
      async (document_id) => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(
          makeService(fetcher).getPlenaryVotes(
            { sitting_id: '2024-03-13', document_id },
            context(),
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining(
            `document_id ${JSON.stringify(document_id)} is not a document identifier or citation.`,
          ),
          data: { reason: 'invalid_filter' },
        });
        expect(fetcher).not.toHaveBeenCalled();
      },
    );
  });
  it('guards the effective capped limit rather than the requested limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const result = await makeService(fetcher).searchSpeeches(
      { offset: 9900, limit: 1000 },
      context(),
    );
    expect(result.data).toMatchObject({ page: { limit: 100 } });
    expect(result.enrichment.notice).toContain(
      'Requested limit normalized to 100: offset plus limit cannot pass the 10000-result search window.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
  });
  it('preserves deep question paging without imposing a search window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const result = await makeService(fetcher).listQuestions({ offset: 9990, limit: 20 }, context());
    expect(result.data).toMatchObject({ items: [], page: { offset: 9990, limit: 20 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['speeches', 10000, 'Narrow text, title, person_id, activity_type or sitting dates.'],
    ['procedures', 10000, 'Narrow process_type to retrieve a smaller procedure set.'],
    [
      'adopted_texts',
      12000,
      'Narrow text, title, year, term, work_type, sitting dates or related_process_id.',
    ],
  ] as const)(
    'rejects a %s offset of %i past the search window with a narrowing hint before HTTP',
    async (source, offset, narrowing) => {
      const fetcher = vi.fn<typeof fetch>();
      const service = makeService(fetcher);
      const input = { offset, limit: 1 };
      const pending =
        source === 'speeches'
          ? service.searchSpeeches(input, context())
          : source === 'procedures'
            ? service.listProcedures(input, context())
            : service.searchDocuments({ ...input, source }, context());
      await expect(pending).rejects.toMatchObject({
        data: {
          reason: 'invalid_filter',
          recovery: { hint: `${narrowing} Restart paging at offset 0 after narrowing.` },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['speeches', 9990, 20, 10],
    ['procedures', 9990, 20, 10],
    ['adopted_texts', 9990, 20, 10],
    ['procedures', 9900, 1000, 100],
    ['procedures', 9950, 1000, 50],
    ['adopted_texts', 9950, 1000, 50],
  ] as const)(
    'narrows a %s page at offset %i and limit %i to the %i results left in the window',
    async (source, offset, limit, effective) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
      const service = makeService(fetcher);
      const input = { offset, limit };
      const result = await (source === 'speeches'
        ? service.searchSpeeches(input, context())
        : source === 'procedures'
          ? service.listProcedures(input, context())
          : service.searchDocuments({ ...input, source }, context()));
      expect(result.data).toMatchObject({ page: { offset, limit: effective } });
      expect(result.enrichment.notice).toContain(
        `Requested limit normalized to ${effective}: offset plus limit cannot pass the 10000-result search window.`,
      );
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.get('offset')).toBe(
        String(source === 'procedures' ? offset : Math.floor(offset / 100) * 100),
      );
      expect(url.searchParams.get('limit')).toBe(String(source === 'procedures' ? effective : 100));
    },
  );
  describe('listProcedures with process_type', () => {
    const procedureRows = (ids: string[]) => ids.map((id) => ({ id: `eli/dl/proc/${id}` }));
    it('lets both bulk and unfiltered reads complete after 15 seconds within the operation deadline', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const starts: number[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            starts.push(Date.now());
            const timer = setTimeout(
              () =>
                resolve(Response.json({ data: procedureRows(['2025-0001']), meta: { total: 1 } })),
              20_000,
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      );
      const service = new EuParliamentService({
        fetch: fetcher,
        now: () => Date.now(),
        wait: async () => {},
        timeout: (ms) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
          return controller.signal;
        },
      });
      const bulk = service
        .listProcedures({ process_type: 'RSP' }, context())
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await bulk).toMatchObject({ data: { items: [{ procedure_id: '2025-0001' }] } });
      expect(starts).toEqual([0]);
      const unfiltered = service.listProcedures({}, context()).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await unfiltered).toMatchObject({ data: { items: [{ procedure_id: '2025-0001' }] } });
      expect(starts.slice(1).map((start) => start - 40_000)).toEqual([0]);
    });
    it('acquires the set in one offset-0 request and pages it locally in procedure_id order', async () => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({
          data: procedureRows(['2025-0002', '2024-0009', '2025-0001A', '2025-0001']),
          meta: { total: 4 },
        }),
      );
      const result = await makeService(fetcher).listProcedures(
        { process_type: 'cns', offset: 1, limit: 2 },
        context(),
      );
      expect(result.data.items.map((item) => item.procedure_id)).toEqual([
        '2025-0001',
        '2025-0001A',
      ]);
      expect(result.data.page).toMatchObject({
        offset: 1,
        limit: 2,
        returned: 2,
        has_more: true,
        next_offset: 3,
        snapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(result.enrichment).toMatchObject({
        totalCount: 4,
        appliedFilters: { process_type: 'CNS' },
      });
      expect(result.enrichment).not.toHaveProperty('notice');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).search).toBe(
        '?offset=0&limit=10000&process-type=CNS&format=application%2Fld%2Bjson',
      );
    });
    it('treats a response without meta.total that ends short of the window as the complete set', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          envelopeResponse(procedureRows(['2025-0002', '2025-0001'])),
        );
      const result = await makeService(fetcher).listProcedures({ process_type: 'COD' }, context());
      expect(result.data.items.map((item) => item.procedure_id)).toEqual([
        '2025-0001',
        '2025-0002',
      ]);
      expect(result.enrichment.totalCount).toBe(2);
      expect(result.data.page).toMatchObject({ returned: 2, has_more: false });
    });
    it('keeps transient retries on the whole-set read: a 503 repeats the same offset-0 request', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(
          Response.json({ data: procedureRows(['2025-0002', '2025-0001']), meta: { total: 2 } }),
        );
      const result = await makeService(fetcher).listProcedures({ process_type: 'RSP' }, context());
      expect(result.data.items.map((item) => item.procedure_id)).toEqual([
        '2025-0001',
        '2025-0002',
      ]);
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).search)).toEqual([
        '?offset=0&limit=10000&process-type=RSP&format=application%2Fld%2Bjson',
        '?offset=0&limit=10000&process-type=RSP&format=application%2Fld%2Bjson',
      ]);
    });
    const window = Array.from(
      { length: 10_000 },
      (_, index) => `${2000 + Math.floor(index / 1000)}-${String(index % 1000).padStart(4, '0')}`,
    );
    it.each([
      ['fewer rows than meta.total', procedureRows(['2025-0001', '2025-0002']), 3],
      [
        'a repeated procedure beside a set reaching meta.total',
        procedureRows(['2025-0001', '2025-0002', '2025-0001']),
        2,
      ],
      ['a capped meta.total at the 10000-result window', procedureRows(window), 10_000],
      ['a full window without meta.total', procedureRows(window), undefined],
    ])(
      'fails upstream_paging_stalled on %s without paging a partial set',
      async (_, data, total) => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation(async () =>
            Response.json({ data, ...(total !== undefined && { meta: { total } }) }),
          );
        await expect(
          makeService(fetcher).listProcedures({ process_type: 'COD' }, context()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_paging_stalled', retryable: false },
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );
  });
  type Call = (service: EuParliamentService) => Promise<unknown>;
  it.each<[string, Call, string]>([
    [
      'documents sitting_date',
      (s) => s.searchDocuments({ sitting_date: '2024-02-30' }, context()),
      'sitting_date "2024-02-30"',
    ],
    [
      'documents sitting_date_end',
      (s) =>
        s.searchDocuments(
          { sitting_date: '2024-02-01', sitting_date_end: '2023-02-29' },
          context(),
        ),
      'sitting_date_end "2023-02-29"',
    ],
    [
      'speeches sitting_date',
      (s) => s.searchSpeeches({ sitting_date: '2024-13-01' }, context()),
      'sitting_date "2024-13-01"',
    ],
    [
      'speeches sitting_date_end',
      (s) =>
        s.searchSpeeches({ sitting_date: '2024-02-01', sitting_date_end: '2024-2-3' }, context()),
      'sitting_date_end "2024-2-3"',
    ],
    [
      'votes sitting_id',
      (s) => s.getPlenaryVotes({ sitting_id: 'MTG-PL-2024-04-31' }, context()),
      'sitting_id "MTG-PL-2024-04-31"',
    ],
    [
      'meps mandate_date',
      (s) => s.searchMeps({ mandate_date: '2024-02-30' }, context()),
      'mandate_date "2024-02-30"',
    ],
  ])(
    'rejects a nonexistent or malformed %s with the date hint before HTTP',
    async (_, call, named) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(call(makeService(fetcher))).rejects.toMatchObject({
        message: `${named} is not a real calendar date in YYYY-MM-DD form.`,
        data: {
          reason: 'invalid_filter',
          recovery: { hint: 'Pass an existing calendar day as YYYY-MM-DD.' },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each<[string, Call, (url: URL) => string | null]>([
    [
      'documents',
      (s) =>
        s.searchDocuments(
          { sitting_date: '2024-02-01', sitting_date_end: '2024-02-29' },
          context(),
        ),
      (url) => url.searchParams.get('sitting-date-end'),
    ],
    [
      'speeches',
      (s) => s.searchSpeeches({ sitting_date: '2024-02-29' }, context()),
      (url) => url.searchParams.get('sitting-date'),
    ],
    [
      'votes',
      (s) => s.getPlenaryVotes({ sitting_id: '2024-02-29' }, context()),
      (url) => /MTG-PL-(\d{4}-\d{2}-\d{2})/.exec(url.pathname)?.[1] ?? null,
    ],
    [
      'meps',
      (s) => s.searchMeps({ mandate_date: '2024-02-29' }, context()),
      (url) => url.searchParams.get('mandate-date'),
    ],
  ])('accepts the leap day in %s and sends it upstream', async (_, call, sent) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    await call(makeService(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sent(new URL(String(fetcher.mock.calls[0]?.[0])))).toBe('2024-02-29');
  });
  it.each<[string, Call, string]>([
    [
      'documents',
      (s) => s.searchDocuments({ sitting_date_end: '2024-02-01' }, context()),
      'sitting_date_end "2024-02-01" needs a sitting_date on or before it, but sitting_date was not supplied.',
    ],
    [
      'speeches',
      (s) =>
        s.searchSpeeches({ sitting_date: '2024-02-29', sitting_date_end: '2024-02-28' }, context()),
      'sitting_date_end "2024-02-28" needs a sitting_date on or before it, but sitting_date is "2024-02-29".',
    ],
  ])(
    'rejects an incomplete or reversed sitting range in %s naming both dates, with the range hint before HTTP',
    async (_, call, message) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(call(makeService(fetcher))).rejects.toMatchObject({
        message,
        data: {
          reason: 'invalid_filter',
          recovery: { hint: 'Pass sitting_date with sitting_date_end, on or before it.' },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('logs the first clamp per collection once per process and counts every clamp', async () => {
    vi.resetModules();
    const { logger } = await import('@cyanheads/mcp-ts-core/utils');
    const { EuParliamentService: FreshService } = await import(
      '../../../src/services/eu-parliament/eu-parliament-service.js'
    );
    const info = vi.spyOn(logger, 'info');
    telemetry.add.mockClear();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const service = new FreshService({ fetch: fetcher, wait: async () => {} });
    await service.listProcedures({ limit: 5000 }, context());
    await service.listProcedures({ offset: 9950, limit: 200 }, context());
    await service.listQuestions({ limit: 1001 }, context());
    await service.listQuestions({ limit: 300 }, context());
    const clampLogs = info.mock.calls.filter(([message]) => message.startsWith('Limit clamped'));
    expect(clampLogs.map(([message]) => message)).toEqual([
      'Limit clamped on procedures: requested 5000, effective 1000; later clamps on this collection are counted, not logged.',
      'Limit clamped on questions: requested 1001, effective 1000; later clamps on this collection are counted, not logged.',
    ]);
    expect(telemetry.createCounter).toHaveBeenCalledWith(
      'euparl.limit.clamps',
      expect.any(String),
      '{calls}',
    );
    expect(telemetry.add.mock.calls).toEqual([
      [1, { 'euparl.collection': 'procedures', 'euparl.limit.bound': 'collection_cap' }],
      [1, { 'euparl.collection': 'procedures', 'euparl.limit.bound': 'search_window' }],
      [1, { 'euparl.collection': 'questions', 'euparl.limit.bound': 'collection_cap' }],
    ]);
    info.mockRestore();
  });
  it.each([10000, undefined])(
    'retains uncertainty at the speech window with total %s',
    async (total) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              data: Array.from({ length: 100 }, (_, i) => ({ id: `eli/dl/event/LAST-${i}` })),
              meta: { total },
            }),
          ),
      );
      const result = await makeService(fetcher).searchSpeeches(
        { offset: 9999, limit: 1 },
        context(),
      );
      expect(result.data).toMatchObject({ page: { has_more: true, returned: 1 } });
      expect('page' in result.data && result.data.page).not.toHaveProperty('next_offset');
      expect(result.enrichment).not.toHaveProperty('totalCount');
      expect(result.enrichment.notice).toContain('Narrow');
    },
  );
  it.each(['committee', 'plenary'] as const)(
    'preserves deep %s document paging',
    async (source) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
      const result = await makeService(fetcher).searchDocuments(
        { source, offset: 9990, limit: 20 },
        context(),
      );
      expect(result.data).toMatchObject({
        items: [],
        page: { offset: 9990, limit: 20, has_more: false },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves exact lower speech totals and their terminal page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: Array.from({ length: 58 }, (_, i) => ({ id: `eli/dl/event/LAST-${i}` })),
            meta: { total: 5558 },
          }),
        ),
    );
    const result = await makeService(fetcher).searchSpeeches({ offset: 5557, limit: 1 }, context());
    expect(result.enrichment.totalCount).toBe(5558);
    expect(result.data).toMatchObject({ page: { has_more: false } });
  });
  it.each([
    [1978, [0]],
    [1979, [0, 1]],
    [1980, [1]],
    [2019, [8, 9]],
    [2023, [9]],
    [2024, [9, 10]],
    [2025, [10]],
    [9999, [10]],
  ] as const)('checks the documented term candidates for citation year %i', async (year, terms) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: `P-000001/${year}` },
      context(),
    );
    expect(result.data).toEqual({ mode: 'get', found: false });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(
      terms.map((term) => `/api/v2/parliamentary-questions/P-${term}-${year}-000001`),
    );
  });

  it('propagates cancellation during the second term lookup after the first candidate matched', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (fetcher.mock.calls.length === 1)
        return envelopeResponse([questionRow('E-9-2024-900001')]);
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error('Cancellation must stop the lookup');
    });
    await expect(
      makeService(fetcher).listQuestions(
        { mode: 'get', question_id: 'E-900001/2024' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('resolves a human citation through the canonical term endpoint without a catalogue request', async () => {
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path.endsWith('/E-10-2025-900001')
        ? envelopeResponse([questionRecord])
        : envelopeResponse([]);
    });
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2025' },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      question: { question_id: 'E-10-2025-900001' },
    });
    expect(paths).toEqual(['/api/v2/parliamentary-questions/E-10-2025-900001']);
  });
  it('acquires the complete current roster before Unicode all-token filtering and local paging', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `person/${910000000 + index}`,
        identifier: String(910000000 + index),
        label: `Other Example ${index}`,
      })),
      ...rosterRecords,
    ];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(rows));
    const result = await makeService(fetcher).searchMeps(
      { name_contains: 'demo elodie', limit: 1 },
      context(),
    );
    expect(result.data.items).toEqual([
      { mep_id: '900000002', name: 'Élodie DEMO', given_name: 'Élodie', family_name: 'Demo' },
    ]);
    expect(result.enrichment).toMatchObject({
      totalCount: 1,
      appliedFilters: { scope: 'current', name_contains: 'demo elodie' },
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/meps/show-current');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('continues an incomplete term roster before returning a name match', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [rosterRecords[0]], meta: { total: 2, next: 1 } })),
      )
      .mockResolvedValueOnce(envelopeResponse([rosterRecords[1]]));
    const result = await makeService(fetcher).searchMeps(
      { term: 9, name_contains: 'elodie' },
      context(),
    );
    expect(result.data.items.map((item) => item.mep_id)).toEqual(['900000002']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('offset')).toBe('1');
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('limit')).toBe('50');
    expect(result.enrichment.appliedFilters).toMatchObject({
      scope: 'parliamentary_term',
      term: 9,
    });
  });

  it('fails incomplete repeated roster pages instead of returning partial name results', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: [rosterRecords[0]], meta: { total: 2 } })),
      );
    await expect(makeService(fetcher).searchMeps({}, context())).rejects.toMatchObject({
      data: { reason: 'upstream_paging_stalled' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts an empty terminal roster page after a full continuation page with no advertised total', async () => {
    const following = Array.from({ length: 50 }, (_, index) => ({
      id: `person/${910000000 + index}`,
      identifier: String(910000000 + index),
      label: `Example ${index}`,
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [rosterRecords[0]], meta: { next: 1 } })),
      )
      .mockResolvedValueOnce(envelopeResponse(following))
      .mockResolvedValueOnce(envelopeResponse([]));
    const result = await makeService(fetcher).searchMeps({ limit: 100 }, context());
    expect(result.data.items.map((item) => item.mep_id)).toEqual([
      '900000001',
      ...Array.from({ length: 50 }, (_, index) => String(910000000 + index)),
    ]);
    expect(result.enrichment.totalCount).toBe(51);
    expect(result.data.page).toMatchObject({ returned: 51, has_more: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('offset')),
    ).toEqual(['1', '51']);
  });

  it('rejects an empty terminal roster page when an earlier advertised total still demands more members', async () => {
    const following = Array.from({ length: 50 }, (_, index) => ({
      id: `person/${910000000 + index}`,
      identifier: String(910000000 + index),
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [rosterRecords[0]], meta: { next: 1, total: 52 } })),
      )
      .mockResolvedValueOnce(envelopeResponse(following))
      .mockResolvedValueOnce(envelopeResponse([]));
    await expect(makeService(fetcher).searchMeps({ limit: 100 }, context())).rejects.toMatchObject({
      data: { reason: 'upstream_paging_stalled' },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retains a roster total first advertised by a middle page when later pages omit metadata', async () => {
    const following = Array.from({ length: 50 }, (_, index) => ({
      id: `person/${910000000 + index}`,
      identifier: String(910000000 + index),
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [rosterRecords[0]], meta: { next: 1 } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: following, meta: { total: 100 } })),
      )
      .mockResolvedValueOnce(
        envelopeResponse([{ id: 'person/910000050', identifier: '910000050' }]),
      )
      .mockResolvedValueOnce(envelopeResponse([]));
    await expect(makeService(fetcher).searchMeps({ limit: 100 }, context())).rejects.toMatchObject({
      data: { reason: 'upstream_paging_stalled' },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('routes canonical document identifiers containing underscores to the exact detail endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const result = await makeService(fetcher).searchDocuments(
      { mode: 'get', document_id: 'EXAMPLE_1' },
      context(),
    );
    expect(result.data).toEqual({ mode: 'get', found: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://data.europarl.europa.eu/api/v2/documents/EXAMPLE_1?format=application%2Fld%2Bjson',
    );
  });
  it.each([
    ['E-9-2023-000003', 'def/ep-document-types/QUESTION_WRITTEN'],
    ['E-9-2023-000003-ASW', 'def/ep-document-types/QUESTION_WRITTEN_ANSWER'],
    ['LIBE-AM-702940', 'def/ep-document-types/AMENDMENT_LIST'],
    ['SP-2024-350-TA-9-2023-0236', 'def/ep-document-types/ACT_FOLLOWUP'],
    ['CRE-9-2024-03-12-ITM-012', undefined],
  ])('reads %s (work type %s) with the generic request alone', async (id, work_type) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      envelopeResponse([
        {
          id: `eli/dl/doc/${id}`,
          ...(work_type && { work_type }),
          refers_to: 'eli/dl/proc/2021-0106',
        },
      ]),
    );
    const result = await makeService(fetcher).searchDocuments(
      { mode: 'get', document_id: id },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      document: { document_id: id, procedure_ids: ['2021-0106'] },
    });
    expect(result.enrichment).not.toHaveProperty('notice');
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v2/documents/${id}`,
    ]);
  });
  describe('document get procedure relations from the family record', () => {
    const generic = (id: string, work_type: string, extra: Record<string, unknown> = {}) => ({
      id: `eli/dl/doc/${id}`,
      identifier: id,
      work_type: `def/ep-document-types/${work_type}`,
      ...extra,
    });
    /** Generic reads answer `record`; every other route answers through `family`. */
    const familyFetch = (
      record: Record<string, unknown>,
      family: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
    ) =>
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        return url.pathname.startsWith('/api/v2/documents/')
          ? envelopeResponse([record])
          : family(url, init);
      });
    const detail = ({ data }: Awaited<ReturnType<EuParliamentService['searchDocuments']>>) => {
      if (!('document' in data) || !data.document) throw new Error('Expected document detail');
      return data.document;
    };
    const degraded =
      'The procedure relation could not be read from the adopted_texts family record of this document, so procedure_ids may be incomplete; repeat the same get to retry.';

    it.each([
      [
        'TA-9-2024-0138',
        'TEXT_ADOPTED',
        'adopted-texts',
        ['eli/dl/event/MTG-PL-2024-03-13-PVCRE-ITM-8-2', 'eli/dl/proc/2021-0106'],
        ['2021-0106'],
      ],
      [
        'TA-10-2025-9001',
        'AMENDMENT_BUDGET_EU_DRAFT',
        'adopted-texts',
        'eli/dl/proc/2025-0001',
        ['2025-0001'],
      ],
      [
        'TA-10-2025-9002',
        'BUDGET_EP_DRAFT',
        'adopted-texts',
        'eli/dl/proc/2025-0002',
        ['2025-0002'],
      ],
      [
        'ENVI-PA-699056',
        'OPINION_PARLIAMENTARY_COMMITTEE_DRAFT',
        'committee-documents',
        ['eli/dl/proc/2021-0106'],
        ['2021-0106'],
      ],
      [
        'ENVI-AD-699056',
        'OPINION_PARLIAMENTARY_COMMITTEE',
        'committee-documents',
        [{ id: 'eli/dl/proc/2021-0106' }],
        ['2021-0106'],
      ],
      [
        'JURI-AL-732595',
        'OPINION_LETTER_PARLIAMENTARY_COMMITTEE',
        'committee-documents',
        ['eli/dl/proc/2020-0279'],
        ['2020-0279'],
      ],
      [
        'CJ40-PR-731563',
        'REPORT_PARLIAMENTARY_COMMITTEE_DRAFT',
        'committee-documents',
        ['eli/dl/proc/2021-0106'],
        ['2021-0106'],
      ],
      [
        'CJ40-AG-758862',
        'AGREEMENT_PROVISIONAL',
        'committee-documents',
        ['eli/dl/proc/2021-0106'],
        ['2021-0106'],
      ],
      [
        'A-9-2024-0164',
        'REPORT_PLENARY',
        'plenary-documents',
        ['eli/dl/proc/2016-0224B'],
        ['2016-0224B'],
      ],
      [
        'B-10-2024-0004',
        'RESOLUTION_MOTION',
        'plenary-documents',
        'eli/dl/proc/2024-2716',
        ['2024-2716'],
      ],
      [
        'RC-10-2024-0022',
        'RESOLUTION_MOTION_JOINT',
        'plenary-documents',
        ['https://data.europarl.europa.eu/eli/dl/proc/2024-2805'],
        ['2024-2805'],
      ],
      ['QOB-10-2024-0104', 'QUESTION_RESOLUTION_MOTION', 'plenary-documents', undefined, []],
    ])(
      'routes %s (%s) to its %s record and adds only its procedures',
      async (id, workType, endpoint, relation, procedures) => {
        const fetcher = familyFetch(generic(id, workType), () =>
          envelopeResponse([
            {
              id: `eli/dl/doc/${id}`,
              ...(relation !== undefined && { inverse_created_a_realization_of: relation }),
            },
          ]),
        );
        const result = await makeService(fetcher).searchDocuments(
          { mode: 'get', document_id: id },
          context(),
        );
        expect(result.data).toMatchObject({
          found: true,
          document: { document_id: id, procedure_ids: procedures },
        });
        expect(result.enrichment).not.toHaveProperty('notice');
        expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
          `https://data.europarl.europa.eu/api/v2/documents/${id}?format=application%2Fld%2Bjson`,
          `https://data.europarl.europa.eu/api/v2/${endpoint}/${id}?language=mul&format=application%2Fld%2Bjson`,
        ]);
      },
    );

    it('lists generic procedures first, then unseen family procedures in published order', async () => {
      const fetcher = familyFetch(
        generic('A-9-2023-0188', 'REPORT_PLENARY', {
          refers_to: 'eli/dl/proc/2020-0001',
          is_about: ['eli/dl/proc/2020-0002'],
        }),
        () =>
          envelopeResponse([
            {
              id: 'eli/dl/doc/A-9-2023-0188',
              inverse_created_a_realization_of: [
                'eli/dl/event/MTG-PL-2023-06-14-PVCRE-ITM-10-6',
                'eli/dl/proc/2020-0003',
                { id: 'eli/dl/proc/2020-0001' },
                'https://data.europarl.europa.eu/eli/dl/proc/2019-0005',
                'eli/dl/proc/2020-0003',
              ],
            },
          ]),
      );
      const result = await makeService(fetcher).searchDocuments(
        { mode: 'get', document_id: 'A-9-2023-0188' },
        context(),
      );
      expect(detail(result).procedure_ids).toEqual([
        '2020-0001',
        '2020-0002',
        '2020-0003',
        '2019-0005',
      ]);
    });

    it('reads the family record under the identifier the generic record publishes', async () => {
      const fetcher = familyFetch(generic('TA-9-2024-0138', 'TEXT_ADOPTED'), () =>
        envelopeResponse([{ id: 'eli/dl/doc/TA-9-2024-0138' }]),
      );
      await makeService(fetcher).searchDocuments(
        { mode: 'get', document_id: 'https://data.europarl.europa.eu/eli/dl/doc/ta-9-2024-0138' },
        context(),
      );
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/api/v2/documents/TA-9-2024-0138',
        '/api/v2/adopted-texts/TA-9-2024-0138',
      ]);
    });

    it('changes nothing but procedure_ids against a family record that is not published', async () => {
      const record = { ...documentRecord, refers_to: 'eli/dl/proc/2020-0001' };
      const read = async (family: () => Response) =>
        await makeService(familyFetch(record, family)).searchDocuments(
          { mode: 'get', document_id: documentRecord.id, language: 'pl' },
          context(),
        );
      const withRelation = await read(() =>
        envelopeResponse([
          { id: documentRecord.id, inverse_created_a_realization_of: 'eli/dl/proc/2021-0106' },
        ]),
      );
      const genericOnly = await read(() => new Response(null, { status: 404 }));
      const { procedure_ids: related, ...relatedFields } = detail(withRelation);
      const { procedure_ids: published, ...publishedFields } = detail(genericOnly);
      expect(related).toEqual(['2020-0001', '2021-0106']);
      expect(published).toEqual(['2020-0001']);
      expect(relatedFields).toEqual(publishedFields);
      expect({ ...withRelation.data, document: undefined }).toEqual({
        ...genericOnly.data,
        document: undefined,
      });
      expect(withRelation.enrichment).toEqual(genericOnly.enrichment);
      expect(withRelation.enrichment.notice).toContain('Requested language pl unavailable');
    });

    it.each([204, 404])(
      'keeps the generic procedures without a notice when the family read returns HTTP %i',
      async (status) => {
        const fetcher = familyFetch(
          generic('TA-9-2024-0138', 'TEXT_ADOPTED', { refers_to: 'eli/dl/proc/2020-0001' }),
          () => new Response(null, { status }),
        );
        const result = await makeService(fetcher).searchDocuments(
          { mode: 'get', document_id: 'TA-9-2024-0138' },
          context(),
        );
        expect(result.data).toMatchObject({
          found: true,
          document: { procedure_ids: ['2020-0001'] },
        });
        expect(result.enrichment).not.toHaveProperty('notice');
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );

    const failures: [string, () => Response][] = [
      ...[400, 401, 403, 408, 422, 429, 500, 502, 503, 504].map(
        (status): [string, () => Response] => [
          `HTTP ${status}`,
          () => new Response('upstream trace', { status }),
        ],
      ),
      ['a non-JSON body', () => new Response('<html>not json</html>')],
      ['an unexpected record shape', () => new Response('{"data":[{"id":42}]}')],
      ['no record', () => envelopeResponse([])],
      [
        'two records',
        () =>
          envelopeResponse([
            { id: 'eli/dl/doc/TA-9-2024-0138' },
            { id: 'eli/dl/doc/TA-9-2024-0138' },
          ]),
      ],
      [
        'a record of another document',
        () => envelopeResponse([{ id: 'eli/dl/doc/TA-9-2024-0139' }]),
      ],
      [
        'a malformed procedure entry',
        () =>
          envelopeResponse([
            {
              id: 'eli/dl/doc/TA-9-2024-0138',
              inverse_created_a_realization_of: [
                'eli/dl/proc/2021-0106',
                'eli/dl/proc/not-a-procedure',
              ],
            },
          ]),
      ],
      [
        'a network failure',
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    ];
    it.each(failures)(
      'answers from the generic record with a notice after one family attempt on %s',
      async (_label, family) => {
        const fetcher = familyFetch(
          generic('TA-9-2024-0138', 'TEXT_ADOPTED', { refers_to: 'eli/dl/proc/2020-0001' }),
          family,
        );
        const result = await makeService(fetcher).searchDocuments(
          { mode: 'get', document_id: 'TA-9-2024-0138' },
          context(),
        );
        expect(result.data).toMatchObject({
          mode: 'get',
          found: true,
          document: { document_id: 'TA-9-2024-0138', procedure_ids: ['2020-0001'] },
        });
        expect(result.enrichment.notice).toBe(degraded);
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      ['the shared deadline after an immediate generic response', 0, 700, 40_000],
      ['the shared 40-second deadline', 39_990, 39_990, 40_000],
    ] as const)(
      'cuts a stalled family read at %s in one attempt and answers from the generic record',
      async (_, genericAnsweredAt, familyStart, cutAt) => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        onTestFinished(() => {
          vi.useRealTimers();
        });
        const familyStarts: number[] = [];
        const familyAborts: number[] = [];
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          if (new URL(String(input)).pathname.startsWith('/api/v2/documents/')) {
            // Advance the operation timer along with the clock before the family request starts.
            if (genericAnsweredAt)
              await new Promise<void>((resolve) => setTimeout(resolve, genericAnsweredAt));
            return envelopeResponse([generic('TA-9-2024-0138', 'TEXT_ADOPTED')]);
          }
          familyStarts.push(Date.now());
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                familyAborts.push(Date.now());
                reject(init.signal?.reason);
              },
              { once: true },
            );
          });
        });
        const service = new EuParliamentService({
          fetch: fetcher,
          now: () => Date.now(),
          timeout: (ms) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
            return controller.signal;
          },
          wait: (ms, signal) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, ms);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        });
        let settledAt: number | undefined;
        const outcome = service
          .searchDocuments({ mode: 'get', document_id: 'TA-9-2024-0138' }, context())
          .finally(() => {
            settledAt = Date.now();
          });
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await outcome;
        expect(result.data).toMatchObject({ found: true, document: { procedure_ids: [] } });
        expect(result.enrichment.notice).toBe(degraded);
        expect(familyStarts).toEqual([familyStart]);
        expect(familyAborts).toEqual([cutAt]);
        expect(settledAt).toBe(cutAt);
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );

    it('answers from the generic record when the deadline passes during the family read', async () => {
      let now = 0;
      const fetcher = familyFetch(generic('TA-9-2024-0138', 'TEXT_ADOPTED'), () => {
        now = 40_000;
        return envelopeResponse([
          {
            id: 'eli/dl/doc/TA-9-2024-0138',
            inverse_created_a_realization_of: 'eli/dl/proc/2021-0106',
          },
        ]);
      });
      const result = await makeService(fetcher, () => now).searchDocuments(
        { mode: 'get', document_id: 'TA-9-2024-0138' },
        context(),
      );
      expect(result.data).toMatchObject({ found: true, document: { procedure_ids: [] } });
      expect(result.enrichment.notice).toBe(degraded);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('surfaces an unclassified family-read failure instead of degrading it', async () => {
      const fetcher = familyFetch(generic('TA-9-2024-0138', 'TEXT_ADOPTED'), () => {
        throw new RangeError('unclassified defect');
      });
      await expect(
        makeService(fetcher).searchDocuments(
          { mode: 'get', document_id: 'TA-9-2024-0138' },
          context(),
        ),
      ).rejects.toMatchObject({ name: 'RangeError', message: 'unclassified defect' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('propagates caller cancellation during the family read instead of degrading', async () => {
      const controller = new AbortController();
      const fetcher = familyFetch(generic('TA-9-2024-0138', 'TEXT_ADOPTED'), (_url, init) => {
        controller.abort(new DOMException('Caller stopped', 'AbortError'));
        init?.signal?.throwIfAborted();
        return envelopeResponse([{ id: 'eli/dl/doc/TA-9-2024-0138' }]);
      });
      await expect(
        makeService(fetcher).searchDocuments(
          { mode: 'get', document_id: 'TA-9-2024-0138' },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Caller stopped' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('detects a changed roster name across continuation before slicing', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse(rosterRecords))
      .mockResolvedValueOnce(
        envelopeResponse([rosterRecords[0], { ...rosterRecords[1], label: 'Changed name' }]),
      );
    const service = makeService(fetcher);
    const first = await service.searchMeps({ term: 10, limit: 1 }, context());
    await expect(
      service.searchMeps(
        { term: 10, offset: 1, limit: 1, snapshot: first.data.page.snapshot! },
        context(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'snapshot_changed' } });
  });

  it('returns an honest complete-roster no-match notice', async () => {
    const result = await makeService(
      vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(rosterRecords)),
    ).searchMeps({ name_contains: 'nobody exists' }, context());
    expect(result.data.items).toEqual([]);
    expect(result.enrichment.totalCount).toBe(0);
    expect(result.enrichment.notice).toContain('No MEPs matched');
  });

  describe('searchMeps name, country, and mandate-date selectors', () => {
    const maltaToday = [
      {
        id: 'person/113523',
        type: 'Person',
        identifier: '113523',
        label: 'Peter AGIUS',
        familyName: 'Agius',
        givenName: 'Peter',
        sortLabel: 'AGIUSP',
        'api:country-of-representation': 'MT',
        'api:political-group': 'PPE',
      },
      maltaOn20240313[0]!,
      maltaOn20240313[3]!,
      {
        id: 'person/256934',
        type: 'Person',
        identifier: '256934',
        label: 'Daniel ATTARD',
        familyName: 'Attard',
        givenName: 'Daniel',
        sortLabel: 'ATTARDD',
        'api:country-of-representation': 'MT',
        'api:political-group': 'S&D',
      },
      {
        id: 'person/256936',
        type: 'Person',
        identifier: '256936',
        label: 'Thomas BAJADA',
        familyName: 'Bajada',
        givenName: 'Thomas',
        sortLabel: 'BAJADAT',
        'api:country-of-representation': 'MT',
        'api:political-group': 'S&D',
      },
      maltaOn20240313[5]!,
    ];
    /** First two rows of meps/show-current?mandate-date=2016-03-09&country-of-representation=GB (73 rows). */
    const britainOn20160309 = [
      {
        id: 'person/102931',
        type: 'Person',
        identifier: '102931',
        label: 'Keith TAYLOR',
        familyName: 'Taylor',
        givenName: 'Keith',
        sortLabel: 'TAYLOR KEITH',
        'api:country-of-representation': 'GB',
        'api:political-group': 'Verts/ALE',
      },
      {
        id: 'person/106202',
        type: 'Person',
        identifier: '106202',
        label: 'Julia REID',
        familyName: 'Reid',
        givenName: 'Julia',
        sortLabel: 'REID J',
        'api:country-of-representation': 'GB',
        'api:political-group': 'EFDD',
      },
    ];
    /** The same two members from meps?parliamentary-term=8&country-of-representation=GB (83 rows); term rows publish no country or group. */
    const britainTerm8 = britainOn20160309.map(
      ({ 'api:country-of-representation': _country, 'api:political-group': _group, ...identity }) =>
        identity,
    );
    /** One current-roster row captured on 2026-11-01. */
    const aaltola = {
      id: 'person/256810',
      type: 'Person',
      identifier: '256810',
      label: 'Mika AALTOLA',
      familyName: 'Aaltola',
      givenName: 'Mika',
      sortLabel: 'AALTOLAM',
      'api:country-of-representation': 'FI',
      'api:political-group': 'PPE',
    };
    const now = () => Date.parse('2026-11-01T12:00:00Z');
    const urlOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) =>
      new URL(String(fetcher.mock.calls[call]?.[0]));
    const namesOf = (items: { name?: string }[]) => items.map((item) => item.name);
    const noMatch =
      'No MEPs matched. Remove name_contains to browse, relax country or political_group, or call euparl_list_reference with topic mep_filters.';
    const datedGroup =
      "On a mandate_date roster, political_group matches only the group code in force on that date; omit political_group and read each member's published political_group.";
    const currentGroup =
      "On the current roster, political_group matches only the group code in force today; pass mandate_date or term for an earlier group, or omit political_group and read each member's published political_group.";
    const termRule =
      'On a term roster, political_group matches each member of the term holding a membership in that code that had not ended when the term began, including memberships that began later, even after the term ended; it does not show who sat in the group during the term. Pass mandate_date instead of term for the members published under a code on one day.';
    const twoCodes =
      'GUE/NGL names two group codes: GUE-NGL (label GUE/NGL, 1995-01-06 to 2020-12-17) and THE-LEFT (The Left, from 2020-12-18, whose published name ends in GUE/NGL).';
    const leftDays =
      'from 2020-12-19 (the dated roster runs a day later than the published versions)';
    const gueDays =
      'from 1995-01-07 through 2020-12-18 (the dated roster runs a day later than the published versions)';
    /** Term 9 holds both codes, so its call routes the other code to the same roster. */
    const leftSent = `${twoCodes} This call sent THE-LEFT; to select the other group, pass political_group GUE-NGL.`;
    const gueOnTerm = `${twoCodes} This call sent GUE-NGL; to select the other group, pass political_group THE-LEFT with term 9, whose roster holds both codes, or with a mandate_date ${leftDays}.`;
    const leftOnTerm = `${twoCodes} This call sent THE-LEFT; to select the other group, pass political_group GUE-NGL with term 9, whose roster holds both codes, or with a mandate_date ${gueDays}.`;
    const gueOnDay = `${twoCodes} This call sent GUE-NGL. A mandate_date or current roster matches only the code in force that day, so THE-LEFT matches no member here; to select it, pass political_group THE-LEFT with a mandate_date ${leftDays} or with term 9.`;
    const leftOnDay = `${twoCodes} This call sent THE-LEFT. A mandate_date or current roster matches only the code in force that day, so GUE-NGL matches no member here; to select it, pass political_group GUE-NGL with a mandate_date ${gueDays} or with term 9.`;

    it.each([
      ['!!!', '"!!!"'],
      ['.,;:-/', '".,;:-/"'],
      ['🙂', '"🙂"'],
      ['́̈', '"́̈"'],
      [' ! ? ', '" ! ? "'],
    ])(
      'rejects name_contains %j without a letter or digit, quoting it, before HTTP',
      async (name_contains, quoted) => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(
          makeService(fetcher).searchMeps({ name_contains }, context()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `name_contains ${quoted} has no letter or digit after case, diacritic, and punctuation normalization.`,
          data: {
            reason: 'invalid_filter',
            recovery: {
              hint: 'Include at least one letter or digit in name_contains, or omit name_contains to browse the roster.',
            },
          },
        });
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each(['', '   ', '\t\n'])(
      'treats blank name_contains %j as unset',
      async (name_contains) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(rosterRecords));
        const result = await makeService(fetcher).searchMeps({ name_contains }, context());
        expect(result.enrichment.totalCount).toBe(2);
        expect(result.enrichment.appliedFilters).not.toHaveProperty('name_contains');
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );

    it('keeps punctuation inside a real name as a separator', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(envelopeResponse([aaltola, ...rosterRecords]));
      const result = await makeService(fetcher).searchMeps(
        { name_contains: 'Aaltola!' },
        context(),
      );
      expect(result.data.items.map((item) => item.mep_id)).toEqual(['256810']);
      expect(result.enrichment.appliedFilters).toMatchObject({ name_contains: 'aaltola' });
    });

    it.each(['GB', ' uk '])(
      'sends United Kingdom input %j as the published GB code on the term route',
      async (country) => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation(async (input) =>
            new URL(String(input)).searchParams.get('country-of-representation') === 'GB'
              ? envelopeResponse(britainTerm8)
              : new Response(null, { status: 204 }),
          );
        const result = await makeService(fetcher).searchMeps({ term: 8, country }, context());
        expect(urlOf(fetcher).pathname).toBe('/api/v2/meps');
        expect(urlOf(fetcher).searchParams.get('parliamentary-term')).toBe('8');
        expect(urlOf(fetcher).searchParams.get('country-of-representation')).toBe('GB');
        expect(result.enrichment.appliedFilters).toMatchObject({
          scope: 'parliamentary_term',
          term: 8,
          country: 'GB',
        });
        expect(namesOf(result.data.items)).toEqual(['Julia REID', 'Keith TAYLOR']);
      },
    );

    it('selects a dated roster on meps/show-current and keeps the current roster without mandate_date', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          envelopeResponse(
            new URL(String(input)).searchParams.get('mandate-date') === '2024-03-13'
              ? maltaOn20240313
              : maltaToday,
          ),
        );
      const service = makeService(fetcher, now);
      const dated = await service.searchMeps(
        { mandate_date: '2024-03-13', country: 'mt' },
        context(),
      );
      expect(namesOf(dated.data.items)).toEqual([
        'Alex AGIUS SALIBA',
        'David CASA',
        'Josianne CUTAJAR',
        'Cyrus ENGERER',
        'Roberta METSOLA',
        'Alfred SANT',
      ]);
      expect(dated.data.items[0]).toEqual({
        mep_id: '197403',
        name: 'Alex AGIUS SALIBA',
        given_name: 'Alex',
        family_name: 'Agius Saliba',
        country: 'MT',
        political_group: 'S&D',
      });
      expect(dated.enrichment).toMatchObject({
        totalCount: 6,
        appliedFilters: {
          scope: 'mandate_date',
          mandate_date: '2024-03-13',
          language: 'en',
          country: 'MT',
        },
      });
      expect(dated.enrichment.appliedFilters).not.toHaveProperty('as_of');
      expect(urlOf(fetcher).pathname).toBe('/api/v2/meps/show-current');
      expect(urlOf(fetcher).searchParams.get('mandate-date')).toBe('2024-03-13');
      expect(urlOf(fetcher).searchParams.get('country-of-representation')).toBe('MT');
      expect(urlOf(fetcher).searchParams.has('parliamentary-term')).toBe(false);
      expect(urlOf(fetcher).searchParams.has('limit')).toBe(false);
      const current = await service.searchMeps({ country: 'MT' }, context());
      expect(namesOf(current.data.items)).toEqual([
        'Peter AGIUS',
        'Alex AGIUS SALIBA',
        'Daniel ATTARD',
        'Thomas BAJADA',
        'David CASA',
        'Roberta METSOLA',
      ]);
      expect(current.enrichment.appliedFilters).toEqual({
        scope: 'current',
        as_of: '2026-11-01',
        language: 'en',
        country: 'MT',
      });
      expect(urlOf(fetcher, 1).searchParams.has('mandate-date')).toBe(false);
    });

    it('sends UK input on the dated route as GB and keeps the date-published country and group', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          new URL(String(input)).searchParams.get('country-of-representation') === 'GB'
            ? envelopeResponse(britainOn20160309)
            : new Response(null, { status: 204 }),
        );
      const result = await makeService(fetcher, now).searchMeps(
        { mandate_date: '2016-03-09', country: 'UK' },
        context(),
      );
      expect(urlOf(fetcher).searchParams.get('mandate-date')).toBe('2016-03-09');
      expect(urlOf(fetcher).searchParams.get('country-of-representation')).toBe('GB');
      expect(result.data.items).toEqual([
        {
          mep_id: '106202',
          name: 'Julia REID',
          given_name: 'Julia',
          family_name: 'Reid',
          country: 'GB',
          political_group: 'EFDD',
        },
        {
          mep_id: '102931',
          name: 'Keith TAYLOR',
          given_name: 'Keith',
          family_name: 'Taylor',
          country: 'GB',
          political_group: 'Verts/ALE',
        },
      ]);
      expect(result.enrichment.appliedFilters).toMatchObject({
        scope: 'mandate_date',
        mandate_date: '2016-03-09',
        country: 'GB',
      });
    });

    it('acquires every continuation page of a dated roster before name matching', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: maltaOn20240313.slice(0, 1), meta: { total: 6, next: 1 } }),
          ),
        )
        .mockResolvedValueOnce(envelopeResponse(maltaOn20240313.slice(1)));
      const result = await makeService(fetcher, now).searchMeps(
        { mandate_date: '2024-03-13', name_contains: 'Sant' },
        context(),
      );
      expect(namesOf(result.data.items)).toEqual(['Alfred SANT']);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(urlOf(fetcher, 1).pathname).toBe('/api/v2/meps/show-current');
      expect(urlOf(fetcher, 1).searchParams.get('mandate-date')).toBe('2024-03-13');
      expect(urlOf(fetcher, 1).searchParams.get('offset')).toBe('1');
      expect(urlOf(fetcher, 1).searchParams.get('limit')).toBe('50');
    });

    it.each([
      [{ term: 9, mandate_date: '2024-03-13' }, 'invalid_mode_fields'],
      [{ term: 0, mandate_date: '2024-03-13' }, 'invalid_mode_fields'],
      [{ mandate_date: '2024-02-30' }, 'invalid_filter'],
      [{ mandate_date: '2024-3-13' }, 'invalid_filter'],
      [{ mandate_date: '2026-11-02' }, 'invalid_filter'],
    ] as const)('rejects %j with %s before HTTP', async (input, reason) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(makeService(fetcher, now).searchMeps(input, context())).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason },
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects a mandate_date after the client UTC date with a date hint and accepts that date', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(maltaToday));
      const service = makeService(fetcher, () => Date.parse('2026-11-01T23:59:59Z'));
      await expect(
        service.searchMeps({ mandate_date: '2026-11-02' }, context()),
      ).rejects.toMatchObject({
        message: 'mandate_date "2026-11-02" is after the current UTC date 2026-11-01.',
        data: {
          reason: 'invalid_filter',
          recovery: {
            hint: 'Use a mandate_date on or before 2026-11-01, or omit mandate_date for members in office today.',
          },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
      const today = await service.searchMeps({ mandate_date: '2026-11-01' }, context());
      expect(today.enrichment.appliedFilters).toMatchObject({
        scope: 'mandate_date',
        mandate_date: '2026-11-01',
      });
      expect(urlOf(fetcher).searchParams.get('mandate-date')).toBe('2026-11-01');
    });

    it.each([
      [{ mandate_date: '' }, 'current'],
      [{ mandate_date: '  ', term: 9 }, 'parliamentary_term'],
    ] as const)('treats blank mandate_date in %j as unset', async (input, scope) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(maltaToday));
      const result = await makeService(fetcher, now).searchMeps(input, context());
      expect(result.enrichment.appliedFilters).toMatchObject({ scope });
      expect(result.enrichment.appliedFilters).not.toHaveProperty('mandate_date');
      expect(urlOf(fetcher).searchParams.has('mandate-date')).toBe(false);
    });

    it('binds the snapshot to the mandate date and roster scope', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => envelopeResponse(maltaOn20240313));
      const service = makeService(fetcher, now);
      const first = await service.searchMeps({ mandate_date: '2024-03-13', limit: 1 }, context());
      const snapshot = first.data.page.snapshot!;
      const next = await service.searchMeps(
        { mandate_date: '2024-03-13', limit: 1, offset: 1, snapshot },
        context(),
      );
      expect(namesOf(next.data.items)).toEqual(['David CASA']);
      for (const scope of [{ mandate_date: '2016-03-09' }, {}, { term: 10 }])
        await expect(
          service.searchMeps({ ...scope, limit: 1, offset: 1, snapshot }, context()),
        ).rejects.toMatchObject({ data: { reason: 'snapshot_changed' } });
    });

    it.each([
      [
        { mandate_date: '2016-03-09', political_group: 'GUE/NGL' },
        `${noMatch} ${datedGroup} ${gueOnDay}`,
        'GUE-NGL',
      ],
      [{ political_group: 'GUE/NGL' }, `${noMatch} ${currentGroup} ${leftOnDay}`, 'THE-LEFT'],
      [{ political_group: 'GUE-NGL' }, `${noMatch} ${currentGroup}`, 'GUE-NGL'],
      [{ mandate_date: '2016-03-09', name_contains: 'nobody' }, noMatch, null],
    ] as const)(
      'explains in-force group codes only for an empty current or dated group search %j',
      async (input, notice, sent) => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 }));
        const result = await makeService(fetcher, now).searchMeps(input, context());
        expect(result.data.items).toEqual([]);
        expect(result.enrichment.notice).toBe(notice);
        expect(urlOf(fetcher).searchParams.get('political-group')).toBe(sent);
      },
    );

    it.each([
      [{ term: 8 }, 'GUE-NGL', gueOnTerm],
      [{ term: 0 }, 'GUE-NGL', gueOnTerm],
      [{ mandate_date: '2016-03-09' }, 'GUE-NGL', gueOnDay],
      [{ mandate_date: '2020-12-17' }, 'GUE-NGL', gueOnDay],
      [{ mandate_date: '2020-12-18' }, 'GUE-NGL', gueOnDay],
      [{}, 'THE-LEFT', leftOnDay],
      [{ term: 9 }, 'THE-LEFT', leftSent],
      [{ term: 10 }, 'THE-LEFT', leftOnTerm],
      [{ mandate_date: '2020-12-19' }, 'THE-LEFT', leftOnDay],
      [{ mandate_date: '2021-01-18' }, 'THE-LEFT', leftOnDay],
    ] as const)(
      'sends GUE/NGL on roster %j as %s and names both codes on a matching page',
      async (roster, sent, twoCodeNotice) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([aaltola]));
        const result = await makeService(fetcher, now).searchMeps(
          { ...roster, political_group: ' gue/ngl ' },
          context(),
        );
        expect(urlOf(fetcher).searchParams.get('political-group')).toBe(sent);
        expect(result.enrichment.appliedFilters).toMatchObject({ political_group: sent });
        expect(result.data.items.map((item) => item.mep_id)).toEqual(['256810']);
        expect(result.enrichment.notice).toBe(
          'term' in roster ? `${termRule} ${twoCodeNotice}` : twoCodeNotice,
        );
      },
    );

    it.each([
      [{ term: 8, political_group: 'alde' }, 'ALDE', termRule],
      [{ term: 6, political_group: 'PPE-DE' }, 'PPE-DE', termRule],
      [{ term: 10, political_group: 'EPP' }, 'PPE', termRule],
      [{ mandate_date: '2016-03-09', political_group: 'ENF' }, 'ENF', undefined],
      [{ political_group: 'S&D' }, 'S-D', undefined],
      [{ term: 8 }, null, undefined],
    ] as const)(
      'states the term matching rule only on a term call with political_group %j',
      async (input, sent, notice) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([aaltola]));
        const result = await makeService(fetcher, now).searchMeps(input, context());
        expect(urlOf(fetcher).searchParams.get('political-group')).toBe(sent);
        expect(result.enrichment.notice).toBe(notice);
      },
    );

    it('rejects an unknown political_group with its value, every code and the listing call before HTTP', async () => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        makeService(fetcher, now).searchMeps({ political_group: 'PATRIOTS-X', term: 8 }, context()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(
          'Unsupported political_group filter "PATRIOTS-X". Accepted codes: ALDE, ARC,',
        ),
        data: {
          reason: 'invalid_filter',
          recovery: {
            hint: 'Call euparl_list_reference with topic mep_filters for each group code with its label and periods, then retry with one of them.',
          },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('omits the date-bound group explanation when the dated group roster matched but no name did', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse(maltaOn20240313));
      const result = await makeService(fetcher, now).searchMeps(
        { mandate_date: '2024-03-13', political_group: 'S&D', name_contains: 'nobody' },
        context(),
      );
      expect(result.data.items).toEqual([]);
      expect(result.enrichment.notice).toBe(noMatch);
      expect(urlOf(fetcher).searchParams.get('political-group')).toBe('S-D');
    });

    it('surfaces an upstream 500 on a dated roster as an operational error, never an empty roster', async () => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              path: '/api/v2/meps-show-current',
              status: 500,
              error: 'Internal Server Error',
            }),
            { status: 500 },
          ),
      );
      await expect(
        makeService(fetcher, now).searchMeps({ mandate_date: '2024-07-16' }, context()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 500, retryable: true },
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(urlOf(fetcher).searchParams.get('mandate-date')).toBe('2024-07-16');
    });

    describe('mep_ids', () => {
      /** Rows of meps/show-current?mandate-date=2016-03-09 (750 rows), captured 2026-11-13. */
      const seatedOn20160309 = [
        {
          id: 'person/1849',
          type: 'Person',
          identifier: '1849',
          label: 'Sylvia-Yvonne KAUFMANN',
          familyName: 'Kaufmann',
          givenName: 'Sylvia-Yvonne',
          sortLabel: 'KAUFMANN',
          'api:country-of-representation': 'DE',
          'api:political-group': 'S&D',
        },
        {
          id: 'person/124884',
          type: 'Person',
          identifier: '124884',
          label: 'Kosma ZŁOTOWSKI',
          familyName: 'Złotowski',
          givenName: 'Kosma',
          sortLabel: 'ZLOTOWSKI',
          'api:country-of-representation': 'PL',
          'api:political-group': 'ECR',
        },
        {
          id: 'person/124867',
          type: 'Person',
          identifier: '124867',
          label: 'Brando BENIFEI',
          familyName: 'Benifei',
          givenName: 'Brando',
          sortLabel: 'BENIFEI',
          'api:country-of-representation': 'IT',
          'api:political-group': 'S&D',
        },
      ];
      /** Rows of meps?parliamentary-term=9 (875 rows), captured 2026-11-13: no country or group. */
      const term9 = [
        {
          id: 'person/124867',
          type: 'Person',
          identifier: '124867',
          label: 'Brando BENIFEI',
          familyName: 'Benifei',
          givenName: 'Brando',
          sortLabel: 'BENIFEI',
        },
        {
          id: 'person/197665',
          type: 'Person',
          identifier: '197665',
          label: 'Dragoş TUDORACHE',
          familyName: 'Tudorache',
          givenName: 'Dragoş',
          sortLabel: 'TUDORACHE',
        },
        {
          id: 'person/124884',
          type: 'Person',
          identifier: '124884',
          label: 'Kosma ZŁOTOWSKI',
          familyName: 'Złotowski',
          givenName: 'Kosma',
          sortLabel: 'ZLOTOWSKI',
        },
      ];
      const requested = ['124867', 'person/1849', 'https://data.europarl.europa.eu/person/197665'];
      const roster = (input: URL) =>
        envelopeResponse(input.searchParams.has('mandate-date') ? seatedOn20160309 : term9);
      const serviceOver = () => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation(async (input) => roster(new URL(String(input))));
        return { fetcher, service: makeService(fetcher, now) };
      };

      it('keeps the output, filters and snapshot of a call without mep_ids', async () => {
        const { service } = serviceOver();
        const result = await service.searchMeps({ term: 9, limit: 1 }, context());
        expect(result.data).toEqual({
          items: [
            {
              mep_id: '124867',
              name: 'Brando BENIFEI',
              given_name: 'Brando',
              family_name: 'Benifei',
            },
          ],
          page: {
            offset: 0,
            limit: 1,
            returned: 1,
            has_more: true,
            next_offset: 1,
            // Computed by the release before mep_ids existed.
            snapshot: '87480584a1d8e1b309888ab546cfa55b4fd1ecf00adc78a2066f8f1e99e89fa0',
          },
        });
        expect(result.enrichment).toEqual({
          appliedFilters: { scope: 'parliamentary_term', term: 9, language: 'en' },
          totalCount: 3,
        });
      });

      it('names requested IDs from one dated roster read, with date-published country and group', async () => {
        const { fetcher, service } = serviceOver();
        const result = await service.searchMeps(
          { mandate_date: '2016-03-09', mep_ids: requested },
          context(),
        );
        expect(result.data.items).toEqual([
          {
            mep_id: '124867',
            name: 'Brando BENIFEI',
            given_name: 'Brando',
            family_name: 'Benifei',
            country: 'IT',
            political_group: 'S&D',
          },
          {
            mep_id: '1849',
            name: 'Sylvia-Yvonne KAUFMANN',
            given_name: 'Sylvia-Yvonne',
            family_name: 'Kaufmann',
            country: 'DE',
            political_group: 'S&D',
          },
        ]);
        expect(result.data.unmatched_mep_ids).toEqual(['197665']);
        expect(result.enrichment).toMatchObject({
          totalCount: 2,
          appliedFilters: {
            scope: 'mandate_date',
            mandate_date: '2016-03-09',
            mep_ids: ['124867', '1849', '197665'],
          },
          notice:
            "1 requested mep_id matched no row of the selected roster after the other filters; unmatched_mep_ids lists it. A term roster holds only that term's members and a mandate_date roster only members seated that day; euparl_get_mep reads any member by ID.",
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect([...urlOf(fetcher).searchParams.keys()]).toEqual(['mandate-date', 'format']);
      });

      it('names requested IDs from a term roster without country or group', async () => {
        const { fetcher, service } = serviceOver();
        const result = await service.searchMeps({ term: 9, mep_ids: requested }, context());
        expect(result.data.items).toEqual([
          {
            mep_id: '124867',
            name: 'Brando BENIFEI',
            given_name: 'Brando',
            family_name: 'Benifei',
          },
          {
            mep_id: '197665',
            name: 'Dragoş TUDORACHE',
            given_name: 'Dragoş',
            family_name: 'Tudorache',
          },
        ]);
        expect(result.data.unmatched_mep_ids).toEqual(['1849']);
        expect(fetcher).toHaveBeenCalledTimes(1);
      });

      it('deduplicates canonical forms and keeps first-seen order in the echo', async () => {
        const { service } = serviceOver();
        const result = await service.searchMeps(
          { term: 9, mep_ids: ['person/197665', '124867', ' person/124867 ', '197665'] },
          context(),
        );
        expect(result.data.items.map((item) => item.mep_id)).toEqual(['124867', '197665']);
        expect(result.data.unmatched_mep_ids).toEqual([]);
        expect(result.enrichment.appliedFilters.mep_ids).toEqual(['197665', '124867']);
        expect(result.enrichment).not.toHaveProperty('notice');
      });

      it.each([
        'org/AFCO',
        '12a',
        '',
        'https://evil.example/person/1',
        'person/1?x=y',
        // The public origin without the person/ segment: a form euparl_get_mep rejects too.
        'https://data.europarl.europa.eu/124867',
      ])('rejects mep_ids entry %j before HTTP', async (entry) => {
        const { fetcher, service } = serviceOver();
        await expect(
          service.searchMeps({ term: 9, mep_ids: ['124867', entry] }, context()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `mep_ids entry "${entry}" is not a person identifier. Accepted forms: a decimal person ID (124867), person/124867, or https://data.europarl.europa.eu/person/124867.`,
          data: {
            reason: 'invalid_filter',
            recovery: {
              hint: 'Retry euparl_search_meps with only person IDs in mep_ids; resolve org/ identifiers with euparl_list_reference topic organizations and organization_ids instead.',
            },
          },
        });
        expect(fetcher).not.toHaveBeenCalled();
      });

      it('treats an empty mep_ids list as omitted, snapshot included', async () => {
        const { service } = serviceOver();
        const omitted = await service.searchMeps({ term: 9, limit: 1 }, context());
        const empty = await service.searchMeps({ term: 9, limit: 1, mep_ids: [] }, context());
        expect(empty).toEqual(omitted);
        expect(empty.data).not.toHaveProperty('unmatched_mep_ids');
      });

      it('repeats unmatched_mep_ids on every page and binds the snapshot to the ID list', async () => {
        const { service } = serviceOver();
        const ids = ['124884', '1849', '124867', '197665', '999999'];
        const first = await service.searchMeps({ term: 9, limit: 1, mep_ids: ids }, context());
        const snapshot = first.data.page.snapshot!;
        const pages = [first];
        for (const offset of [1, 2, 3])
          pages.push(
            await service.searchMeps(
              { term: 9, limit: 1, offset, mep_ids: ids, snapshot },
              context(),
            ),
          );
        expect(pages.map((page) => page.data.items.map((item) => item.mep_id))).toEqual([
          ['124867'],
          ['197665'],
          ['124884'],
          [],
        ]);
        for (const page of pages) expect(page.data.unmatched_mep_ids).toEqual(['1849', '999999']);
        expect(pages[3]?.enrichment.notice).toContain(
          'The offset 3 is at or beyond the complete collection of 3 items.',
        );
        await expect(
          service.searchMeps(
            { term: 9, limit: 1, offset: 1, mep_ids: ['124884', '124867'], snapshot },
            context(),
          ),
        ).rejects.toMatchObject({ data: { reason: 'snapshot_changed' } });
      });

      it('narrows with name_contains and country and lists the IDs they exclude', async () => {
        const { fetcher, service } = serviceOver();
        const named = await service.searchMeps(
          { mandate_date: '2016-03-09', name_contains: 'benifei', mep_ids: requested },
          context(),
        );
        expect(named.data.items.map((item) => item.mep_id)).toEqual(['124867']);
        expect(named.data.unmatched_mep_ids).toEqual(['1849', '197665']);
        fetcher.mockImplementation(async () => envelopeResponse([seatedOn20160309[0]!]));
        const country = await service.searchMeps(
          { mandate_date: '2016-03-09', country: 'de', mep_ids: requested },
          context(),
        );
        expect(urlOf(fetcher, 1).searchParams.get('country-of-representation')).toBe('DE');
        expect(country.data.items.map((item) => item.mep_id)).toEqual(['1849']);
        expect(country.data.unmatched_mep_ids).toEqual(['124867', '197665']);
      });
    });
  });

  it('normalizes membership history without requiring contact or birth fields', async () => {
    const result = await makeService(
      vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([mepRecord])),
    ).getMep({ mep_id: 'person/900000001', section: 'memberships' }, context());
    expect(result.data).toMatchObject({
      found: true,
      memberships: [
        { id: 'membership/900000001-m-1', organization_id: 'org/ep-10', start_date: '2024-07-16' },
      ],
    });
    expect(result.data).not.toHaveProperty('email');
    expect(result.data).not.toHaveProperty('birthday');
  });

  it.each([204, 404])(
    'handles missing sitting HTTP %i as empty decision data with discovery guidance',
    async (status) => {
      const result = await makeService(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
      ).getPlenaryVotes({ sitting_id: '2025-01-15' }, context());
      expect(result.data).toMatchObject({
        mode: 'decisions',
        sitting_id: 'MTG-PL-2025-01-15',
        decisions: [],
        page: { returned: 0 },
      });
      expect(result.enrichment.notice).toContain('mode sittings');
    },
  );

  it.each([
    ['favor', ['900000001', '900000002']],
    ['against', ['900000003']],
    ['abstention', []],
    ['intended_favor', ['900000004']],
    ['intended_against', ['900000005']],
    ['intended_abstention', ['900000006']],
  ] as const)(
    'retrieves the complete sitting then pages %s independently',
    async (position, expectedIds) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => envelopeResponse([decisionRecord]));
      const result = await makeService(fetcher).getPlenaryVotes(
        {
          mode: 'voters',
          sitting_id: '2025-01-15',
          decision_id: decisionRecord.activity_id,
          position,
        },
        context(),
      );
      expect(result.data).toMatchObject({ voters: expectedIds.map((mep_id) => ({ mep_id })) });
      expect(result.enrichment.available).toBe(true);
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/api/v2/meetings/MTG-PL-2025-01-15/decisions');
      expect([...url.searchParams.keys()]).toEqual(['format']);
    },
  );

  it('distinguishes unavailable voter arrays from published empty arrays', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        envelopeResponse([{ id: decisionRecord.id, activity_id: decisionRecord.activity_id }]),
      );
    const result = await makeService(fetcher).getPlenaryVotes(
      {
        mode: 'voters',
        sitting_id: '2025-01-15',
        decision_id: decisionRecord.activity_id,
        position: 'favor',
      },
      context(),
    );
    expect(result.enrichment.available).toBe(false);
    expect(result.enrichment).not.toHaveProperty('totalCount');
    expect(result.data).toMatchObject({ voters: [] });
  });

  it('joins only the explicitly requested term roster and preserves unresolved voter identities', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse([decisionRecord]))
      .mockResolvedValueOnce(envelopeResponse([rosterRecords[0]]));
    const result = await makeService(fetcher).getPlenaryVotes(
      {
        mode: 'voters',
        sitting_id: '2025-01-15',
        decision_id: decisionRecord.activity_id,
        position: 'favor',
        resolve_names: true,
        roster_term: 9,
      },
      context(),
    );
    expect(result.data).toMatchObject({
      voters: [{ mep_id: '900000001', name: 'Alex EXAMPLE' }, { mep_id: '900000002' }],
      voter_resolution: {
        scope: 'parliamentary_term',
        term: 9,
        resolved: 1,
        unresolved: 1,
        sitting_date: '2025-01-15',
      },
    });
    const url = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(url.pathname).toBe('/api/v2/meps');
    expect(url.searchParams.get('parliamentary-term')).toBe('9');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(result.enrichment.notice).toContain('euparl_get_mep');
  });

  it('echoes a decision dated only by the typed literal as the voter resolution sitting date', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        envelopeResponse([
          {
            ...decisionRecord,
            activity_date: undefined,
            'eli-dl:activity_date': { '@value': '2025-01-15T00:00:00+01:00', type: 'xsd:dateTime' },
          },
        ]),
      )
      .mockResolvedValueOnce(envelopeResponse(rosterRecords));
    const result = await makeService(fetcher).getPlenaryVotes(
      {
        mode: 'voters',
        sitting_id: '2025-01-15',
        decision_id: decisionRecord.activity_id,
        position: 'favor',
        resolve_names: true,
        roster_term: 10,
      },
      context(),
    );
    expect(result.data).toMatchObject({
      voter_resolution: { term: 10, sitting_date: '2025-01-15', resolved: 2, unresolved: 0 },
    });
  });

  it('shares the sitting acquisition deadline with roster name resolution', async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        now = 39_900;
        return envelopeResponse([decisionRecord]);
      })
      .mockImplementationOnce(async () => {
        now = 40_001;
        return envelopeResponse(rosterRecords);
      });
    await expect(
      makeService(fetcher, () => now).getPlenaryVotes(
        {
          mode: 'voters',
          sitting_id: '2025-01-15',
          decision_id: decisionRecord.activity_id,
          position: 'favor',
          resolve_names: true,
          roster_term: 9,
        },
        context(),
      ),
    ).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('checks both election-year candidates before returning the matching canonical question', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-10-2024-900001')]));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2024' },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      question: { question_id: 'E-10-2024-900001' },
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v2/parliamentary-questions/E-9-2024-900001',
      '/api/v2/parliamentary-questions/E-10-2024-900001',
    ]);
  });

  it('rejects election-year ambiguity only after checking every candidate', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-9-2024-900001')]))
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-10-2024-900001')]));
    await expect(
      makeService(fetcher).listQuestions({ mode: 'get', question_id: 'E-900001/2024' }, context()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not turn a timed-out second candidate into found false or the first hit', async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        now = 39_900;
        return envelopeResponse([questionRow('E-9-2024-900001')]);
      })
      .mockImplementationOnce(async () => {
        now = 40_001;
        return envelopeResponse([]);
      });
    await expect(
      makeService(fetcher, () => now).listQuestions(
        { mode: 'get', question_id: 'E-900001/2024' },
        context(),
      ),
    ).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not turn a rejected second candidate into a first-candidate hit', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-9-2024-900001')]))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      makeService(fetcher).listQuestions({ mode: 'get', question_id: 'E-900001/2024' }, context()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_rejected' } });
  });

  it('checks a second candidate even after an exact first-candidate match', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-8-2019-900001')]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2019' },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      question: { question_id: 'E-8-2019-900001' },
    });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).pathname).toBe(
      '/api/v2/parliamentary-questions/E-9-2019-900001',
    );
  });

  it('bypasses question scanning with explicit term and validates returned identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([questionRecord]));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2025', term: 10 },
      context(),
    );
    expect(result.data).toMatchObject({ found: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
      '/api/v2/parliamentary-questions/E-10-2025-900001',
    );
  });

  it('rejects contradictory source-family filters before HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      makeService(fetcher).searchDocuments(
        { source: 'committee', text: 'ignored by API' },
        context(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
