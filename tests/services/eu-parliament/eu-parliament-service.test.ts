/** @fileoverview Complete acquisition workflows tested through injected HTTP responses. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, vi } from 'vitest';
import { EuParliamentService } from '../../../src/services/eu-parliament/eu-parliament-service.js';
import {
  decisionRecord,
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
          ...decisionRecord,
          activity_id: `DEC-${index}`,
          decided_on_a_realization_of: 'eli/dl/doc/A-1-AM-1',
        })),
      ),
    );
    const result = await makeService(fetcher).getPlenaryVotes(
      { sitting_id: '2025-01-15', document_id: 'eli/dl/doc/A-1', limit: 1000 },
      context(),
    );
    expect(result.data).toMatchObject({ page: { returned: 100, limit: 100, next_offset: 100 } });
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
  it('guards the effective capped limit rather than the requested limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const result = await makeService(fetcher).searchSpeeches(
      { offset: 9900, limit: 1000 },
      context(),
    );
    expect(result.data).toMatchObject({ page: { limit: 80 } });
    expect(result.enrichment.notice).toContain(
      'Requested limit normalized to the effective maximum of 80 speeches.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('80');
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
      expect(url.searchParams.get('offset')).toBe(String(offset));
      expect(url.searchParams.get('limit')).toBe(String(effective));
    },
  );
  type Call = (service: EuParliamentService) => Promise<unknown>;
  it.each<[string, Call]>([
    ['documents sitting_date', (s) => s.searchDocuments({ sitting_date: '2024-02-30' }, context())],
    [
      'documents sitting_date_end',
      (s) =>
        s.searchDocuments(
          { sitting_date: '2024-02-01', sitting_date_end: '2023-02-29' },
          context(),
        ),
    ],
    ['speeches sitting_date', (s) => s.searchSpeeches({ sitting_date: '2024-13-01' }, context())],
    [
      'speeches sitting_date_end',
      (s) =>
        s.searchSpeeches({ sitting_date: '2024-02-01', sitting_date_end: '2024-2-3' }, context()),
    ],
    ['votes sitting_id', (s) => s.getPlenaryVotes({ sitting_id: 'MTG-PL-2024-04-31' }, context())],
    ['meps mandate_date', (s) => s.searchMeps({ mandate_date: '2024-02-30' }, context())],
  ])('rejects a nonexistent or malformed %s with the date hint before HTTP', async (_, call) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(call(makeService(fetcher))).rejects.toMatchObject({
      message: 'Use a real calendar date in YYYY-MM-DD form.',
      data: {
        reason: 'invalid_filter',
        recovery: { hint: 'Pass an existing calendar day as YYYY-MM-DD.' },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
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
  it.each<[string, Call]>([
    ['documents', (s) => s.searchDocuments({ sitting_date_end: '2024-02-01' }, context())],
    [
      'speeches',
      (s) =>
        s.searchSpeeches({ sitting_date: '2024-02-29', sitting_date_end: '2024-02-28' }, context()),
    ],
  ])(
    'rejects an incomplete or reversed sitting range in %s with the range hint before HTTP',
    async (_, call) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(call(makeService(fetcher))).rejects.toMatchObject({
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
    await service.listQuestions({ limit: 301 }, context());
    await service.listQuestions({ limit: 300 }, context());
    const clampLogs = info.mock.calls.filter(([message]) => message.startsWith('Limit clamped'));
    expect(clampLogs.map(([message]) => message)).toEqual([
      'Limit clamped on procedures: requested 5000, effective 300; later clamps on this collection are counted, not logged.',
      'Limit clamped on questions: requested 301, effective 300; later clamps on this collection are counted, not logged.',
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
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'eli/dl/event/LAST' }], meta: { total } })),
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
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'eli/dl/event/LAST' }], meta: { total: 5558 } }),
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

    it.each(['!!!', '.,;:-/', '🙂', '́̈', ' ! ? '])(
      'rejects name_contains %j without a letter or digit before HTTP',
      async (name_contains) => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(
          makeService(fetcher).searchMeps({ name_contains }, context()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message:
            'name_contains has no letter or digit after case, diacritic, and punctuation normalization.',
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
        message: 'mandate_date 2026-11-02 is after the current UTC date 2026-11-01.',
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
      [{ mandate_date: '2016-03-09', political_group: 'GUE/NGL' }, `${noMatch} ${datedGroup}`],
      [{ political_group: 'GUE/NGL' }, noMatch],
      [{ mandate_date: '2016-03-09', name_contains: 'nobody' }, noMatch],
    ] as const)(
      'explains date-bound group codes only for an empty dated group search %j',
      async (input, notice) => {
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 }));
        const result = await makeService(fetcher, now).searchMeps(input, context());
        expect(result.data.items).toEqual([]);
        expect(result.enrichment.notice).toBe(notice);
        if ('political_group' in input)
          expect(urlOf(fetcher).searchParams.get('political-group')).toBe('THE-LEFT');
      },
    );

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
