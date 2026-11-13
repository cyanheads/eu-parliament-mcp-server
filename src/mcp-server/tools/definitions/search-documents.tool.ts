/**
 * @fileoverview Document family discovery and generic source-file detail retrieval.
 * @module mcp-server/tools/definitions/search-documents.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyEnrichment,
  enrichmentFields,
  enrichmentTrailer,
  formatResult,
  linkSchema,
  localizedTextSchema,
  optionalString,
  pageSchema,
  pagingInputFields,
  serviceInput,
} from '@/mcp-server/tools/utils/eu-parliament-tool.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const documentSummarySchema = z
  .object({
    document_id: z
      .string()
      .describe('Canonical work identifier accepted by document get regardless of family.'),
    identifier: z.string().optional().describe('Original published work identifier.'),
    label: z
      .string()
      .optional()
      .describe('Exact published label, when available in the catalogue.'),
    work_type: z.string().optional().describe('Published work-type code or URI.'),
    source_url: z.string().describe('Public linked-data source URL for this work.'),
    title: localizedTextSchema
      .optional()
      .describe(
        'Adopted-text rows only: published title in the requested language, the only one the list returns; absent when the row has none (the notice counts them; mode get reads a title in another language).',
      ),
    date: z.string().optional().describe('Adopted-text rows only: published document date.'),
    procedure_ids: z
      .array(z.string().describe('Canonical procedure identifier.'))
      .optional()
      .describe(
        'Adopted-text rows only: procedures named by the published family relation, canonical, in published order, sitting events left out, as detail reads them. Use euparl_get_procedure.',
      ),
  })
  .strict()
  .describe(
    'Document discovery record. Adopted-text rows add title, date and procedure_ids; committee and plenary rows carry identity only, so their title and date need mode get.',
  );
// Output keys follow schema order, and .extend() keeps a redeclared key at its base position.
const documentDetailSchema = documentSummarySchema
  .omit({ title: true, date: true, procedure_ids: true })
  .extend({
    title: localizedTextSchema
      .optional()
      .describe('Published title and its actual selected language.'),
    date: z.string().optional().describe('Published document date.'),
    term_id: z.string().optional().describe('Published parliamentary-term reference.'),
    creator_ids: z
      .array(z.string().describe('Published creator reference.'))
      .describe('All published creator references, without inferred authorship.'),
    procedure_ids: z
      .array(z.string().describe('Canonical related procedure identifier.'))
      .describe(
        'Procedure IDs from explicit source relations, then those an adopted text, plenary or committee document publishes on its family record, without repeats; use euparl_get_procedure.',
      ),
    parent_document_ids: z
      .array(z.string().describe('Canonical parent work identifier.'))
      .describe(
        'Explicit parent documents; retrieve with this tool in get mode when a subdivision lacks files.',
      ),
    adopted_document_ids: z
      .array(z.string().describe('Canonical adopted document identifier.'))
      .describe(
        'Explicit adopted document relations in published order; targets can be retrieved with mode get but may be unavailable upstream.',
      ),
    based_on_document_ids: z
      .array(z.string().describe('Canonical source document identifier.'))
      .describe(
        'Explicit based-on document relations in published order; no procedure relationship is inferred.',
      ),
    public_register_ref: z
      .string()
      .optional()
      .describe('Published public-register notation, preserved verbatim; absent when unpublished.'),
    links: z
      .array(linkSchema)
      .describe('Every source-file link in the selected expression language, preserving metadata.'),
  })
  .strict()
  .describe('Published work metadata and file links, without extracted document body.');

/** Discover documents by family or retrieve any canonical work ID. */
export const searchDocumentsTool = tool('euparl_search_documents', {
  title: 'Search parliamentary documents',
  description:
    'Search adopted texts, committee documents, or plenary documents, then retrieve metadata and source-file links with mode get and document_id. Get accepts IDs from procedures, speeches, votes, questions and answers without a source family; parent_document_ids lead from subdivisions to parent files. Detail preserves adopted_document_ids, based_on_document_ids and public_register_ref; follow published document relations with mode get, while preserving ordinary missing-record and upstream-error outcomes for unavailable targets. Detail procedure_ids also read the procedure an adopted text, plenary or committee document publishes on its family record; adopted and based-on document relations never imply procedure links. Only adopted_texts supports text, title, sitting dates and related_process_id. Committee supports term but no year; plenary supports year but no term. Use euparl_list_reference topic document_types for family-specific work_type codes. Detail returns links, not extracted full text. Adopted-text rows carry title in the requested language, date and procedure_ids; committee and plenary rows carry identity only. An adopted-text page holds at most 100 rows. Non-keyword adopted texts use doc-id:asc and aligned 100-row upstream pages independently of caller limit. Keyword searches retain relevance order and can repeat or omit records across pages. Adopted texts expose at most 10000 search results; continue with page.next_offset when present, otherwise narrow supported filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: z
        .enum(['search', 'get'])
        .default('search')
        .describe(
          'Default search discovers records; get requires document_id and rejects source and all search filters.',
        ),
      source: z
        .enum(['adopted_texts', 'committee', 'plenary'])
        .optional()
        .describe(
          'Search-only family; omitted search defaults to adopted_texts. Omit entirely in get mode.',
        ),
      document_id: optionalString().describe(
        'Get-only work ID from any tool, no family restriction: canonical ID (TA-9-2024-0138), eli/dl/doc/ prefix or exact public URI, in any letter case, or a returned citation (label, public_register_ref or decision label): T9-0138/2024, P9_TA(2024)0138, A9-0188/2023, P9_A(2023)0188, B9-0163/2024 (read as B-, else the QOB- question motion), RC-B9-0163/2024 or P9_OJQ(2024)03-13. Question citations belong to euparl_list_questions.',
      ),
      text: optionalString().describe(
        'Adopted-texts-only keyword search in the requested language.',
      ),
      title: optionalString().describe(
        'Adopted-texts-only title search in the requested language.',
      ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Four-digit document year; adopted_texts and plenary search only.'),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Parliamentary term 0–10; adopted_texts and committee search only.'),
      work_type: optionalString().describe(
        'Search-only family-specific code from euparl_list_reference topic document_types; case-insensitive and whitespace-trimmed.',
      ),
      sitting_date: optionalString().describe(
        'Adopted-texts-only sitting date YYYY-MM-DD; start of range when sitting_date_end is supplied.',
      ),
      sitting_date_end: optionalString().describe(
        'Adopted-texts-only inclusive range end YYYY-MM-DD; requires sitting_date and must not precede it.',
      ),
      related_process_id: optionalString().describe(
        'Adopted-texts-only procedure reference YYYY-NNNN, YYYY/NNNN(TYPE), known prefix or public URI.',
      ),
      ...pagingInputFields('documents', 'adopted_documents', 'keyword_documents'),
    })
    .strict(),
  output: z
    .object({
      mode: z.enum(['search', 'get']).describe('Executed retrieval mode.'),
      source: z
        .enum(['adopted_texts', 'committee', 'plenary'])
        .optional()
        .describe('Effective family in search mode; absent in generic get.'),
      items: z
        .array(documentSummarySchema)
        .optional()
        .describe('Whole sparse records on a search page; absent in get mode.'),
      page: pageSchema.optional().describe('Search continuation metadata; absent in get mode.'),
      found: z
        .boolean()
        .optional()
        .describe('Get-only publication result; false for missing or empty detail.'),
      document: documentDetailSchema
        .optional()
        .describe('Present only when get finds published detail.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A code, identifier, language, date range or source-specific filter is unsupported, or an adopted-text offset is 10000 or more, past the 10000-result search window.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Get lacks document_id, mixes search filters, or uses nondefault paging; search supplies document_id.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Parliament rejects validated request parameters.',
      recovery:
        'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Parliament rate limits persist after bounded retries.',
      retryable: true,
      recovery: 'Wait for the reported retry interval, then repeat the same euparl tool call.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const result = await getEuParliamentService().searchDocuments(serviceInput(input), ctx);
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? result.data.page : undefined,
    );
    return result.data;
  },
  format: ({ mode, source, items, page, found, document }) =>
    formatResult(serviceInput({ mode, source, items, page, found, document })),
});
