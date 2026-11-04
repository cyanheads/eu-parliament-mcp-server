/** @fileoverview Document discovery and nested source-file wire contracts. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchDocumentsTool } from '../../src/mcp-server/tools/definitions/search-documents.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { documentRecord, envelopeResponse } from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';

describe('euparl_search_documents contract', () => {
  it('follows published adoption identities and preserves unavailable based-on targets as errors', async () => {
    const responses = new Map([
      [
        'TA-9-2024-0138',
        {
          id: 'eli/dl/doc/TA-9-2024-0138',
          adopts: { id: 'https://data.europarl.europa.eu/eli/dl/doc/A-9-2023-0188' },
          notation_publicRegister: 'P9_TA(2024)0138',
        },
      ],
      [
        'A-9-2023-0188',
        {
          id: 'eli/dl/doc/A-9-2023-0188',
          adopts: ['CJ40-PR-731563'],
          based_on: { id: 'eli/dl/doc/RULES-9-2023-05-08-ITM-A58' },
          notation_publicRegister: 'P9_A(2023)0188',
        },
      ],
      ['CJ40-PR-731563', { id: 'eli/dl/doc/CJ40-PR-731563' }],
    ]);
    const fetcher = installToolHttp((url) => {
      const id = url.pathname.split('/').at(-1)!;
      if (id === 'RULES-9-2023-05-08-ITM-A58') return new Response(null, { status: 500 });
      const raw = responses.get(id);
      return raw ? envelopeResponse([raw]) : new Response(null, { status: 404 });
    });
    for (const [id, adopted, basedOn, register] of [
      ['TA-9-2024-0138', ['A-9-2023-0188'], [], 'P9_TA(2024)0138'],
      ['A-9-2023-0188', ['CJ40-PR-731563'], ['RULES-9-2023-05-08-ITM-A58'], 'P9_A(2023)0188'],
      ['CJ40-PR-731563', [], [], undefined],
    ] as const) {
      const data = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { mode: 'get', document_id: id }),
      );
      expect(data).toMatchObject({
        found: true,
        document: {
          document_id: id,
          adopted_document_ids: adopted,
          based_on_document_ids: basedOn,
          procedure_ids: [],
        },
      });
      if (register) expect(data.document).toHaveProperty('public_register_ref', register);
      else expect(data.document).not.toHaveProperty('public_register_ref');
    }
    const failure = await runToolContract(searchDocumentsTool, {
      mode: 'get',
      document_id: 'RULES-9-2023-05-08-ITM-A58',
    });
    expect(failure).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.ServiceUnavailable } },
    });
    expect(contractText(failure)).toContain('Parliament could not serve the request. Retry later.');
    expect(
      expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { mode: 'get', document_id: 'MISSING' }),
      ),
    ).toMatchObject({ found: false });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
  it('limits adopted-text search windows while retaining deep plenary search', async () => {
    const fetcher = installToolHttp(
      (url) =>
        new Response(
          JSON.stringify({
            data: Array.from(
              { length: url.pathname.includes('plenary-documents') ? 1 : 100 },
              (_, i) => ({ id: `eli/dl/doc/LAST-${i}` }),
            ),
            meta: { total: 10000 },
          }),
        ),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        source: 'adopted_texts',
        offset: 9999,
        limit: 1,
      }),
    );
    expect(data).toMatchObject({ truncated: true, page: { has_more: true } });
    expect(data).not.toHaveProperty('totalCount');
    expect(data.page).not.toHaveProperty('next_offset');
    const narrowed = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { offset: 9990, limit: 20 }),
    );
    expect(narrowed).toMatchObject({ page: { offset: 9990, limit: 10 } });
    expect(narrowed.notice).toContain(
      'Requested limit normalized to 10: offset plus limit cannot pass the 10000-result search window.',
    );
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('limit')).toBe('100');
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, { offset: 10000, limit: 20 }),
      'invalid_filter',
      'Narrow text, title, year, term, work_type, sitting dates or related_process_id. Restart paging at offset 0 after narrowing.',
    );
    const plenary = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { source: 'plenary', offset: 9990, limit: 20 }),
    );
    expect(plenary).toMatchObject({
      items: [{ document_id: 'LAST-0' }],
      totalCount: 10000,
      page: { limit: 20 },
    });
    expect(plenary.notice).toBe('Continue with offset 9991.');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['adopted_texts', 'adopted-texts', 'text_adopted', { year: 2025, term: 10 }],
    ['committee', 'committee-documents', 'opinion_parliamentary_committee', { term: 10 }],
    ['plenary', 'plenary-documents', 'report_plenary', { year: 2025 }],
  ] as const)(
    'maps %s filters and sparse catalogue identities',
    async (source, endpoint, work_type, scope) => {
      const fetcher = installToolHttp(() => envelopeResponse([{ id: 'eli/dl/doc/EXAMPLE-1' }]));
      const data = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, {
          source,
          work_type,
          ...scope,
          language: ' FR ',
        }),
      );
      expect(data).toMatchObject({
        source,
        items: [
          {
            document_id: 'EXAMPLE-1',
            source_url: 'https://data.europarl.europa.eu/eli/dl/doc/EXAMPLE-1',
          },
        ],
        appliedFilters: { source, language: 'fr', work_type: work_type.toUpperCase(), ...scope },
      });
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(`/api/v2/${endpoint}`);
      expect(url.searchParams.get('work-type')).toBe(work_type.toUpperCase());
    },
  );

  it('forwards every adopted-text filter with normalized procedure citation', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const data = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        text: 'climate',
        title: 'budget',
        year: 2025,
        term: 10,
        sitting_date: '2025-01-01',
        sitting_date_end: '2025-01-31',
        related_process_id: '2025/0001(COD)',
      }),
    );
    expect(data).toMatchObject({
      source: 'adopted_texts',
      items: [],
      appliedFilters: { text: 'climate', title: 'budget', related_process_id: '2025-0001' },
    });
    const query = new URL(String(fetcher.mock.calls[0]?.[0])).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      text: 'climate',
      title: 'budget',
      year: '2025',
      'parliamentary-term': '10',
      'sitting-date': '2025-01-01',
      'sitting-date-end': '2025-01-31',
      'related-process-id': '2025-0001',
      view: 'list',
      'search-language': 'en',
    });
  });

  it('preserves all selected-language expressions, manifestations and file references', async () => {
    const title = 'Source `code` **bold** [link](https://example.org)\nsecond line';
    installToolHttp(() =>
      envelopeResponse([
        {
          ...documentRecord,
          title_dcterms: { fr: title },
          creator: [{ id: 'person/1' }, 'person/2'],
          refers_to: ['eli/dl/proc/2025-0001'],
          is_about: ['eli/dl/proc/2025-0002', 'org/AFCO'],
          is_part_of: { id: 'eli/dl/doc/PARENT' },
          is_realized_by: [
            ...documentRecord.is_realized_by,
            {
              id: 'extra/fr',
              is_embodied_by: [
                {
                  id: 'extra/fr/web',
                  is_exemplified_by: ['https://example.org/a', { id: 'distribution/b' }],
                  issued: '2025-01-16',
                  byteSize: '9007199254740993',
                  media_type: 'text/html',
                },
              ],
            },
          ],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        mode: 'get',
        document_id: documentRecord.id,
        language: 'fr',
      }),
    );
    expect(data).toMatchObject({
      found: true,
      document: {
        document_id: 'AFCO-AD-900001',
        title: { value: title, language: 'fr' },
        creator_ids: ['person/1', 'person/2'],
        procedure_ids: ['2025-0001', '2025-0002'],
        parent_document_ids: ['PARENT'],
        links: [
          { url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.pdf' },
          { url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.html' },
          {
            url: 'https://example.org/a',
            size_bytes: '9007199254740993',
            issued: '2025-01-16',
            media_type: 'text/html',
          },
          { url: 'https://data.europarl.europa.eu/distribution/b' },
        ],
      },
    });
  });

  it('preserves large backtick-rich filters and published titles on both surfaces', async () => {
    const text = '`a'.repeat(200_000);
    const fetcher = installToolHttp(() =>
      envelopeResponse([{ ...documentRecord, title_dcterms: { en: text } }]),
    );
    const search = expectSuccessTwin(await runToolContract(searchDocumentsTool, { text }));
    expect(search.appliedFilters).toMatchObject({ text });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('text')).toBe(text);

    const detail = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { mode: 'get', document_id: documentRecord.id }),
    );
    expect(detail).toMatchObject({
      found: true,
      document: { title: { value: text, language: 'en' } },
    });
  });

  it.each([
    'AFCO-AD-900001',
    'CRE-10-2025-01-15-ITM-001',
    'PV-10-2025-01-15-RCV',
    'E-10-2025-900001',
    'E-10-2025-900001-ASW',
  ])('retrieves cross-family %s with the generic route', async (id) => {
    const fetcher = installToolHttp(() => envelopeResponse([{ id: `eli/dl/doc/${id}` }]));
    expect(
      expectSuccessTwin(
        await runToolContract(searchDocumentsTool, {
          mode: 'get',
          document_id: `https://data.europarl.europa.eu/eli/dl/doc/${id}`,
        }),
      ),
    ).toMatchObject({
      found: true,
      document: {
        document_id: id,
        links: [],
        creator_ids: [],
        procedure_ids: [],
        parent_document_ids: [],
      },
    });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(`/api/v2/documents/${id}`);
  });

  it.each([
    [
      { source: 'adopted_texts', offset: 0 },
      'No documents matched. Remove a named filter, or call euparl_list_reference with topic document_types; keyword search is available only for adopted_texts.',
    ],
    [
      { source: 'plenary', offset: 0 },
      'No documents matched. Remove a named filter, or call euparl_list_reference with topic document_types; keyword search is available only for adopted_texts.',
    ],
    [
      { source: 'committee', offset: 40 },
      'The page at offset 40 returned no documents. Restart at offset 0 or return to the previous page.',
    ],
  ] as const)('renders an empty %j page with guidance for that position', async (input, notice) => {
    installToolHttp(() => new Response(null, { status: 204 }));
    expect(expectSuccessTwin(await runToolContract(searchDocumentsTool, input))).toMatchObject({
      items: [],
      page: { offset: input.offset, returned: 0, has_more: false },
      notice,
    });
  });

  describe('family procedure relation', () => {
    const generic = { ...documentRecord, refers_to: 'eli/dl/proc/2020-0001' };
    const install = (family: () => Response) =>
      installToolHttp((url) =>
        url.pathname.startsWith('/api/v2/documents/') ? envelopeResponse([generic]) : family(),
      );
    const input = { mode: 'get', document_id: documentRecord.id, language: 'pl' } as const;
    const get = () => runToolContract(searchDocumentsTool, input);
    const withoutProcedures = (result: Awaited<ReturnType<typeof get>>) => ({
      structured: {
        ...(result.structuredContent as { document: object }),
        document: {
          ...(result.structuredContent as { document: object }).document,
          procedure_ids: [],
        },
      },
      text: contractText(result)
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('result.document.procedure_ids'))
        .join('\n'),
    });

    it('adds the committee record procedures on both surfaces and changes nothing else', async () => {
      const fetcher = install(() =>
        envelopeResponse([
          {
            id: documentRecord.id,
            inverse_created_a_realization_of: ['eli/dl/proc/2021-0106', 'eli/dl/proc/2020-0001'],
          },
        ]),
      );
      const related = await get();
      expect(expectSuccessTwin(related)).toMatchObject({
        found: true,
        document: { procedure_ids: ['2020-0001', '2021-0106'] },
      });
      expect(String(fetcher.mock.calls[1]?.[0])).toBe(
        'https://data.europarl.europa.eu/api/v2/committee-documents/AFCO-AD-900001?language=mul&format=application%2Fld%2Bjson',
      );
      install(() => new Response(null, { status: 404 }));
      const unpublished = await get();
      expect(expectSuccessTwin(unpublished)).toMatchObject({
        document: { procedure_ids: ['2020-0001'] },
      });
      expect(withoutProcedures(related)).toEqual(withoutProcedures(unpublished));
    });

    it('renders the degraded-relation notice on both surfaces when the family read fails', async () => {
      const fetcher = install(() => new Response(null, { status: 503 }));
      const data = expectSuccessTwin(await get());
      expect(data).toMatchObject({ found: true, document: { procedure_ids: ['2020-0001'] } });
      expect(data.notice).toContain(
        'The procedure relation could not be read from the committee family record of this document, so procedure_ids may be incomplete; repeat the same get to retry.',
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('rethrows caller cancellation during the family read instead of answering with a notice', async () => {
      const controller = new AbortController();
      const fetcher = installToolHttp((url, init) => {
        if (url.pathname.startsWith('/api/v2/documents/')) return envelopeResponse([generic]);
        controller.abort(new DOMException('Document read stopped', 'AbortError'));
        init?.signal?.throwIfAborted();
        throw new Error('Cancellation did not reach fetch');
      });
      // runToolContract settles a handler that returns after the abort as RequestCancelled too, so
      // only a direct handler call shows whether the cancellation was rethrown or degraded.
      await expect(
        searchDocumentsTool.handler(
          searchDocumentsTool.input.parse(input),
          createMockContext({ errors: searchDocumentsTool.errors, signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Document read stopped' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('discloses fallback language and renders the effective cap, continuation and end page', async () => {
    // One row more than the cap, sliced by the requested window as the upstream does.
    const pool = Array.from({ length: 226 }, (_, i) => ({ id: `eli/dl/doc/D-${i}` }));
    const fetcher = installToolHttp((url) => {
      const offset = Number(url.searchParams.get('offset'));
      return envelopeResponse(pool.slice(offset, offset + Number(url.searchParams.get('limit'))));
    });
    const first = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        limit: 225,
        text: '',
        title: ' ',
        work_type: '',
        related_process_id: '',
        language: ' ',
      }),
    );
    expect(first).toMatchObject({
      page: { limit: 225, returned: 225, next_offset: 225 },
      truncated: true,
      shown: 225,
      cap: 225,
    });
    expect(first.notice).toBe('Continue with offset 225.');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
    expect(
      expectSuccessTwin(await runToolContract(searchDocumentsTool, { offset: 225 })),
    ).toMatchObject({
      items: [{ document_id: 'D-225' }],
      page: { offset: 225, returned: 1, has_more: false },
    });
    expect(
      expectSuccessTwin(await runToolContract(searchDocumentsTool, { offset: 500 })),
    ).toMatchObject({
      items: [],
      page: { offset: 500, returned: 0, has_more: false },
      notice:
        'The page at offset 500 returned no documents. Restart at offset 0 or return to the previous page.',
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    installToolHttp(() => envelopeResponse([documentRecord]));
    const fallback = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        mode: 'get',
        document_id: documentRecord.id,
        language: 'pl',
      }),
    );
    expect(fallback).toMatchObject({
      document: {
        title: { language: 'en', value: 'Example opinion' },
        links: [{ language: 'en' }],
      },
    });
    expect(fallback.notice).toContain('Requested file language pl unavailable');
  });

  it.each([204, 404])('returns a guided detail miss for HTTP %i', async (status) => {
    installToolHttp(() => new Response(null, { status }));
    const data = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { mode: 'get', document_id: 'MISSING' }),
    );
    expect(data).toMatchObject({ mode: 'get', found: false });
    expect(data.notice).toContain('euparl_search_documents');
    expect(data).not.toHaveProperty('document');
  });

  it.each([
    [
      { source: 'committee', year: 2025 },
      'Remove year for committee documents; use term and work_type to narrow this family.',
    ],
    [
      { source: 'plenary', term: 10 },
      'Remove term for plenary documents; use year and work_type to narrow this family.',
    ],
    [
      { source: 'committee', text: 'ignored' },
      'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
    ],
    [
      { source: 'plenary', title: 'ignored' },
      'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
    ],
    [
      { source: 'committee', sitting_date: '2025-01-01' },
      'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
    ],
    [
      { source: 'plenary', related_process_id: '2025-0001' },
      'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
    ],
    [{ work_type: 'UNKNOWN' }, invalidHint],
    [{ language: 'xx' }, invalidHint],
  ] as const)('rejects unsupported filter %j before network', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(searchDocumentsTool, input), 'invalid_filter', hint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ sitting_date: '2024-02-30' }, 'Pass an existing calendar day as YYYY-MM-DD.'],
    [
      { sitting_date_end: '2025-01-01' },
      'Pass sitting_date with sitting_date_end, on or before it.',
    ],
  ] as const)(
    'rejects sitting dates %j with their own recovery before network',
    async (input, hint) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(searchDocumentsTool, input),
        'invalid_filter',
        hint,
        JsonRpcErrorCode.ValidationError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ mode: 'get' }, 'Supply document_id for the selected mode.'],
    [
      { mode: 'get', document_id: 'D', source: 'committee' },
      'Remove source, or select a mode that accepts source.',
    ],
    [
      { mode: 'get', document_id: 'D', limit: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [
      { mode: 'get', document_id: 'D', offset: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [{ document_id: 'D' }, 'Remove document_id, or select a mode that accepts document_id.'],
  ] as const)('rejects incompatible mode %j before network', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(searchDocumentsTool, input), 'invalid_mode_fields', hint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 422, 429])('renders transport recovery for HTTP %i', async (status) => {
    const fetcher = installToolHttp(() => new Response(null, { status }));
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, {}),
      status === 429 ? 'upstream_rate_limited' : 'upstream_rejected',
      status === 429
        ? 'Wait for the reported retry interval, then repeat the same euparl tool call.'
        : 'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.',
    );
    expect(fetcher).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
  });

  it('rejects an unsupported snapshot at the schema boundary', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const input = { mode: 'search' as const, snapshot: 'abc' };
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, input),
      'invalid_arguments',
      'Unknown key snapshot. This tool accepts: mode, source, document_id, text, title, year, term, work_type, sitting_date, sitting_date_end, related_process_id, offset, limit, language.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recovers a transient HTTP failure before rendering the complete result', async () => {
    const fetcher = installToolHttp((_url, _init, index) =>
      index === 0 ? new Response(null, { status: 503 }) : envelopeResponse([documentRecord]),
    );
    expect(
      expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { mode: 'get', document_id: documentRecord.id }),
      ),
    ).toMatchObject({
      found: true,
      document: { document_id: 'AFCO-AD-900001', links: [{ language: 'en' }] },
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v2/documents/AFCO-AD-900001',
      '/api/v2/documents/AFCO-AD-900001',
      '/api/v2/committee-documents/AFCO-AD-900001',
    ]);
  });
});
