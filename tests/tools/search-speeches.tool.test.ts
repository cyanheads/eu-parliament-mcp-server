/** @fileoverview Speech metadata and text contracts and followable source-document chains. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { searchDocumentsTool } from '../../src/mcp-server/tools/definitions/search-documents.tool.js';
import { searchSpeechesTool } from '../../src/mcp-server/tools/definitions/search-speeches.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import {
  documentRecord,
  envelopeResponse,
  speechFragments,
} from '../helpers/eu-parliament-fixtures.js';

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
      expect(data.notice).toContain(
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
    // A 204 past the first page carries no total and says nothing about the rows before it.
    expect(data).not.toHaveProperty('totalCount');
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
    installToolHttp(
      () =>
        new Response(
          JSON.stringify({
            data: Array.from({ length: 100 }, (_, i) => ({ ...speech, id: `eli/dl/event/S-${i}` })),
            meta: { total: 10000 },
          }),
        ),
    );
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
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
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
        original_languages: [],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/S1',
      },
      {
        speech_id: 'S2',
        participants: [],
        document_ids: [],
        original_languages: [],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/S2',
      },
    ]);
  });

  it('preserves requested page size through continuation and renders the terminal page', async () => {
    // One row more than the cap, sliced by the requested window as the upstream does.
    const pool = [
      ...Array.from({ length: 80 }, (_, i) => ({ id: `eli/dl/event/S-${i}` })),
      { id: 'eli/dl/event/LAST' },
    ];
    const fetcher = installToolHttp((url) => {
      const offset = Number(url.searchParams.get('offset'));
      return envelopeResponse(pool.slice(offset, offset + Number(url.searchParams.get('limit'))));
    });
    const first = expectSuccessTwin(await runToolContract(searchSpeechesTool, { limit: 80 }));
    expect(first).toMatchObject({
      truncated: true,
      shown: 80,
      cap: 80,
      page: { next_offset: 80, limit: 80 },
    });
    expect(first.notice).toBe('Continue with offset 80.');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
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

  it.each([
    [
      { person_id: 'abc' },
      'person_id "abc" is not a person identifier. Accepted forms: a decimal person ID (124867), person/124867, or https://data.europarl.europa.eu/person/124867.',
      "Call euparl_search_meps with name_contains for the member's mep_id, then retry with it as person_id.",
    ],
    [
      { person_id: 'person/not-numeric' },
      'person_id "person/not-numeric" is not a person identifier.',
      "Call euparl_search_meps with name_contains for the member's mep_id, then retry with it as person_id.",
    ],
    [
      { activity_type: 'UNKNOWN' },
      'Unsupported activity_type filter "UNKNOWN". Accepted codes: MEETING_NAME_CHAIR,',
      'Call euparl_list_reference with topic activity_types for every accepted code, then retry activity_type with one of them.',
    ],
    [
      { language: 'xx' },
      'Unsupported language filter "xx". Accepted codes: bg,',
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
  ] as const)('rejects filter %j before network', async (input, message, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const failure = await runToolContract(searchSpeechesTool, input);
    expectErrorTwin(failure, 'invalid_filter', hint);
    expect(contractText(failure)).toContain(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a malformed speech_id in get mode naming the parameter before network', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const failure = await runToolContract(searchSpeechesTool, {
      mode: 'get',
      speech_id: 'speech 1',
    });
    expectErrorTwin(
      failure,
      'invalid_filter',
      'Call euparl_search_speeches in search mode for speech_id values, then retry mode get with one.',
    );
    expect(contractText(failure)).toContain(
      'speech_id "speech 1" is not an activity identifier. Accepted forms: a canonical identifier of letters, digits, hyphens and underscores, bare, after eli/dl/event/, or in the exact https://data.europarl.europa.eu/eli/dl/event/ URI.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

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
    [{ mode: 'get' }, 'Supply speech_id for the selected mode.'],
    [
      { mode: 'get', speech_id: 'S', text: 'x' },
      'Remove text, or select a mode that accepts text.',
    ],
    [
      { mode: 'get', speech_id: 'S', person_id: '1' },
      'Remove person_id, or select a mode that accepts person_id.',
    ],
    [{ mode: 'get', speech_id: 'S', term: 9 }, 'Remove term, or select a mode that accepts term.'],
    [
      { mode: 'get', speech_id: 'S', offset: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [
      { mode: 'get', speech_id: 'S', limit: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [{ speech_id: 'S' }, 'Remove speech_id, or select a mode that accepts speech_id.'],
  ] as const)('rejects mode fields %j before network', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(searchSpeechesTool, input), 'invalid_mode_fields', hint);
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

  it('sends the same search and detail requests when text is not requested', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([speech]));
    await runToolContract(searchSpeechesTool, { offset: 150, limit: 20 });
    await runToolContract(searchSpeechesTool, { text: 'budget', limit: 500, language: 'de' });
    await runToolContract(searchSpeechesTool, { mode: 'get', speech_id: 'SPEECH-1' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://data.europarl.europa.eu/api/v2/speeches?offset=100&limit=100&search-language=en&parliamentary-term=10&sort-by=sitting-date%3Aasc%2Cnumbering%3Aasc&format=application%2Fld%2Bjson',
      'https://data.europarl.europa.eu/api/v2/speeches?offset=0&limit=500&text=budget&search-language=de&parliamentary-term=10&format=application%2Fld%2Bjson',
      'https://data.europarl.europa.eu/api/v2/speeches/SPEECH-1?format=application%2Fld%2Bjson',
    ]);
  });

  it.each([
    { sitting_date: '2024-03-12' },
    { sitting_date: '2024-03-12', include_text: false },
    { mode: 'get', speech_id: 'SPEECH-1' },
    { mode: 'get', speech_id: 'SPEECH-1', include_text: false },
  ] as const)(
    'echoes no include_text in appliedFilters when text is not requested: %j',
    async (input) => {
      installToolHttp(() => envelopeResponse([speech]));
      const data = expectSuccessTwin(await runToolContract(searchSpeechesTool, input));
      expect(data.appliedFilters).not.toHaveProperty('include_text');
      expect(contractText(await runToolContract(searchSpeechesTool, input))).not.toContain(
        'include_text',
      );
    },
  );

  it('rejects unsupported snapshot input before acquisition', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { mode: 'search' as const, snapshot: 'abc' };
    expectErrorTwin(
      await runToolContract(searchSpeechesTool, input),
      'invalid_arguments',
      'Unknown key snapshot. This tool accepts: mode, speech_id, term, text, title, person_id, activity_type, sitting_date, sitting_date_end, include_text, offset, limit, language.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const authority = 'http://publications.europa.eu/resource/authority/language/';
const { benifei: benifeiText, chair: chairText, irish: irishText } = speechFragments;
const benifeiParagraphs = [
  "Mr President, Commissioner Breton, ladies and gentlemen, after two intense years of work, we have finally come to pass the world's first binding law on artificial intelligence.",
  'Enough of the indiscriminate use of deep fake that will be made recognizable through the so-called "watermarking", an invisible labeling.',
];
const reintkeText =
  '<oralStatements><speech endTime="2026-04-28T09:48:17.542" startTime="2026-04-28T09:46:02.166" xml:lang="en"><from xml:lang="en" xml:space="preserve"><person refersTo="epdata:person/103381">Terry Reintke</person>, <role refersTo="">on behalf of the <organization refersTo="epdata:org/7028">Verts/ALE</organization> Group</role>.</from><!--en - 0--><blockContainer xml:lang="en"><p xml:space="preserve"><recordedTime time="2026-04-28T09:46:02.216+02:00" type="startEvent"/>Mr President, dear disciples, Member States come up over and over again with new tasks for Europe.<recordedTime time="2026-04-28T09:46:26.626+02:00" type="endEvent"/></p></blockContainer><!--de - 1--><blockContainer xml:lang="de-t-en-mtec"><p xml:space="preserve"><recordedTime time="2026-04-28T09:47:17.85+02:00" type="startEvent"/>A completely confused CDU course that serves the interests of Donald Trump.<recordedTime time="2026-04-28T09:47:59.01+02:00" type="endEvent"/></p></blockContainer></speech></oralStatements>';
/** A speech activity as `/speeches` publishes it, its recording document carrying `fragments`. */
const spoken = (
  id: string,
  {
    label,
    languages,
    fragments,
    type = 'PLENARY_DEBATE_SPEECH',
    document = `CRE-${id.slice(4)}`,
  }: {
    label?: Record<string, string>;
    languages?: string[];
    fragments?: Record<string, string>;
    type?: string;
    document?: string;
  },
) => ({
  id: `eli/dl/event/${id}`,
  activity_id: id,
  activity_date: id.slice(7, 17),
  ...(label && { activity_label: label }),
  had_activity_type: `def/ep-activities/${type}`,
  recorded_in_a_realization_of: [
    {
      id: `eli/dl/doc/${document}`,
      type: 'WorkSubdivision',
      identifier: document,
      ...(languages && { originalLanguage: languages.map((code) => `${authority}${code}`) }),
      ...(fragments && { 'api:xmlFragment': fragments }),
    },
  ],
});
const benifei = {
  ...spoken('MTG-PL-2024-03-12-OTH-22050000', {
    label: { en: 'Artificial Intelligence Act (debate)' },
    languages: ['ITA'],
    fragments: { en: benifeiText },
    document: 'CRE-9-2024-03-12-OTH-22050000',
  }),
  had_participation: {
    id: 'eli/dl/participation/MTG-PL-2024-03-12-OTH-22050000_124867',
    had_participant_person: ['person/124867'],
    participation_role: 'def/ep-roles/SPEAKER',
  },
};
const queryOf = (fetcher: ReturnType<typeof installToolHttp>, call = 0) =>
  Object.fromEntries(new URL(String(fetcher.mock.calls[call]?.[0])).searchParams);

describe('euparl_search_speeches include_text', () => {
  it('reads one speech with its text, speaker, language tags and original languages in one request', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([benifei]));
    const result = await runToolContract(searchSpeechesTool, {
      mode: 'get',
      speech_id: 'MTG-PL-2024-03-12-OTH-22050000',
      include_text: true,
      language: 'en',
    });
    const data = expectSuccessTwin(result);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://data.europarl.europa.eu/api/v2/speeches/MTG-PL-2024-03-12-OTH-22050000?include-output=xml_fragment&language=en&format=application%2Fld%2Bjson',
    ]);
    expect(data).toMatchObject({
      found: true,
      appliedFilters: {
        mode: 'get',
        speech_id: 'MTG-PL-2024-03-12-OTH-22050000',
        language: 'en',
        include_text: true,
      },
      speech: {
        speech_id: 'MTG-PL-2024-03-12-OTH-22050000',
        title: { value: 'Artificial Intelligence Act (debate)', language: 'en' },
        participants: [{ person_ids: ['124867'], role: 'def/ep-roles/SPEAKER' }],
        document_ids: ['CRE-9-2024-03-12-OTH-22050000'],
        original_languages: ['it'],
        speaker: 'Brando Benifei, Rapporteur.',
        language_tags: ['en'],
        text: { value: benifeiParagraphs.join('\n\n'), language: 'en' },
      },
    });
    expect(data).not.toHaveProperty('notice');
    expect(contractText(result)).toContain(
      `result.speech.text.value: \` ${JSON.stringify(benifeiParagraphs.join('\n\n'))} \``,
    );
  });

  it('keeps every block of a speech with machine-translated passages and both original languages', async () => {
    installToolHttp(() =>
      envelopeResponse([
        spoken('MTG-PL-2026-04-28-OTH-2017073719859', {
          label: { en: 'Simplification of the MFF (debate)' },
          languages: ['DEU', 'ENG'],
          fragments: { en: reintkeText },
        }),
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        mode: 'get',
        speech_id: 'MTG-PL-2026-04-28-OTH-2017073719859',
        include_text: true,
      }),
    );
    expect(data.speech).toMatchObject({
      original_languages: ['de', 'en'],
      language_tags: ['en', 'de-t-en-mtec'],
      speaker: 'Terry Reintke, on behalf of the Verts/ALE Group.',
      text: {
        value:
          'Mr President, dear disciples, Member States come up over and over again with new tasks for Europe.\n\nA completely confused CDU course that serves the interests of Donald Trump.',
        language: 'en',
      },
    });
  });

  it('reads a chair communication without a speaker and leaves a row without a recording document textless', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        spoken('MTG-PL-2025-03-11-PVCRE-CHA-1', {
          label: { en: 'IN THE CHAIR: ROBERTA METSOLA' },
          fragments: { en: chairText },
          type: 'MEETING_NAME_CHAIR',
        }),
        {
          id: 'eli/dl/event/MTG-PL-2021-07-05-PVCRE-CHA-1',
          activity_id: 'MTG-PL-2021-07-05-PVCRE-CHA-1',
          activity_date: '2021-07-05',
          had_activity_type: 'def/ep-activities/MEETING_NAME_CHAIR',
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        activity_type: 'MEETING_NAME_CHAIR',
        include_text: true,
      }),
    );
    expect(queryOf(fetcher)).toMatchObject({
      'include-output': 'xml_fragment',
      language: 'en',
      'activity-type': 'MEETING_NAME_CHAIR',
    });
    expect(data.items).toEqual([
      {
        speech_id: 'MTG-PL-2025-03-11-PVCRE-CHA-1',
        date: '2025-03-11',
        title: { value: 'IN THE CHAIR: ROBERTA METSOLA', language: 'en' },
        activity_type: 'def/ep-activities/MEETING_NAME_CHAIR',
        participants: [],
        document_ids: ['CRE-PL-2025-03-11-PVCRE-CHA-1'],
        original_languages: [],
        language_tags: ['en'],
        text: { value: 'IN THE CHAIR: ROBERTA METSOLA\n\nPresident', language: 'en' },
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-03-11-PVCRE-CHA-1',
      },
      {
        speech_id: 'MTG-PL-2021-07-05-PVCRE-CHA-1',
        date: '2021-07-05',
        activity_type: 'def/ep-activities/MEETING_NAME_CHAIR',
        participants: [],
        document_ids: [],
        original_languages: [],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2021-07-05-PVCRE-CHA-1',
      },
    ]);
    expect(data).not.toHaveProperty('notice');
  });

  it('leaves chair rows, which publish no title in any language, out of the missing-title count', async () => {
    // Chair rows publish no activity_label in any language; the other rows are narrowed to `language`.
    const chair = (id: string, fragments?: Record<string, string>) =>
      spoken(id, {
        type: 'MEETING_NAME_CHAIR',
        languages: ['DEU'],
        ...(fragments && { fragments }),
      });
    const debate = {
      label: { en: 'Opening of the sitting' },
      languages: ['DEU'],
      fragments: { en: irishText },
    };
    const fetcher = installToolHttp((url) =>
      url.pathname.endsWith('/speeches')
        ? envelopeResponse([
            chair('MTG-PL-2026-10-07-PVCRE-CHA-1', { en: chairText }),
            spoken('MTG-PL-2026-10-07-OTH-2017097974619', debate),
            chair('MTG-PL-2026-10-07-PVCRE-CHA-2', { en: chairText }),
            ...(url.searchParams.get('sitting-date') === '2026-10-08'
              ? [
                  chair('MTG-PL-2026-10-08-PVCRE-CHA-1'),
                  spoken('MTG-PL-2026-10-08-OTH-2017098000001', { languages: ['ITA'] }),
                ]
              : []),
          ])
        : envelopeResponse([chair('MTG-PL-2026-10-07-PVCRE-CHA-1', { en: chairText })]),
    );
    const chairsOnly = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        sitting_date: '2026-10-07',
        include_text: true,
      }),
    );
    expect(chairsOnly.items).toMatchObject([
      { text: { language: 'en' } },
      { title: { value: 'Opening of the sitting', language: 'en' } },
      { text: { language: 'en' } },
    ]);
    const [first, , third] = chairsOnly.items as Record<string, unknown>[];
    expect(first).not.toHaveProperty('title');
    expect(third).not.toHaveProperty('title');
    expect(chairsOnly).not.toHaveProperty('notice');
    const mixed = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        sitting_date: '2026-10-08',
        include_text: true,
      }),
    );
    expect(mixed.notice).toBe(
      "include_text returns title and text only in the requested language en, without fallback. Missing in en: title on 1 and text on 2 of 5 speeches. Retry with a language in the speech's original_languages.",
    );
    const detail = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        mode: 'get',
        speech_id: 'MTG-PL-2026-10-07-PVCRE-CHA-1',
        include_text: true,
      }),
    );
    expect(detail.speech).toMatchObject({
      activity_type: 'def/ep-activities/MEETING_NAME_CHAIR',
      text: { value: 'IN THE CHAIR: ROBERTA METSOLA\n\nPresident', language: 'en' },
    });
    expect(detail.speech).not.toHaveProperty('title');
    expect(detail).not.toHaveProperty('notice');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('returns title and text only in the requested language, with a notice, and keeps the fallback title without include_text', async () => {
    const labels = { en: 'Resumption of the session', it: 'Ripresa della sessione' };
    const fetcher = installToolHttp((url) => {
      const language = url.searchParams.get('language');
      // The upstream narrows activity_label to the requested language, dropping it when unpublished.
      const label: Record<string, string> | undefined =
        language === null
          ? labels
          : language in labels
            ? { [language]: labels[language as keyof typeof labels] }
            : undefined;
      return envelopeResponse([
        spoken('MTG-PL-2021-07-05-OTH-10040000', {
          ...(label && { label }),
          languages: ['ITA'],
          ...(language === 'ga' && { fragments: { ga: irishText } }),
        }),
        spoken('MTG-PL-2021-07-05-OTH-10060000', { ...(label && { label }), languages: ['ITA'] }),
      ]);
    });
    const irish = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        term: 9,
        sitting_date: '2021-07-05',
        include_text: true,
        language: 'ga',
      }),
    );
    expect(queryOf(fetcher)).toMatchObject({
      'include-output': 'xml_fragment',
      language: 'ga',
      'search-language': 'ga',
    });
    expect(irish.items).toMatchObject([
      {
        original_languages: ['it'],
        speaker: 'Presidente. –',
        language_tags: ['ga'],
        text: {
          value:
            'Dearbhaím gur atosaíodh an seisiún de Pharlaimint na hEorpa a cuireadh ar atráth Déardaoin, an 24 Meitheamh 2021.',
          language: 'ga',
        },
      },
      { original_languages: ['it'] },
    ]);
    for (const row of irish.items as Record<string, unknown>[])
      expect(row).not.toHaveProperty('title');
    expect(irish.items).not.toMatchObject([{}, { text: expect.anything() }]);
    expect(irish.notice).toBe(
      "include_text returns title and text only in the requested language ga, without fallback. Missing in ga: title on 2 and text on 1 of 2 speeches. Retry with language en or a language in the speech's original_languages.",
    );
    const fallback = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        term: 9,
        sitting_date: '2021-07-05',
        language: 'ga',
      }),
    );
    expect(queryOf(fetcher, 1)).not.toHaveProperty('include-output');
    expect(queryOf(fetcher, 1)).not.toHaveProperty('language');
    expect(fallback.items).toMatchObject([
      { title: { value: 'Resumption of the session', language: 'en' }, original_languages: ['it'] },
      { title: { value: 'Resumption of the session', language: 'en' }, original_languages: ['it'] },
    ]);
    for (const row of fallback.items as Record<string, unknown>[])
      expect(row).not.toHaveProperty('text');
    expect(fallback.notice).toBe('Requested language ga unavailable; returned published en text.');
    const english = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        term: 9,
        sitting_date: '2021-07-05',
        include_text: true,
      }),
    );
    expect(english.notice).toBe(
      "include_text returns title and text only in the requested language en, without fallback. Missing in en: text on 2 of 2 speeches. Retry with a language in the speech's original_languages.",
    );
  });

  it('acquires at most 100 rows per call through the limit clamp, in aligned pages or one keyword request', async () => {
    const pool = Array.from({ length: 250 }, (_, i) =>
      spoken(`MTG-PL-2025-01-15-OTH-${String(i).padStart(6, '0')}`, {
        fragments: { en: chairText },
      }),
    );
    const fetcher = installToolHttp((url) => {
      const offset = Number(url.searchParams.get('offset'));
      return Response.json({
        data: pool.slice(offset, offset + Number(url.searchParams.get('limit'))),
        meta: { total: pool.length },
      });
    });
    const capped = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { include_text: true, limit: 500 }),
    );
    expect(capped).toMatchObject({
      page: { offset: 0, limit: 100, returned: 100, next_offset: 100 },
      truncated: true,
      totalCount: 250,
    });
    expect(capped.notice).toContain(
      'Requested limit normalized to the effective maximum of 100 speeches with text.',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(queryOf(fetcher)).toMatchObject({ offset: '0', limit: '100' });
    const unaligned = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { include_text: true, offset: 50, limit: 100 }),
    );
    expect(unaligned).toMatchObject({ page: { offset: 50, limit: 100, next_offset: 150 } });
    expect((unaligned.items as { speech_id: string }[]).map((row) => row.speech_id)).toEqual(
      pool.slice(50, 150).map((row) => row.activity_id),
    );
    expect(unaligned).not.toHaveProperty('notice', expect.stringContaining('normalized'));
    expect([queryOf(fetcher, 1), queryOf(fetcher, 2)]).toMatchObject([
      { offset: '0', limit: '100', 'include-output': 'xml_fragment', language: 'en' },
      { offset: '100', limit: '100', 'include-output': 'xml_fragment', language: 'en' },
    ]);
    expectSuccessTwin(
      await runToolContract(searchSpeechesTool, {
        include_text: true,
        text: 'artificial intelligence',
        limit: 500,
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(queryOf(fetcher, 3)).toMatchObject({
      offset: '0',
      limit: '100',
      text: 'artificial intelligence',
      'include-output': 'xml_fragment',
      language: 'en',
    });
    expect(queryOf(fetcher, 3)).not.toHaveProperty('sort-by');
  });

  it('fails a deadline crossed on the second aligned text page as a Timeout, never a partial page', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const fetcher = installToolHttp((_url, _init, index) => {
      vi.advanceTimersByTime(index === 0 ? 20_000 : 20_001);
      return envelopeResponse(
        Array.from({ length: 100 }, (_, i) =>
          spoken(`MTG-PL-2025-01-15-OTH-${String(i).padStart(6, '0')}`, {}),
        ),
      );
    });
    const result = await runToolContract(searchSpeechesTool, {
      include_text: true,
      offset: 50,
      limit: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(contractText(result)).toContain('deadline');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('relays upstream text with ampersands, angle brackets, quotes and backticks whole on both surfaces', async () => {
    const fragment =
      '<oralStatements><speech><from xml:lang="en"><person>A &amp; B</person>.</from><blockContainer><p>R&amp;D &lt;script&gt; &quot;quoted&quot; and \'single\'</p><p>``fenced`` `code` \\ <![CDATA[<raw> & ]]>end</p></blockContainer></speech></oralStatements>';
    installToolHttp(() =>
      envelopeResponse([
        spoken('MTG-PL-2025-01-15-OTH-000001', { languages: ['ENG'], fragments: { en: fragment } }),
      ]),
    );
    const result = await runToolContract(searchSpeechesTool, {
      mode: 'get',
      speech_id: 'MTG-PL-2025-01-15-OTH-000001',
      include_text: true,
    });
    const data = expectSuccessTwin(result);
    const value = 'R&D <script> "quoted" and \'single\'\n\n``fenced`` `code` \\ <raw> & end';
    expect(data.speech).toMatchObject({ speaker: 'A & B.', text: { value, language: 'en' } });
    expect(contractText(result)).toContain(
      `result.speech.text.value: \`\`\` ${JSON.stringify(value)} \`\`\``,
    );
  });

  it.each([[{ mode: 'get', speech_id: 'S', include_text: 'yes' }], [{ include_text: 1 }]])(
    'rejects a non-boolean include_text %j before network',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract<Parameters<typeof runToolContract>[0]>(
        searchSpeechesTool,
        input,
      );
      expect(result.isError).toBe(true);
      expect(contractText(result)).toContain('include_text');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('returns an empty text search and a past-end page with the shared notices', async () => {
    installToolHttp(() => new Response(null, { status: 204 }));
    const empty = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { include_text: true, sitting_date: '2025-01-01' }),
    );
    expect(empty).toMatchObject({ items: [], page: { returned: 0, has_more: false } });
    expect(empty.notice).toContain('No speech records matched in term 10 (the default).');
    expect(empty.notice).not.toContain('include_text');
    const past = expectSuccessTwin(
      await runToolContract(searchSpeechesTool, { include_text: true, offset: 300 }),
    );
    expect(past.notice).toBe(
      'The page at offset 300 returned no speeches. Restart at offset 0 or return to the previous page.',
    );
  });
});
