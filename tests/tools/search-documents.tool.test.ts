/** @fileoverview Document discovery and nested source-file wire contracts. */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { initServerConfig } from '../../src/config/server-config.js';
import { searchDocumentsTool } from '../../src/mcp-server/tools/definitions/search-documents.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import {
  awareDeclarationFamilyRecord,
  awareDeclarationRecord,
  declarationRow,
  documentRecord,
  envelopeResponse,
  malformedProcedureDeclaration,
  malformedProcedureDeclarationRecord,
  multiValuedFilesRecord,
  multiValuedTitleRecord,
  supersededDeclarationRows,
} from '../helpers/eu-parliament-fixtures.js';

const documentIdHint =
  'Call euparl_search_documents in search mode for canonical document_id values, then retry; pass a question citation such as E-000003/2025 to euparl_list_questions as question_id.';
/** Top-level keys in the order their `<prefix><key>` lines first appear in content[]. */
const renderedKeys = (result: Awaited<ReturnType<typeof runToolContract>>, prefix: string) => [
  ...new Set(
    contractText(result)
      .split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => /^[a-z_]+/.exec(line.slice(prefix.length))?.[0]),
  ),
];

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
      language: 'en',
      'search-language': 'en',
    });
    expect(query.has('view')).toBe(false);
  });

  it('renders adopted-text titles, dates and procedure_ids on both surfaces and counts untitled rows', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'eli/dl/doc/TA-9-2024-0138',
          identifier: 'TA-9-2024-0138',
          label: 'T9-0138/2024',
          work_type: 'def/ep-document-types/TEXT_ADOPTED',
          title_dcterms: { en: 'Artificial Intelligence Act' },
          document_date: '2024-03-13',
          inverse_created_a_realization_of: [
            'eli/dl/event/MTG-PL-2024-03-13-PVCRE-ITM-8-2',
            'eli/dl/proc/2021-0106',
          ],
        },
        {
          id: 'eli/dl/doc/TA-9-2019-10-23-ANN01',
          identifier: 'TA-9-2019-10-23-ANN01',
          document_date: '2019-10-23',
          is_realized_by: ['eli/dl/doc/TA-9-2019-10-23-ANN01/es'],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(searchDocumentsTool, { text: 'artificial intelligence act' }),
    );
    expect(data.items).toEqual([
      {
        document_id: 'TA-9-2024-0138',
        identifier: 'TA-9-2024-0138',
        label: 'T9-0138/2024',
        work_type: 'def/ep-document-types/TEXT_ADOPTED',
        source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2024-0138',
        title: { value: 'Artificial Intelligence Act', language: 'en' },
        date: '2024-03-13',
        procedure_ids: ['2021-0106'],
      },
      {
        document_id: 'TA-9-2019-10-23-ANN01',
        identifier: 'TA-9-2019-10-23-ANN01',
        source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2019-10-23-ANN01',
        date: '2019-10-23',
        procedure_ids: [],
      },
    ]);
    expect(data.notice).toContain(
      "1 row on this page has no title in en, the only language the adopted-text list returns; mode get with a row's document_id reads its title in another published language.",
    );
  });

  it('keeps the detail and adopted-text row field order on both surfaces', async () => {
    installToolHttp((url) => {
      if (url.pathname.startsWith('/api/v2/adopted-texts'))
        return envelopeResponse([
          {
            id: 'eli/dl/doc/TA-9-2024-0138',
            identifier: 'TA-9-2024-0138',
            label: 'T9-0138/2024',
            work_type: 'def/ep-document-types/TEXT_ADOPTED',
            title_dcterms: { en: 'Artificial Intelligence Act' },
            document_date: '2024-03-13',
            inverse_created_a_realization_of: ['eli/dl/proc/2021-0106'],
          },
        ]);
      if (url.pathname.startsWith('/api/v2/documents/'))
        return envelopeResponse([
          {
            ...documentRecord,
            label: 'A9-0188/2023',
            creator: ['person/1'],
            refers_to: ['eli/dl/proc/2025-0001'],
            is_part_of: ['eli/dl/doc/PARENT'],
            adopts: ['eli/dl/doc/ADOPTED'],
            based_on: ['eli/dl/doc/BASIS'],
            notation_publicRegister: 'P9_A(2023)0188',
          },
        ]);
      return new Response(null, { status: 404 });
    });
    const detailOrder = [
      'document_id',
      'identifier',
      'label',
      'work_type',
      'source_url',
      'title',
      'date',
      'term_id',
      'creator_ids',
      'procedure_ids',
      'parent_document_ids',
      'adopted_document_ids',
      'based_on_document_ids',
      'public_register_ref',
      'links',
    ];
    const get = await runToolContract(searchDocumentsTool, {
      mode: 'get',
      document_id: documentRecord.id,
    });
    const detail = expectSuccessTwin(get);
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(detail.document))).toEqual(
      detailOrder,
    );
    expect(renderedKeys(get, 'result.document.')).toEqual(detailOrder);

    const rowOrder = [
      'document_id',
      'identifier',
      'label',
      'work_type',
      'source_url',
      'title',
      'date',
      'procedure_ids',
    ];
    const search = await runToolContract(searchDocumentsTool, { text: 'artificial intelligence' });
    const rows = z.array(z.record(z.string(), z.unknown())).parse(expectSuccessTwin(search).items);
    expect(rows.map((row) => Object.keys(row))).toEqual([rowOrder]);
    expect(renderedKeys(search, 'result.items[0].')).toEqual(rowOrder);
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

  describe('several published values', () => {
    const reds = 'https://data.europarl.europa.eu/distribution/reds_iPlTa_Itm/TA-9-2023-0276/';
    const doc = 'https://data.europarl.europa.eu/distribution/doc/';
    const get = async (record: object, input: Record<string, unknown>) => {
      installToolHttp((url) =>
        url.pathname.startsWith('/api/v2/documents/')
          ? envelopeResponse([record])
          : new Response(null, { status: 404 }),
      );
      return runToolContract(searchDocumentsTool, { mode: 'get', ...input });
    };

    it('gives each file of a manifestation every published issue date and size on both surfaces, none as a scalar', async () => {
      const en = await get(multiValuedFilesRecord, { document_id: 'TA-9-2023-0276' });
      const xmlIssued = ['2024-05-14T17:12:06+02:00', '2023-12-20T15:52:28+01:00'];
      const xml = 'https://www.iana.org/assignments/media-types/application/xml';
      expect(expectSuccessTwin(en)).toMatchObject({ found: true });
      const links = (result: typeof en) =>
        z
          .object({ document: z.object({ links: z.array(z.record(z.string(), z.unknown())) }) })
          .parse(result.structuredContent).document.links;
      expect(links(en)).toEqual([
        {
          url: `${reds}TA-9-2023-0276-FNL_en.xml`,
          media_type: xml,
          language: 'en',
          issued_values: xmlIssued,
          size_bytes: '3225',
        },
        {
          url: `${doc}TA-9-2023-0276_en.xml`,
          media_type: xml,
          language: 'en',
          issued_values: xmlIssued,
          size_bytes: '3225',
        },
      ]);
      // Output key order puts each list beside the scalar it replaces.
      expect(Object.keys(links(en)[0]!)).toEqual([
        'url',
        'media_type',
        'language',
        'issued_values',
        'size_bytes',
      ]);
      expect(contractText(en)).toContain(
        'result.document.links[1].issued_values[1]: ` "2023-12-20T15:52:28+01:00" `',
      );

      const lt = await get(multiValuedFilesRecord, {
        document_id: 'TA-9-2023-0276',
        language: 'lt',
      });
      expectSuccessTwin(lt);
      const docx = {
        language: 'lt',
        issued_values: ['2024-04-16T12:53:46.063+02:00', '2023-11-15T13:05:52+01:00'],
        size_bytes_values: ['44793', '44848'],
      };
      expect(links(lt)).toEqual([
        {
          url: `${reds}TA-9-2023-0276-FNL_lt.pdf`,
          media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
          language: 'lt',
          issued: '2023-11-15T13:05:52+01:00',
          size_bytes: '44793',
        },
        { url: `${reds}TA-9-2023-0276-FNL_lt.docx`, ...docx },
        { url: `${doc}TA-9-2023-0276_lt.docx`, ...docx },
        {
          url: `${reds}TA-9-2023-0276-FNL_lt.xml`,
          language: 'lt',
          issued: '2023-12-20T15:53:41+01:00',
          size_bytes: '3230',
        },
      ]);
    });

    it('lists both issue dates of one reissued file and keeps its single size', async () => {
      const cre = await get(
        {
          id: 'eli/dl/doc/CRE-10-2024-07-17',
          identifier: 'CRE-10-2024-07-17',
          is_realized_by: [
            {
              id: 'eli/dl/doc/CRE-10-2024-07-17/mul',
              is_embodied_by: [
                {
                  id: 'eli/dl/doc/CRE-10-2024-07-17/mul/xml',
                  is_exemplified_by: 'distribution/doc/CRE-10-2024-07-17_mul.xml',
                  issued: ['2026-07-20T09:53:33+02:00', '2025-03-06T15:27:13+01:00'],
                  byteSize: '161354',
                },
              ],
            },
          ],
        },
        { document_id: 'CRE-10-2024-07-17' },
      );
      expect(expectSuccessTwin(cre)).toMatchObject({
        found: true,
        document: {
          links: [
            {
              url: `${doc}CRE-10-2024-07-17_mul.xml`,
              language: 'mul',
              issued_values: ['2026-07-20T09:53:33+02:00', '2025-03-06T15:27:13+01:00'],
              size_bytes: '161354',
            },
          ],
        },
      });
      expect(contractText(cre)).not.toContain('result.document.links[0].issued:');
    });

    it('reads TA-9-2023-0395 files and OJQ-9-2023-07-11 titles that publish several values', async () => {
      // Live TA-9-2023-0395 fi expression (2026-11-25), trimmed to its two multi-valued files.
      const twoFiles = (format: string, issued: string[], byteSize: string[]) => ({
        id: `eli/dl/doc/TA-9-2023-0395/fi/${format}`,
        is_exemplified_by: [
          `distribution/reds_iPlTa_Itm/TA-9-2023-0395/TA-9-2023-0395-FNL_fi.${format}`,
          `distribution/doc/TA-9-2023-0395_fi.${format}`,
        ],
        issued,
        byteSize,
      });
      const xml = twoFiles(
        'xml',
        ['2024-03-22T09:09:32+01:00', '2024-02-28T19:15:28+01:00'],
        ['9289', '9349'],
      );
      const docx = twoFiles(
        'docx',
        ['2024-03-22T10:13:06.591+01:00', '2024-03-20T15:55:00+01:00'],
        ['43596', '43623'],
      );
      const files = expectSuccessTwin(
        await get(
          {
            id: 'eli/dl/doc/TA-9-2023-0395',
            identifier: 'TA-9-2023-0395',
            is_realized_by: [{ id: 'eli/dl/doc/TA-9-2023-0395/fi', is_embodied_by: [xml, docx] }],
          },
          { document_id: 'TA-9-2023-0395', language: 'fi' },
        ),
      );
      expect(files).toMatchObject({
        found: true,
        document: {
          links: [xml, xml, docx, docx].map((file, index) => ({
            url: `https://data.europarl.europa.eu/${file.is_exemplified_by[index % 2]}`,
            language: 'fi',
            issued_values: file.issued,
            size_bytes_values: file.byteSize,
          })),
        },
      });
      // Live OJQ-9-2023-07-11 (2026-11-25): two titles in fi and in ga, a typed work, no expressions.
      const ga = ['Cláir oibre - Dé Máirt, 11 Iúil 2023', 'CLÁR - Dé Máirt, 11 Iúil 2023'];
      const agenda = expectSuccessTwin(
        await get(
          {
            id: 'eli/dl/doc/OJQ-9-2023-07-11',
            type: ['Work', 'ComplexWork'],
            identifier: 'OJQ-9-2023-07-11',
            work_type: 'def/ep-document-types/AGENDA_PLENARY_DAY',
            title_dcterms: {
              fi: [
                'Esityslista - Tiistai 11. heinäkuuta 2023',
                'Esityslista  - Tiistai 11. heinäkuuta 2023',
              ],
              ga,
              en: 'Agenda - Tuesday, 11 July 2023',
            },
          },
          { document_id: 'OJQ-9-2023-07-11', language: 'ga' },
        ),
      );
      expect(agenda).toMatchObject({
        found: true,
        document: { title: { value: ga[0], language: 'ga', values: ga }, links: [] },
      });
    });

    it('returns every title one language publishes, the first as its value, on both surfaces', async () => {
      const de = await get(multiValuedTitleRecord, {
        document_id: 'A-9-2022-0014',
        language: 'de',
      });
      const titles = multiValuedTitleRecord.title_dcterms.de;
      expect(expectSuccessTwin(de)).toMatchObject({
        found: true,
        document: { title: { value: titles[0], language: 'de', values: titles } },
      });
      expect(contractText(de)).toContain(
        `result.document.title.values[1]: \` ${JSON.stringify(titles[1])} \``,
      );
      const en = await get(multiValuedTitleRecord, { document_id: 'A-9-2022-0014' });
      expect(expectSuccessTwin(en)).toMatchObject({
        document: {
          title: {
            value: 'REPORT on the request for waiver of the immunity of Elena Yoncheva',
            language: 'en',
          },
        },
      });
      expect(
        z
          .object({ document: z.object({ title: z.object({}).loose() }) })
          .parse(en.structuredContent).document.title,
      ).not.toHaveProperty('values');
    });

    it('returns every requested-language title of an adopted-text row and none on a one-title row', async () => {
      const hu = [
        'Az alternatív üzemanyagok infrastruktúrájának kiépítése ',
        'Az alternatív üzemanyagok infrastruktúrájának kiépítése',
      ];
      installToolHttp(() =>
        envelopeResponse([
          {
            id: 'eli/dl/doc/TA-9-2023-0261',
            identifier: 'TA-9-2023-0261',
            title_dcterms: { hu },
            is_realized_by: ['eli/dl/doc/TA-9-2023-0261/hu'],
          },
          {
            id: 'eli/dl/doc/TA-9-2023-0262',
            identifier: 'TA-9-2023-0262',
            title_dcterms: { hu: 'Egy cím' },
          },
        ]),
      );
      const search = await runToolContract(searchDocumentsTool, { term: 9, language: 'hu' });
      expect(expectSuccessTwin(search).items).toEqual([
        {
          document_id: 'TA-9-2023-0261',
          identifier: 'TA-9-2023-0261',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2023-0261',
          title: { value: hu[0], language: 'hu', values: hu },
          procedure_ids: [],
        },
        {
          document_id: 'TA-9-2023-0262',
          identifier: 'TA-9-2023-0262',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-9-2023-0262',
          title: { value: 'Egy cím', language: 'hu' },
          procedure_ids: [],
        },
      ]);
      expect(contractText(search)).toContain(
        `result.items[0].title.values[0]: \` ${JSON.stringify(hu[0])} \``,
      );
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

    it('rethrows a caller cancellation whose reason is an McpError instead of answering with a notice', async () => {
      const controller = new AbortController();
      // A classified reason reaches the family read's catch as an McpError, the class it degrades.
      const reason = new McpError(JsonRpcErrorCode.RequestCancelled, 'Document read cancelled');
      const fetcher = installToolHttp((url, init) => {
        if (url.pathname.startsWith('/api/v2/documents/')) return envelopeResponse([generic]);
        controller.abort(reason);
        init?.signal?.throwIfAborted();
        throw new Error('Cancellation did not reach fetch');
      });
      await expect(
        searchDocumentsTool.handler(
          searchDocumentsTool.input.parse(input),
          createMockContext({ errors: searchDocumentsTool.errors, signal: controller.signal }),
        ),
      ).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('document citations and letter case', () => {
    /** Generic reads answer only the published identities in `records`; every other route 404s. */
    const publish = (records: Record<string, Record<string, unknown>>) =>
      installToolHttp((url) => {
        const id = url.pathname.split('/').at(-1)!;
        const raw = url.pathname.startsWith('/api/v2/documents/') ? records[id] : undefined;
        return raw ? envelopeResponse([raw]) : new Response(null, { status: 404 });
      });
    const paths = (fetcher: ReturnType<typeof publish>) =>
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);

    it.each([
      ['A9-0188/2023', 'A-9-2023-0188'],
      ['P9_A(2023)0188', 'A-9-2023-0188'],
      ['T9-0138/2024', 'TA-9-2024-0138'],
      ['P9_TA(2024)0138', 'TA-9-2024-0138'],
      ['RC-B9-0163/2024', 'RC-9-2024-0163'],
      ['P9_OJQ(2024)03-13', 'OJQ-9-2024-03-13'],
      ['B9-0163/2024', 'B-9-2024-0163'],
      ['ta-9-2024-0138', 'TA-9-2024-0138'],
      ['t9-0138/2024', 'TA-9-2024-0138'],
    ])('reads %s as %s with one document request', async (document_id, canonical) => {
      const fetcher = publish({
        [canonical]: { id: `eli/dl/doc/${canonical}`, identifier: canonical },
      });
      const data = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { mode: 'get', document_id }),
      );
      expect(data).toMatchObject({
        found: true,
        document: { document_id: canonical },
        appliedFilters: { mode: 'get', document_id: canonical, language: 'en' },
      });
      expect(paths(fetcher)).toEqual([`/api/v2/documents/${canonical}`]);
    });

    it('reads a B citation as the question motion when no B- record is published', async () => {
      const fetcher = installToolHttp((url) => {
        if (url.pathname === '/api/v2/documents/QOB-10-2024-0104')
          return envelopeResponse([
            {
              id: 'eli/dl/doc/QOB-10-2024-0104',
              identifier: 'QOB-10-2024-0104',
              label: 'B10-0104/2024',
              work_type: 'def/ep-document-types/QUESTION_RESOLUTION_MOTION',
            },
          ]);
        if (url.pathname === '/api/v2/plenary-documents/QOB-10-2024-0104')
          return envelopeResponse([
            {
              id: 'eli/dl/doc/QOB-10-2024-0104',
              inverse_created_a_realization_of: 'eli/dl/proc/2024-2799',
            },
          ]);
        return new Response(null, { status: 404 });
      });
      const data = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { mode: 'get', document_id: 'b10-0104/2024' }),
      );
      expect(data).toMatchObject({
        found: true,
        document: {
          document_id: 'QOB-10-2024-0104',
          label: 'B10-0104/2024',
          procedure_ids: ['2024-2799'],
        },
        appliedFilters: { document_id: 'QOB-10-2024-0104' },
      });
      expect(data).not.toHaveProperty('notice');
      expect(paths(fetcher)).toEqual([
        '/api/v2/documents/B-10-2024-0104',
        '/api/v2/documents/QOB-10-2024-0104',
        '/api/v2/plenary-documents/QOB-10-2024-0104',
      ]);
    });

    it.each([
      [
        'A9-9999/2023',
        'A-9-2023-9999',
        ['/api/v2/documents/A-9-2023-9999'],
        'No document detail was published. Call euparl_search_documents in search mode to discover identifiers.',
      ],
      [
        'B9-9999/2024',
        'B-9-2024-9999',
        ['/api/v2/documents/B-9-2024-9999', '/api/v2/documents/QOB-9-2024-9999'],
        'No document detail was published as B-9-2024-9999 or QOB-9-2024-9999. Call euparl_search_documents in search mode to discover identifiers.',
      ],
    ])(
      'answers found false for the well-formed citation %s of a missing document',
      async (document_id, canonical, requested, notice) => {
        const fetcher = publish({});
        const data = expectSuccessTwin(
          await runToolContract(searchDocumentsTool, { mode: 'get', document_id }),
        );
        expect(data).toEqual({
          mode: 'get',
          found: false,
          appliedFilters: { mode: 'get', document_id: canonical, language: 'en' },
          notice,
        });
        expect(paths(fetcher)).toEqual(requested);
      },
    );

    it('fails rather than answer a B citation with a record of another identity', async () => {
      const fetcher = installToolHttp(() =>
        envelopeResponse([{ id: 'eli/dl/doc/B-9-2024-0164', identifier: 'B-9-2024-0164' }]),
      );
      const failure = await runToolContract(searchDocumentsTool, {
        mode: 'get',
        document_id: 'B9-0163/2024',
      });
      expect(failure).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.SerializationError } },
      });
      expect(contractText(failure)).toContain(
        'Parliament returned a different document identifier than requested.',
      );
      expect(paths(fetcher)).toEqual(['/api/v2/documents/B-9-2024-0163']);
    });

    const bRead = '/api/v2/documents/B-9-2024-0163';
    const qobRead = '/api/v2/documents/QOB-9-2024-0163';
    it.each([
      [bRead, 'HTTP 429', JsonRpcErrorCode.RateLimited, 3],
      [bRead, 'HTTP 503', JsonRpcErrorCode.ServiceUnavailable, 3],
      [bRead, 'HTTP 403', JsonRpcErrorCode.InvalidParams, 1],
      [bRead, 'a malformed body', JsonRpcErrorCode.SerializationError, 1],
      [qobRead, 'HTTP 429', JsonRpcErrorCode.RateLimited, 3],
      [qobRead, 'HTTP 503', JsonRpcErrorCode.ServiceUnavailable, 3],
      [qobRead, 'HTTP 403', JsonRpcErrorCode.InvalidParams, 1],
      [qobRead, 'a malformed body', JsonRpcErrorCode.SerializationError, 1],
    ] as const)(
      'fails a B citation rather than answer not found when %s answers %s',
      async (failing, answer, code, attempts) => {
        const fetcher = installToolHttp((url) =>
          url.pathname !== failing
            ? new Response(null, { status: 404 })
            : answer === 'a malformed body'
              ? new Response('{"data":[{"identifier":42}]}', { status: 200 })
              : new Response(null, { status: Number(answer.slice(5)) }),
        );
        const failure = await runToolContract(searchDocumentsTool, {
          mode: 'get',
          document_id: 'B9-0163/2024',
        });
        expect(failure).toMatchObject({ isError: true, structuredContent: { error: { code } } });
        expect(contractText(failure)).not.toContain('No document detail was published');
        expect(paths(fetcher)).toEqual([
          ...(failing === qobRead ? [bRead] : []),
          ...Array.from({ length: attempts }, () => failing),
        ]);
      },
    );

    it.each(['A9-188/2023', 'AD-PE786.674', 'E-000003/2025'])(
      'rejects %s naming document_id, the value and the accepted forms before network',
      async (document_id) => {
        const fetcher = publish({});
        const failure = await runToolContract(searchDocumentsTool, { mode: 'get', document_id });
        expectErrorTwin(failure, 'invalid_filter', documentIdHint);
        expect(contractText(failure)).toContain(
          `document_id ${JSON.stringify(document_id)} is not a document identifier or citation. Pass a canonical identifier such as TA-9-2024-0138`,
        );
        expect(contractText(failure)).toContain('P9_OJQ(2024)03-13 (agenda).');
        expect(fetcher).not.toHaveBeenCalled();
      },
    );
  });

  it('discloses fallback language and renders the effective cap, continuation and end page', async () => {
    // One row more than the cap, sliced by the requested window as the upstream does.
    const pool = Array.from({ length: 101 }, (_, i) => ({
      id: `eli/dl/doc/D-${String(i).padStart(3, '0')}`,
      title_dcterms: { en: 'Title' },
    }));
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
      page: { limit: 100, returned: 100, next_offset: 100 },
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 100 adopted texts. Continue with offset 100.',
    );
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
    expect(
      expectSuccessTwin(await runToolContract(searchDocumentsTool, { offset: 100 })),
    ).toMatchObject({
      items: [{ document_id: 'D-100' }],
      page: { offset: 100, returned: 1, has_more: false },
    });
    expect(
      expectSuccessTwin(await runToolContract(searchDocumentsTool, { offset: 500 })),
    ).toMatchObject({
      items: [],
      page: { offset: 500, returned: 0, has_more: false },
      notice:
        'The page at offset 500 returned no documents. Restart at offset 0 or return to the previous page.',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
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
    [
      { work_type: 'UNKNOWN' },
      'Call euparl_list_reference with topic document_types for every accepted code, then retry work_type with one of them.',
    ],
    [
      { language: 'xx' },
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
  ] as const)('rejects unsupported filter %j before network', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(await runToolContract(searchDocumentsTool, input), 'invalid_filter', hint);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [
      { source: 'committee', text: 'ignored' },
      'text is accepted only with source "adopted_texts", not with source "committee".',
    ],
    [
      {
        source: 'plenary',
        title: 'ignored',
        text: ' ',
        sitting_date: '2025-01-01',
        sitting_date_end: '2025-01-31',
        related_process_id: '2025-0001',
      },
      'title and related_process_id are accepted only with sources "adopted_texts" and "mep_declarations"; sitting_date and sitting_date_end are accepted only with source "adopted_texts", not with source "plenary".',
    ],
  ] as const)(
    'names the adopted-text filters %j supplied and the source they were sent with on both surfaces',
    async (input, message) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract(searchDocumentsTool, input);
      expectErrorTwin(
        result,
        'invalid_filter',
        'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
        JsonRpcErrorCode.ValidationError,
      );
      expect(result.structuredContent).toMatchObject({ error: { message } });
      expect(contractText(result)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('rejects a plenary work type on the default source naming the source that takes it', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const failure = await runToolContract(searchDocumentsTool, { work_type: 'REPORT_PLENARY' });
    expectErrorTwin(
      failure,
      'invalid_filter',
      'Retry with source "plenary" and work_type REPORT_PLENARY, or call euparl_list_reference with topic document_types for each work type and its source.',
      JsonRpcErrorCode.ValidationError,
    );
    expect(contractText(failure)).toContain(
      'Unsupported work_type filter "REPORT_PLENARY" for source adopted_texts. Accepted codes: TEXT_ADOPTED, AMENDMENT_BUDGET_EU_DRAFT, BUDGET_EP_DRAFT. REPORT_PLENARY is a document work type accepted with source "plenary".',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  describe('MEP declarations', () => {
    const awareId = 'DCI-124760-2024-12-17-425114';
    const declarationKeys = [
      'awareness_of_conflict',
      'conflict_description',
      'capacities',
      'previous_version_ids',
      'superseded_by_ids',
    ];
    const overHundred =
      'More than 100 MEP declarations match, and Parliament keeps no single order for such a set across its 100-row pages, so pages can repeat some declarations and omit others. Narrow person_id, related_process_id, title, year, term, awareness_of_conflict or work_type to 100 or fewer, which arrive whole in one request.';
    /** A `/meps-declarations` list response carrying Parliament's `meta.total`. */
    const declarationList = (data: unknown[], total: number) =>
      new Response(JSON.stringify({ data, meta: { total } }));
    /** Property names in the order the published output JSON Schema advertises them. */
    const properties = (schema: unknown) =>
      Object.keys(
        z.object({ properties: z.record(z.string(), z.unknown()) }).parse(schema).properties,
      );
    /** The advertised row and detail nodes, read inside a test so a missing node fails only it. */
    const advertised = () => {
      const { items, document } = z
        .object({
          properties: z.object({
            items: z.object({ items: z.record(z.string(), z.unknown()) }),
            document: z.record(z.string(), z.unknown()),
          }),
        })
        .parse(z.toJSONSchema(searchDocumentsTool.output)).properties;
      return {
        row: properties(items.items),
        detail: properties(document),
        capacity: properties(
          z
            .object({ properties: z.object({ capacities: z.object({ items: z.unknown() }) }) })
            .parse(items.items).properties.capacities.items,
        ),
      };
    };
    const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
    /** One upstream path per call, in call order. */
    const paths = (fetcher: ReturnType<typeof installToolHttp>) =>
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);

    it('returns the 2021/0106(COD) declaration with its capacity on both surfaces in one request', async () => {
      const fetcher = installToolHttp(() => declarationList([declarationRow], 1));
      const result = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        related_process_id: '2021/0106(COD)',
      });
      const data = expectSuccessTwin(result);
      expect(data).toMatchObject({
        source: 'mep_declarations',
        totalCount: 1,
        page: { offset: 0, returned: 1, has_more: false },
        appliedFilters: {
          source: 'mep_declarations',
          language: 'en',
          related_process_id: '2021-0106',
        },
      });
      expect(data.items).toEqual([
        {
          document_id: 'DCI-124884-2023-11-17-324583',
          identifier: 'DCI-124884-2023-11-17-324583',
          label: 'DCI-124884-2023-11-17-324583',
          work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
          source_url: 'https://data.europarl.europa.eu/eli/dl/doc/DCI-124884-2023-11-17-324583',
          title: { value: declarationRow.title_dcterms.en, language: 'en' },
          date: '2023-11-17',
          procedure_ids: ['2021-0106'],
          awareness_of_conflict: false,
          capacities: [
            {
              person_ids: ['124884'],
              role: 'def/ep-roles/RAPPORTEUR_SHADOW_REPORT',
              organization_id: 'org/IMCO',
              procedure_id: '2021-0106',
              activity_label: '2021/0106(COD)  Artificial Intelligence Act',
              political_group_id: 'org/ECR',
            },
          ],
        },
      ]);
      const text = contractText(result);
      expect(text).toContain('result.items[0].awareness_of_conflict: false');
      expect(text).toContain(
        'result.items[0].capacities[0].activity_label: ` "2021/0106(COD)  Artificial Intelligence Act" `',
      );
      // One match is never disclosed as able to repeat or omit declarations.
      expect(text).not.toContain('More than 100 MEP declarations match');
      expect(paths(fetcher)).toEqual(['/api/v2/meps-declarations']);
      expect(
        new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('related-process-id'),
      ).toBe('2021-0106');
    });

    it('links a superseded declaration pair both ways and sends awareness_of_conflict false as a filter', async () => {
      const fetcher = installToolHttp(() => declarationList(supersededDeclarationRows, 2));
      const result = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        person_id: 'person/124867',
        awareness_of_conflict: false,
      });
      const data = expectSuccessTwin(result);
      expect(data.appliedFilters).toMatchObject({
        person_id: '124867',
        awareness_of_conflict: false,
      });
      const [replaced, replacing] = z.array(z.record(z.string(), z.unknown())).parse(data.items);
      expect(replaced).toMatchObject({
        document_id: 'DCI-124867-2026-02-27-538194',
        procedure_ids: [],
        awareness_of_conflict: false,
        // An official-delegation capacity names no procedure.
        capacities: [
          {
            person_ids: ['124867'],
            role: 'def/ep-roles/MEMBER_DELEGATION_OFFICIAL',
            organization_id: 'org/JURI',
            political_group_id: 'org/S-D',
          },
        ],
        superseded_by_ids: ['DCI-124867-2026-03-12-540997'],
      });
      expect(replaced).not.toHaveProperty('previous_version_ids');
      expect(record(z.array(z.unknown()).parse(replaced?.capacities)[0])).not.toHaveProperty(
        'procedure_id',
      );
      expect(replacing).toMatchObject({
        document_id: 'DCI-124867-2026-03-12-540997',
        previous_version_ids: ['DCI-124867-2026-02-27-538194'],
      });
      expect(replacing).not.toHaveProperty('superseded_by_ids');
      const text = contractText(result);
      expect(text).toContain(
        'result.items[0].superseded_by_ids[0]: ` "DCI-124867-2026-03-12-540997" `',
      );
      expect(text).toContain(
        'result.items[1].previous_version_ids[0]: ` "DCI-124867-2026-02-27-538194" `',
      );
      const query = new URL(String(fetcher.mock.calls[0]?.[0])).searchParams;
      expect([query.get('person-id'), query.get('filter-output')]).toEqual([
        '124867',
        'no-awareness-of-conflict',
      ]);
    });

    it('reads aligned 100-row pages in document_id order and discloses repeat and omit past 100 matches', async () => {
      const ids = Array.from(
        { length: 100 },
        (_, i) => `DCI-900001-2024-01-01-${String(i).padStart(3, '0')}`,
      );
      // Parliament returns a page's rows in no fixed order.
      const fetcher = installToolHttp(() =>
        declarationList(
          ids.toReversed().map((id) => ({
            id: `eli/dl/doc/${id}`,
            identifier: id,
            title_dcterms: { en: `Declaration ${id}` },
          })),
          150,
        ),
      );
      const result = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        year: 2024,
        offset: 20,
        limit: 20,
      });
      const data = expectSuccessTwin(result);
      expect(
        z
          .array(z.object({ document_id: z.string() }))
          .parse(data.items)
          .map((item) => item.document_id),
      ).toEqual(ids.slice(20, 40));
      expect(data).toMatchObject({
        totalCount: 150,
        truncated: true,
        page: { offset: 20, limit: 20, returned: 20, has_more: true, next_offset: 40 },
      });
      expect(data.notice).toBe(`${overHundred} Continue with offset 40.`);
      expect(contractText(result)).toContain(`${overHundred} Continue with offset 40.`);
      const query = new URL(String(fetcher.mock.calls[0]?.[0])).searchParams;
      expect([query.get('offset'), query.get('limit'), query.get('year')]).toEqual([
        '0',
        '100',
        '2024',
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('reports an unfiltered capped total without totalCount and rejects offset 10000 before HTTP', async () => {
      const fetcher = installToolHttp(() =>
        declarationList(
          Array.from({ length: 100 }, (_, i) => ({ id: `eli/dl/doc/DCI-900001-2024-01-01-${i}` })),
          10000,
        ),
      );
      const capped = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, { source: 'mep_declarations' }),
      );
      expect(capped).not.toHaveProperty('totalCount');
      expect(capped.notice).toContain(
        'The upstream total is capped: at least 10000 results match; the exact total is unknown.',
      );
      expect(capped.notice).toContain(overHundred);
      const window = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        offset: 10000,
      });
      expectErrorTwin(
        window,
        'invalid_filter',
        'Narrow person_id, related_process_id, title, year, term, awareness_of_conflict or work_type. Restart paging at offset 0 after narrowing.',
        JsonRpcErrorCode.ValidationError,
      );
      expect(contractText(window)).toContain(
        'This search exposes at most 10000 results; offset 10000 is past the window.',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('says no declaration matched on an empty first page', async () => {
      installToolHttp(() => declarationList([], 0));
      const empty = expectSuccessTwin(
        await runToolContract(searchDocumentsTool, {
          source: 'mep_declarations',
          title: 'NOBODY',
        }),
      );
      expect(empty).toMatchObject({ items: [], page: { returned: 0, has_more: false } });
      expect(empty.notice).toBe(
        'No MEP declarations matched. Remove a named filter, or select by person_id or related_process_id; title matches the member name, capacity, committee and procedure a declaration title carries.',
      );
    });

    describe(`document get of ${awareId}`, () => {
      const install = (family: () => Response) =>
        installToolHttp((url) =>
          url.pathname === `/api/v2/documents/${awareId}`
            ? envelopeResponse([awareDeclarationRecord])
            : family(),
        );
      const get = () => runToolContract(searchDocumentsTool, { mode: 'get', document_id: awareId });
      const declared = {
        document_id: awareId,
        procedure_ids: ['2021-0387'],
        awareness_of_conflict: true,
        conflict_description: awareDeclarationRecord.conflictDescription,
      };

      it('adds what was declared and the capacity from a second read, in advertised order, on both surfaces', async () => {
        const fetcher = install(() => envelopeResponse([awareDeclarationFamilyRecord]));
        const result = await get();
        const data = expectSuccessTwin(result);
        expect(data).toMatchObject({
          found: true,
          document: {
            ...declared,
            capacities: [
              {
                person_ids: ['124760'],
                role: 'def/ep-roles/RAPPORTEUR',
                organization_id: 'org/LIBE',
                procedure_id: '2021-0387',
                activity_label:
                  awareDeclarationFamilyRecord.workHadParticipation[0]?.inCapacityOf
                    .capacityActivityLabel,
                political_group_id: 'org/ECR',
              },
            ],
          },
        });
        const document = record(data.document);
        expect(document.conflict_description).toMatch(
          /^J'ai été désigné par le Conseil régional de Normandie/,
        );
        expect(document).not.toHaveProperty('previous_version_ids');
        expect(document).not.toHaveProperty('superseded_by_ids');
        const order = advertised().detail.filter((key) => key in document);
        expect(Object.keys(document)).toEqual(order);
        expect(renderedKeys(result, 'result.document.')).toEqual(order);
        expect(contractText(result)).toContain('result.document.awareness_of_conflict: true');
        expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
          expect.stringMatching(
            /^https:\/\/data\.europarl\.europa\.eu\/api\/v2\/documents\/DCI-124760-2024-12-17-425114\?/,
          ),
          'https://data.europarl.europa.eu/api/v2/meps-declarations/DCI-124760-2024-12-17-425114?format=application%2Fld%2Bjson',
        ]);
      });

      it('keeps what was declared and names the missing relations when the declaration record read fails', async () => {
        const fetcher = install(() => new Response(null, { status: 503 }));
        const result = await get();
        const data = expectSuccessTwin(result);
        expect(data).toMatchObject({ found: true, document: declared });
        for (const key of ['capacities', 'previous_version_ids', 'superseded_by_ids'])
          expect(data.document).not.toHaveProperty(key);
        const notice =
          "The declarant's capacities and version links could not be read from the mep_declarations family record of this document, so capacities, previous_version_ids and superseded_by_ids are absent; repeat the same get to retry.";
        expect(data.notice).toContain(notice);
        expect(contractText(result)).toContain(notice);
        expect(fetcher).toHaveBeenCalledTimes(2);
      });
    });

    const misplaced =
      'Use source mep_declarations for person_id or awareness_of_conflict, or remove those filters.';
    const adoptedOnly = (key: string) =>
      `Remove ${key} for source mep_declarations and narrow by year, or by title, which matches the member, capacity, committee and procedure a declaration title names; text and sitting dates search source adopted_texts.`;
    it.each([
      [
        { source: 'committee', awareness_of_conflict: false },
        'invalid_filter',
        'awareness_of_conflict is accepted only with source "mep_declarations", not with source "committee".',
        misplaced,
      ],
      [
        { person_id: '124867' },
        'invalid_filter',
        'person_id is accepted only with source "mep_declarations", not with source "adopted_texts".',
        misplaced,
      ],
      [
        { source: 'mep_declarations', text: 'LOISEAU' },
        'invalid_filter',
        'text is accepted only with source "adopted_texts", not with source "mep_declarations".',
        adoptedOnly('text'),
      ],
      [
        { source: 'mep_declarations', sitting_date: '2025-01-01' },
        'invalid_filter',
        'sitting_date is accepted only with source "adopted_texts", not with source "mep_declarations".',
        adoptedOnly('sitting_date'),
      ],
      // The date pairing is checked before the source, so sitting_date_end alone fails on it.
      [
        { source: 'mep_declarations', sitting_date_end: '2025-01-31' },
        'invalid_filter',
        'sitting_date_end "2025-01-31" needs a sitting_date on or before it, but sitting_date was not supplied.',
        'Pass sitting_date with sitting_date_end, on or before it.',
      ],
      [
        { source: 'mep_declarations', sitting_date: '2025-01-01', sitting_date_end: '2025-01-31' },
        'invalid_filter',
        'sitting_date and sitting_date_end are accepted only with source "adopted_texts", not with source "mep_declarations".',
        adoptedOnly('sitting_date and sitting_date_end'),
      ],
      [
        { source: 'adopted_texts', awareness_of_conflict: true },
        'invalid_filter',
        'awareness_of_conflict is accepted only with source "mep_declarations", not with source "adopted_texts".',
        misplaced,
      ],
      [
        { source: 'mep_declarations', term: 10, person_id: '124867' },
        'invalid_filter',
        'term and person_id cannot be combined with source "mep_declarations": Parliament matches no declaration for a member within a parliamentary term. Each is accepted without the other.',
        "Remove term and narrow the member's declarations by year, or remove person_id to list the term's declarations.",
      ],
      [
        { mode: 'get', document_id: awareId, awareness_of_conflict: false },
        'invalid_mode_fields',
        'awareness_of_conflict is not supported in this mode.',
        'Remove awareness_of_conflict, or select a mode that accepts awareness_of_conflict.',
      ],
    ] as const)(
      'rejects %j before HTTP naming the parameter as written',
      async (input, reason, message, hint) => {
        const fetcher = installToolHttp(() => declarationList([declarationRow], 1));
        const failure = await runToolContract(searchDocumentsTool, input);
        expectErrorTwin(failure, reason, hint, JsonRpcErrorCode.ValidationError);
        expect(failure.structuredContent).toMatchObject({ error: { message } });
        expect(contractText(failure)).toContain(message);
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it('routes the declaration work type to source mep_declarations, which sends it', async () => {
      const fetcher = installToolHttp(() => declarationList([declarationRow], 1));
      const rejected = await runToolContract(searchDocumentsTool, {
        work_type: 'MEMBER_DECLARATION_INTEREST_CONFLICT',
      });
      expectErrorTwin(
        rejected,
        'invalid_filter',
        'Retry with source "mep_declarations" and work_type MEMBER_DECLARATION_INTEREST_CONFLICT, or call euparl_list_reference with topic document_types for each work type and its source.',
        JsonRpcErrorCode.ValidationError,
      );
      expect(contractText(rejected)).toContain(
        'MEMBER_DECLARATION_INTEREST_CONFLICT is a document work type accepted with source "mep_declarations".',
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        expectSuccessTwin(
          await runToolContract(searchDocumentsTool, {
            source: 'mep_declarations',
            work_type: ' member_declaration_interest_conflict ',
          }),
        ).appliedFilters,
      ).toMatchObject({ work_type: 'MEMBER_DECLARATION_INTEREST_CONFLICT' });
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('work-type')).toBe(
        'MEMBER_DECLARATION_INTEREST_CONFLICT',
      );
    });

    it('orders every declaration row and capacity key as the output schema advertises', async () => {
      installToolHttp(() =>
        declarationList(
          [
            {
              ...declarationRow,
              awarenessOfConflict: true,
              conflictDescription: 'Example declared conflict.',
              previousVersion: ['eli/dl/doc/DCI-124884-2023-11-10-300001'],
              inverse_previousVersion: ['eli/dl/doc/DCI-124884-2023-12-01-300002'],
            },
          ],
          1,
        ),
      );
      const result = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        related_process_id: '2021-0106',
      });
      const [row] = z
        .array(z.record(z.string(), z.unknown()))
        .parse(expectSuccessTwin(result).items);
      // The row carries every key the schema advertises, so the full advertised order is compared.
      const order = advertised();
      expect(Object.keys(row!)).toEqual(order.row);
      expect(renderedKeys(result, 'result.items[0].')).toEqual(order.row);
      expect(Object.keys(record(z.array(z.unknown()).parse(row!.capacities)[0]))).toEqual(
        order.capacity,
      );
      expect(renderedKeys(result, 'result.items[0].capacities[0].')).toEqual(order.capacity);
    });

    it('adds no declaration key to rows and details of other sources and work types', async () => {
      // Declaration-shaped relations on other families' records, which only a declaration reads.
      const relations = {
        workHadParticipation: declarationRow.workHadParticipation,
        previousVersion: ['eli/dl/doc/TA-9-2024-0137'],
        inverse_previousVersion: ['eli/dl/doc/TA-9-2024-0139'],
      };
      const adoptedText = {
        id: 'eli/dl/doc/TA-9-2024-0138',
        identifier: 'TA-9-2024-0138',
        work_type: 'def/ep-document-types/TEXT_ADOPTED',
        title_dcterms: { en: 'Artificial Intelligence Act' },
        document_date: '2024-03-13',
        inverse_created_a_realization_of: ['eli/dl/proc/2021-0106'],
        ...relations,
      };
      const fetcher = installToolHttp((url) => {
        if (url.pathname === '/api/v2/documents/TA-9-2024-0138')
          return envelopeResponse([adoptedText]);
        if (url.pathname.startsWith('/api/v2/documents/'))
          return envelopeResponse([{ ...documentRecord, ...relations }]);
        if (url.pathname.startsWith('/api/v2/adopted-texts/'))
          return envelopeResponse([adoptedText]);
        if (url.pathname.startsWith('/api/v2/committee-documents/'))
          return envelopeResponse([{ id: documentRecord.id, ...relations }]);
        return envelopeResponse([adoptedText, { ...documentRecord, ...relations }]);
      });
      const leaked = (value: unknown) => declarationKeys.filter((key) => key in record(value));
      for (const input of [
        {},
        { source: 'committee' },
        { source: 'plenary' },
        { mode: 'get', document_id: 'TA-9-2024-0138' },
        { mode: 'get', document_id: documentRecord.id },
      ] as const) {
        const result = await runToolContract(searchDocumentsTool, input);
        const data = expectSuccessTwin(result);
        const records = data.items ? z.array(z.unknown()).parse(data.items) : [data.document];
        expect(records.length, JSON.stringify(input)).toBeGreaterThan(0);
        expect(records.flatMap(leaked), JSON.stringify(input)).toEqual([]);
        for (const key of declarationKeys)
          expect(contractText(result), JSON.stringify(input)).not.toContain(`.${key}`);
      }
      expect(paths(fetcher).filter((path) => path.includes('meps-declarations'))).toEqual([]);
    });
  });

  it.each([
    [
      { sitting_date: '2024-02-30', sitting_date_end: '2024-03-01' },
      'sitting_date "2024-02-30" is not a real calendar date in YYYY-MM-DD form.',
      'Pass an existing calendar day as YYYY-MM-DD.',
    ],
    [
      { related_process_id: '2021-106' },
      'related_process_id "2021-106" is not a procedure identifier. Accepted forms: YYYY-NNNN or YYYY/NNNN with an optional letter suffix and (TYPE), such as 2021-0106 or 2021/0106(COD), bare, after eli/dl/proc/, or in the exact https://data.europarl.europa.eu/eli/dl/proc/ URI.',
      'Call euparl_list_procedures for procedure_id values, then retry with one as related_process_id.',
    ],
  ] as const)(
    'names the parameter and value of %j before network',
    async (input, message, hint) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const failure = await runToolContract(searchDocumentsTool, input);
      expectErrorTwin(failure, 'invalid_filter', hint, JsonRpcErrorCode.ValidationError);
      expect(contractText(failure)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('fails an adopted-text row with a malformed identifier as a Parliament serialization failure naming no input', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'eli/dl/doc/TA-9-2024-0138',
          identifier: 'TA 9 2024 0138',
          work_type: 'def/ep-document-types/TEXT_ADOPTED',
          inverse_created_a_realization_of: ['eli/dl/proc/2021-0106'],
        },
      ]),
    );
    const failure = await runToolContract(searchDocumentsTool, { text: 'artificial intelligence' });
    const { error } = z
      .object({
        error: z.object({
          code: z.number(),
          message: z.string(),
          data: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(failure.structuredContent);
    expect(failure.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data.reason).toBeUndefined();
    expect(error.message).toBe(
      'Parliament returned a record with a malformed document identifier "TA 9 2024 0138".',
    );
    for (const parameter of Object.keys(searchDocumentsTool.input.shape))
      expect(error.message).not.toMatch(new RegExp(`\\b${parameter}\\b`));
    expect(contractText(failure)).toContain(error.message);
  });

  describe('a malformed procedure reference on DCI-197467-2024-03-21-357272', () => {
    const dci = 'DCI-197467-2024-03-21-357272';
    const skipped =
      'Parliament publishes procedure references that are not procedure identifiers (YYYY-NNNN), so no procedure ID is returned for them: "eli/dl/proc/2023-02735" on DCI-197467-2024-03-21-357272.';
    // content[] renders a string holding quotes JSON-quoted.
    const rendered = JSON.stringify(skipped).slice(1, -1);
    const capacity = {
      person_ids: ['197467'],
      role: 'def/ep-roles/RAPPORTEUR_SHADOW_REPORT',
      organization_id: 'org/INTA',
      activity_label:
        'Terugtrekking van de Unie uit het Verdrag inzake het energiehandvest 2023/02735(NLE)',
      political_group_id: 'org/ECR',
    };

    it('returns the declaration row without the procedure, with one notice on both surfaces', async () => {
      const fetcher = installToolHttp(
        () =>
          new Response(
            JSON.stringify({ data: [malformedProcedureDeclaration], meta: { total: 1 } }),
          ),
      );
      const result = await runToolContract(searchDocumentsTool, {
        source: 'mep_declarations',
        person_id: '197467',
      });
      const data = expectSuccessTwin(result);
      expect(data.items).toEqual([
        {
          document_id: dci,
          identifier: dci,
          label: dci,
          work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
          source_url: `https://data.europarl.europa.eu/eli/dl/doc/${dci}`,
          title: { value: malformedProcedureDeclaration.title_dcterms.en, language: 'en' },
          date: '2024-03-21',
          procedure_ids: [],
          awareness_of_conflict: false,
          capacities: [capacity],
        },
      ]);
      expect(data.notice).toBe(skipped);
      const text = contractText(result);
      expect(text).toContain('result.items[0].procedure_ids: []');
      expect(text).not.toContain('result.items[0].capacities[0].procedure_id');
      expect(text.split(rendered)).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('reads the declaration without the procedure from both records, with one notice on both surfaces', async () => {
      const fetcher = installToolHttp((url) =>
        envelopeResponse([
          url.pathname === `/api/v2/documents/${dci}`
            ? malformedProcedureDeclarationRecord
            : malformedProcedureDeclaration,
        ]),
      );
      const result = await runToolContract(searchDocumentsTool, { mode: 'get', document_id: dci });
      const data = expectSuccessTwin(result);
      expect(data).toMatchObject({
        found: true,
        document: { document_id: dci, procedure_ids: [], capacities: [capacity] },
      });
      const files = 'Requested file language en unavailable; returned published nl files.';
      expect(data.notice).toBe(`${skipped} ${files}`);
      expect(contractText(result).split(rendered)).toHaveLength(2);
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        `/api/v2/documents/${dci}`,
        `/api/v2/meps-declarations/${dci}`,
      ]);
    });
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
      'Unknown key snapshot. This tool accepts: mode, source, document_id, text, title, year, term, work_type, sitting_date, sitting_date_end, related_process_id, person_id, awareness_of_conflict, offset, limit, language.',
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

  describe('limit with EUPARL_CLAMP_LIMITS=false', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      initServerConfig();
    });
    function strictMode(): void {
      vi.stubEnv('EUPARL_CLAMP_LIMITS', 'false');
      initServerConfig();
    }
    /** A 3000-row family listing sliced by the requested offset and limit, as Parliament serves it. */
    function installListing() {
      const pool = Array.from({ length: 3000 }, (_, i) => `D-9-2020-${String(i).padStart(4, '0')}`);
      return installToolHttp((url) => {
        const offset = Number(url.searchParams.get('offset'));
        const rows = pool.slice(offset, offset + Number(url.searchParams.get('limit')));
        return new Response(
          JSON.stringify({
            data: rows.map((id) => ({
              id: `eli/dl/doc/${id}`,
              identifier: id,
              title_dcterms: { en: `Title ${id}` },
            })),
            meta: { total: pool.length },
          }),
        );
      });
    }
    const keyword =
      'Keyword searches retain upstream relevance order; pages can repeat or omit records as ordering changes.';
    const shapes = [
      [
        'adopted texts sorted',
        {},
        100,
        'Requested limit normalized to the effective maximum of 100 adopted texts.',
      ],
      [
        'adopted texts with a keyword',
        { text: 'budget' },
        100,
        `Requested limit normalized to the effective maximum of 100 keyword adopted texts. ${keyword}`,
      ],
      [
        'source committee',
        { source: 'committee' },
        1000,
        'Requested limit normalized to the effective maximum of 1000 documents.',
      ],
      [
        'source plenary',
        { source: 'plenary' },
        1000,
        'Requested limit normalized to the effective maximum of 1000 documents.',
      ],
    ] as const;

    it.each(
      shapes.flatMap(([shape, scope, bound, notice]) =>
        [1001, 5000, 10000].map((limit) => ({ shape, limit, scope, bound, notice })),
      ),
    )(
      'answers $shape at limit $limit with $bound rows, the normalization notice and next_offset',
      async ({ limit, scope, bound, notice }) => {
        strictMode();
        const fetcher = installListing();
        const result = await runToolContract(searchDocumentsTool, { ...scope, limit });
        const data = expectSuccessTwin(result);
        expect(data.items).toHaveLength(bound);
        expect(data.page).toEqual({
          offset: 0,
          limit: bound,
          returned: bound,
          has_more: true,
          next_offset: bound,
        });
        expect(data).toMatchObject({ truncated: true, shown: bound, cap: bound, totalCount: 3000 });
        expect(data.notice).toBe(`${notice} Continue with offset ${bound}.`);
        const text = contractText(result);
        expect(text).toContain(`${notice} Continue with offset ${bound}.`);
        expect(text).toContain(`result.page.next_offset: ${bound}`);
        expect(text).toContain(`result.page.returned: ${bound}`);
        expect(text).toContain(`result.items[${bound - 1}].document_id: \` "D-9-2020-`);
        expect(text).not.toContain(`result.items[${bound}].`);
        const sent = fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams);
        expect(sent.map((query) => [query.get('offset'), query.get('limit')])).toEqual([
          ['0', String(bound)],
        ]);
      },
    );
    it.each(shapes)('rejects %s at limit 10001 before HTTP', async (_, scope) => {
      strictMode();
      const fetcher = installListing();
      const rejected = await runToolContract(searchDocumentsTool, { ...scope, limit: 10001 });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      expect(contractText(rejected)).toContain('Too big: expected number to be <=10000');
      expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(shapes)(
      'keeps answering %s at limit 10001 by default with the same page',
      async (_, scope, bound, notice) => {
        const fetcher = installListing();
        const data = expectSuccessTwin(
          await runToolContract(searchDocumentsTool, { ...scope, limit: 10001 }),
        );
        expect(data).toMatchObject({
          page: { limit: bound, returned: bound, next_offset: bound },
          notice: `${notice} Continue with offset ${bound}.`,
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );
  });
});
