/** @fileoverview Complete acquisition workflows tested through injected HTTP responses. */
import { describe, expect, it, vi } from 'vitest';
import { EuParliamentService } from '../../../src/services/eu-parliament/eu-parliament-service.js';
import {
  decisionRecord,
  envelopeResponse,
  mepRecord,
  questionRecord,
  rosterRecords,
} from '../../helpers/eu-parliament-fixtures.js';

const context = () => ({ signal: new AbortController().signal });
const makeService = (fetcher: typeof fetch, now?: () => number) =>
  new EuParliamentService({ fetch: fetcher, wait: async () => {}, ...(now && { now }) });
const questionRow = (id: string) => ({ id: `eli/dl/doc/${id}`, identifier: id });
const questionPage = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    questionRow(`E-10-2025-${String(start + index).padStart(6, '0')}`),
  );

describe('Parliament domain workflows', () => {
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

  it('exhausts a full question page before resolving the matching canonical question', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelopeResponse(questionPage(1, 50)))
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-10-2025-900001')]))
      .mockResolvedValueOnce(envelopeResponse([questionRecord]));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2025' },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      question: { question_id: 'E-10-2025-900001' },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('offset')).toBe('50');
    expect(new URL(String(fetcher.mock.calls[2]?.[0])).pathname).toBe(
      '/api/v2/parliamentary-questions/E-10-2025-900001',
    );
  });

  it('rejects election-year ambiguity only after scanning every page', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        envelopeResponse([questionRow('E-9-2025-900001'), ...questionPage(1, 49)]),
      )
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-10-2025-900001')]));
    await expect(
      makeService(fetcher).listQuestions({ mode: 'get', question_id: 'E-900001/2025' }, context()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not turn a timed-out question traversal into found false', async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        now = 39_900;
        return envelopeResponse(questionPage(1, 50));
      })
      .mockImplementationOnce(async () => {
        now = 40_001;
        return envelopeResponse([]);
      });
    await expect(
      makeService(fetcher, () => now).listQuestions(
        { mode: 'get', question_id: 'E-900001/2025' },
        context(),
      ),
    ).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains an advertised question total when later pages omit metadata', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: questionPage(1, 50), meta: { total: 100 } })),
      )
      .mockResolvedValueOnce(envelopeResponse(questionPage(51, 1)))
      .mockResolvedValueOnce(envelopeResponse([]));
    await expect(
      makeService(fetcher).listQuestions({ mode: 'get', question_id: 'E-900001/2025' }, context()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_paging_stalled' } });
  });

  it('follows explicit question continuation even when the page is short', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: questionPage(1, 1), meta: { next: 50 } })),
      )
      .mockResolvedValueOnce(envelopeResponse([questionRow('E-10-2025-900001')]))
      .mockResolvedValueOnce(envelopeResponse([questionRecord]));
    const result = await makeService(fetcher).listQuestions(
      { mode: 'get', question_id: 'E-900001/2025' },
      context(),
    );
    expect(result.data).toMatchObject({
      found: true,
      question: { question_id: 'E-10-2025-900001' },
    });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('offset')).toBe('50');
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
