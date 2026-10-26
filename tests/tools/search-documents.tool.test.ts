/** @fileoverview Document discovery and nested source-file wire contracts. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';

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
      () =>
        new Response(JSON.stringify({ data: [{ id: 'eli/dl/doc/LAST' }], meta: { total: 10000 } })),
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
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, { offset: 9990, limit: 20 }),
      'invalid_filter',
      invalidHint,
    );
    expect(
      expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { source: 'plenary', offset: 9990, limit: 20 }),
      ),
    ).toMatchObject({ items: [{ document_id: 'LAST' }], totalCount: 10000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
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

  it('discloses fallback language and renders the effective cap, continuation and end page', async () => {
    const fetcher = installToolHttp((url) =>
      envelopeResponse(
        url.searchParams.get('offset') === '100'
          ? []
          : Array.from({ length: 100 }, (_, i) => ({ id: `eli/dl/doc/D-${i}` })),
      ),
    );
    const first = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, {
        limit: 1000,
        text: '',
        title: ' ',
        work_type: '',
        related_process_id: '',
        language: ' ',
      }),
    );
    expect(first).toMatchObject({
      page: { limit: 100, returned: 100, next_offset: 100 },
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 100. Continue with offset 100.',
    );
    expect(
      expectSuccessTwin(await runToolContract(searchDocumentsTool, { offset: 100 })),
    ).toMatchObject({ items: [], page: { offset: 100, returned: 0, has_more: false } });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    { source: 'committee', year: 2025 },
    { source: 'plenary', term: 10 },
    { source: 'committee', text: 'ignored' },
    { source: 'plenary', title: 'ignored' },
    { source: 'committee', sitting_date: '2025-01-01' },
    { source: 'plenary', related_process_id: '2025-0001' },
    { sitting_date: '2025-02-30' },
    { sitting_date_end: '2025-01-01' },
    { work_type: 'UNKNOWN' },
    { language: 'xx' },
  ] as const)('rejects unsupported filter %j before network', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, input),
      'invalid_filter',
      invalidHint,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'get' },
    { mode: 'get', document_id: 'D', source: 'committee' },
    { mode: 'get', document_id: 'D', limit: 1 },
    { mode: 'get', document_id: 'D', offset: 1 },
    { document_id: 'D' },
  ] as const)('rejects incompatible mode %j before network', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(searchDocumentsTool, input),
      'invalid_mode_fields',
      modeHint,
    );
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
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
