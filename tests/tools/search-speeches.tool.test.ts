/** @fileoverview Speech metadata contracts and followable source-document chains. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchDocumentsTool } from '../../src/mcp-server/tools/definitions/search-documents.tool.js';
import { searchSpeechesTool } from '../../src/mcp-server/tools/definitions/search-speeches.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { documentRecord, envelopeResponse } from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
const label = 'Published `label` **text** https://example.org\nnext line';
const speech = {
  id: 'eli/dl/event/SPEECH-1',
  activity_date: '2025-01-15',
  activity_start_date: '2025-01-15T10:00:00Z',
  activity_end_date: '2025-01-15T10:05:00Z',
  activity_label: { fr: label },
  had_activity_type: 'def/ep-activities/PLENARY_DEBATE_SPEECH',
  had_participation: [
    {
      id: 'participation/1',
      had_participant_person: [{ id: 'person/1' }, 'person/2'],
      participation_role: 'SPEAKER',
    },
    { id: 'participation/2' },
  ],
  recorded_in_a_realization_of: { id: 'eli/dl/doc/SUBDIVISION-1' },
};

describe('euparl_search_speeches contract', () => {
  it.each([8, 11])('rejects unsupported speech term %i at the schema boundary', async (term) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract<Parameters<typeof runToolContract>[0]>(
      searchSpeechesTool,
      { term },
    );
    expect(result.isError).toBe(true);
    expect(contractText(result)).toContain('term');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves operational failure and bounded retries for ninth-term search', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 500 }));
    const result = await runToolContract(searchSpeechesTool, { term: 9, person_id: '1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { retryable: true } } });
    expect(contractText(result)).not.toMatch(/unsupported|unavailable coverage/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('renders an empty ninth-term date result with scope intact', async () => {
    installToolHttp(() => new Response(null, { status: 204 }));
    expect(
      expectSuccessTwin(
        await runToolContract(searchSpeechesTool, { term: 9, sitting_date: '2025-01-01' }),
      ),
    ).toMatchObject({
      items: [],
      appliedFilters: { term: 9, sitting_date: '2025-01-01' },
      page: { returned: 0, has_more: false },
    });
  });
  it('keeps the defaulted term, one request and the broadening guidance on an empty date search', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 204 }));
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { sitting_date: '2024-03-12', limit: 3 }),
    );
    expect(data).toMatchObject({
      items: [],
      appliedFilters: { term: 10, sitting_date: '2024-03-12' },
      page: { returned: 0, has_more: false },
    });
    expect(data.notice).toMatch(
      /broaden sitting_date or remove person_id; call euparl_list_reference with topic activity_types\./i,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('parliamentary-term')).toBe(
      '10',
    );
  });
  const dated = 'pass the term containing sitting_date';
  it.each([
    [{ sitting_date: '2024-03-12', limit: 3 }, 'term 10 (the default)', 10, dated],
    [{ term: 9, sitting_date: '2025-12-16', limit: 1 }, 'term 9', 9, dated],
    [{ term: 9, sitting_date: '2020-01-15' }, 'term 9', 9, dated],
    [{ term: 10, sitting_date: '2024-03-12' }, 'term 10', 10, dated],
    [{ text: 'fisheries' }, 'term 10 (the default)', 10, 'pass term to search the other term'],
  ] as const)(
    'names the searched term, both term calendars and the coverage row when %j matches nothing',
    async (input, named, term, lever) => {
      const fetcher = installToolHttp(() => new Response(null, { status: 204 }));
      const data = expectSuccessTwin(await runToolContract(searchSpeechesTool, input));
      expect(data).toMatchObject({ items: [], appliedFilters: { term } });
      expect(data.notice).toBe(
        `No speech records matched in ${named}. Term 9 ran 2019-07-02 to 2024-07-15 and term 10 began 2024-07-16; ${lever}. Speech records do not cover every date of a term; euparl_list_reference topic coverage gives the dates they cover. Otherwise broaden sitting_date or remove person_id; call euparl_list_reference with topic activity_types.`,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('reports an empty page past offset 0 without claiming nothing matched or advising a term', async () => {
    installToolHttp(() => new Response(null, { status: 204 }));
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        term: 9,
        sitting_date: '2024-03-12',
        offset: 500,
      }),
    );
    expect(data).toMatchObject({ items: [], page: { offset: 500, returned: 0, has_more: false } });
    expect(data.notice).toBe(
      'The page at offset 500 returned no speeches. Restart at offset 0 or return to the previous page.',
    );
  });
  it('routes ninth-term text, date and person search while preserving source references on both surfaces', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([{ ...speech, id: 'eli/dl/event/CRE-9-2024-03-12-S1' }]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        term: 9,
        text: 'artificial intelligence',
        person_id: '1',
        language: 'fr',
        sitting_date: '2024-03-12',
        sitting_date_end: '2024-03-12',
      }),
    );
    expect(data).toMatchObject({
      appliedFilters: { term: 9, text: 'artificial intelligence', person_id: '1', language: 'fr' },
      items: [
        {
          speech_id: 'CRE-9-2024-03-12-S1',
          participants: [{ person_ids: ['1', '2'] }, { person_ids: [] }],
          document_ids: ['SUBDIVISION-1'],
        },
      ],
    });
    expect(
      Object.fromEntries(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams),
    ).toMatchObject({
      'parliamentary-term': '9',
      text: 'artificial intelligence',
      'person-id': '1',
      'sitting-date': '2024-03-12',
      'sitting-date-end': '2024-03-12',
      'search-language': 'fr',
    });
  });
  it('keeps ninth-term detail free of an injected search term', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([{ id: 'eli/dl/event/CRE-9-2024-S1' }]));
    expect(
      expectSuccessTwin(
        await runToolContract(searchSpeechesTool, { mode: 'get', speech_id: 'CRE-9-2024-S1' }),
      ),
    ).toMatchObject({ found: true, speech: { speech_id: 'CRE-9-2024-S1' } });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.has('parliamentary-term')).toBe(
      false,
    );
  });
  it('renders window uncertainty without inaccessible continuation or an exact capped total', async () => {
    installToolHttp(() => new Response(JSON.stringify({ data: [speech], meta: { total: 10000 } })));
    const result = await runToolContract(searchSpeechesTool, { offset: 9999, limit: 1 });
    const data = expectSuccessTwin(result);
    expect(data).toMatchObject({ page: { has_more: true, returned: 1 }, truncated: true });
    expect(data.page).not.toHaveProperty('next_offset');
    expect(data).not.toHaveProperty('totalCount');
    expect(data.notice).toContain('Narrow');
    expect(contractText(result)).not.toMatch(/Continue with offset|undefined/);
  });
  it('narrows a window-crossing page and returns past-window recovery before HTTP', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const narrowed = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { offset: 9990, limit: 20 }),
    );
    expect(narrowed).toMatchObject({ page: { offset: 9990, limit: 10 } });
    expect(narrowed.notice).toContain(
      'Requested limit normalized to 10: offset plus limit cannot pass the 10000-result search window.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('10');
    const result = await runToolContract(searchSpeechesTool, { offset: 10000, limit: 20 });
    expectErrorTwin(
      result,
      'invalid_filter',
      'Narrow text, title, person_id, activity_type or sitting dates. Restart paging at offset 0 after narrowing.',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('maps every search filter and preserves all participant and activity metadata', async () => {
    const fetcher = installToolHttp(
      () => new Response(JSON.stringify({ data: [speech], meta: { total: 2, next: null } })),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        text: 'climate',
        title: 'budget',
        person_id: 'https://data.europarl.europa.eu/person/1',
        activity_type: 'plenary_debate_speech',
        sitting_date: '2025-01-01',
        sitting_date_end: '2025-01-31',
        language: ' FR ',
        limit: 1,
      }),
    );
    expect(data).toMatchObject({
      items: [
        {
          speech_id: 'SPEECH-1',
          title: { language: 'fr', value: label },
          date: '2025-01-15',
          start_time: '2025-01-15T10:00:00Z',
          end_time: '2025-01-15T10:05:00Z',
          participants: [{ person_ids: ['1', '2'], role: 'SPEAKER' }, { person_ids: [] }],
          document_ids: ['SUBDIVISION-1'],
        },
      ],
      totalCount: 2,
      truncated: true,
      appliedFilters: {
        term: 10,
        language: 'fr',
        person_id: '1',
        activity_type: 'PLENARY_DEBATE_SPEECH',
      },
    });
    expect(
      Object.fromEntries(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams),
    ).toMatchObject({
      text: 'climate',
      title: 'budget',
      'person-id': '1',
      'activity-type': 'PLENARY_DEBATE_SPEECH',
      'parliamentary-term': '10',
      'sitting-date': '2025-01-01',
      'sitting-date-end': '2025-01-31',
      'search-language': 'fr',
    });
  });

  it('follows a speech through its fileless subdivision to parent document files', async () => {
    const fetcher = installToolHttp((url) => {
      if (url.pathname.endsWith('/speeches/SPEECH-1')) return envelopeResponse([speech]);
      if (url.pathname.endsWith('/documents/SUBDIVISION-1'))
        return envelopeResponse([
          { id: 'eli/dl/doc/SUBDIVISION-1', is_part_of: 'eli/dl/doc/AFCO-AD-900001' },
        ]);
      if (url.pathname.endsWith('/documents/AFCO-AD-900001'))
        return envelopeResponse([documentRecord]);
      if (url.pathname.endsWith('/committee-documents/AFCO-AD-900001'))
        return new Response(null, { status: 404 });
      throw new Error(`Unexpected route ${url.pathname}`);
    });
    const first = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        mode: 'get',
        speech_id: 'https://data.europarl.europa.eu/eli/dl/event/SPEECH-1',
      }),
    );
    expect(first).toMatchObject({
      found: true,
      speech: { document_ids: ['SUBDIVISION-1'], title: { language: 'fr', value: label } },
    });
    const child = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { mode: 'get', document_id: 'SUBDIVISION-1' }),
    );
    expect(child).toMatchObject({
      document: { links: [], parent_document_ids: ['AFCO-AD-900001'] },
    });
    const parent = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { mode: 'get', document_id: 'AFCO-AD-900001' }),
    );
    expect(parent).toMatchObject({
      document: {
        links: [
          {
            url: 'https://data.europarl.europa.eu/distribution/example/opinion_en.pdf',
            language: 'en',
          },
        ],
      },
    });
    expect(parent).not.toHaveProperty('notice');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('accepts singleton participation and preserves sparse metadata without a transcript', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'eli/dl/event/S1',
          had_participation: { id: 'p/1', had_participant_person: 'person/42' },
        },
        { id: 'eli/dl/event/S2' },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        text: '',
        title: ' ',
        person_id: '',
        activity_type: '',
        sitting_date: '',
        sitting_date_end: '',
        language: '',
      }),
    );
    expect(data).toMatchObject({
      items: [
        { speech_id: 'S1', participants: [{ person_ids: ['42'] }], document_ids: [] },
        { speech_id: 'S2', participants: [], document_ids: [] },
      ],
      appliedFilters: { term: 10, language: 'en' },
    });
    expect(data.items).toEqual([
      {
        speech_id: 'S1',
        participants: [{ person_ids: ['42'] }],
        document_ids: [],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/S1',
      },
      {
        speech_id: 'S2',
        participants: [],
        document_ids: [],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/S2',
      },
    ]);
  });

  it('preserves cap notice through continuation and renders the terminal page', async () => {
    // One row more than the cap, sliced by the requested window as the upstream does.
    const pool = [
      ...Array.from({ length: 80 }, (_, i) => ({ id: `eli/dl/event/S-${i}` })),
      { id: 'eli/dl/event/LAST' },
    ];
    const fetcher = installToolHttp((url) => {
      const offset = Number(url.searchParams.get('offset'));
      return envelopeResponse(pool.slice(offset, offset + Number(url.searchParams.get('limit'))));
    });
    const first = expectSuccessTwin(await runToolContract(searchSpeechesTool, { limit: 101 }));
    expect(first).toMatchObject({
      truncated: true,
      shown: 80,
      cap: 80,
      page: { next_offset: 80, limit: 80 },
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 80 speeches. Continue with offset 80.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('80');
    expect(
      expectSuccessTwin(await runToolContract(searchSpeechesTool, { offset: 80 })),
    ).toMatchObject({ items: [{ speech_id: 'LAST' }], page: { returned: 1, has_more: false } });
    installToolHttp(() => envelopeResponse([]));
    expect(
      expectSuccessTwin(await runToolContract(searchSpeechesTool, { offset: 500 })),
    ).toMatchObject({ items: [], page: { returned: 0, offset: 500, has_more: false } });
  });

  it.each([204, 404])('renders HTTP %i detail miss with discovery guidance', async (status) => {
    installToolHttp(() => new Response(null, { status }));
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { mode: 'get', speech_id: 'MISSING' }),
    );
    expect(data).toMatchObject({ found: false });
    expect(data.notice).toContain('euparl_search_speeches');
    expect(data).not.toHaveProperty('speech');
  });

  it.each([{ person_id: 'person/not-numeric' }, { activity_type: 'UNKNOWN' }, { language: 'xx' }])(
    'rejects filter %j before network',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(searchSpeechesTool, input),
        'invalid_filter',
        invalidHint,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ sitting_date: '2025-02-30' }, 'Pass an existing calendar day as YYYY-MM-DD.'],
    [
      { sitting_date_end: '2025-01-01' },
      'Pass sitting_date with sitting_date_end, on or before it.',
    ],
    [
      { sitting_date: '2025-01-31', sitting_date_end: '2025-01-01' },
      'Pass sitting_date with sitting_date_end, on or before it.',
    ],
  ])('rejects sitting dates %j with their own recovery before network', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(searchSpeechesTool, input), 'invalid_filter', hint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'get' },
    { mode: 'get', speech_id: 'S', text: 'x' },
    { mode: 'get', speech_id: 'S', person_id: '1' },
    { mode: 'get', speech_id: 'S', term: 9 },
    { mode: 'get', speech_id: 'S', offset: 1 },
    { mode: 'get', speech_id: 'S', limit: 1 },
    { speech_id: 'S' },
  ] as const)('rejects mode fields %j before network', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchSpeechesTool, input),
      'invalid_mode_fields',
      modeHint,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])('renders HTTP %i recovery', async (status) => {
    const fetcher = installToolHttp(() => new Response(null, { status }));
    const result = await runToolContract(searchSpeechesTool, {});
    expectErrorTwin(
      result,
      status === 429 ? 'upstream_rate_limited' : 'upstream_rejected',
      status === 429
        ? 'Wait for the reported retry interval, then repeat the same euparl tool call.'
        : 'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.',
    );
    expect(fetcher).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
    if (status === 403) {
      expect(result.structuredContent).toMatchObject({ error: { data: { retryable: false } } });
      expect(contractText(result)).not.toMatch(/retry later/i);
    }
  });

  it('rejects unsupported snapshot input before acquisition', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { mode: 'search' as const, snapshot: 'abc' };
    expectErrorTwin(
      await runToolContract(searchSpeechesTool, input),
      'invalid_arguments',
      'Unknown key snapshot. This tool accepts: mode, speech_id, term, text, title, person_id, activity_type, sitting_date, sitting_date_end, offset, limit, language.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
