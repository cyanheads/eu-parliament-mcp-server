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
  })
  .strict()
  .describe('Sparse document discovery record; title and dates require detail retrieval.');
const documentDetailSchema = documentSummarySchema
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
      .describe('Procedure IDs from explicit source relationships; use euparl_get_procedure.'),
    parent_document_ids: z
      .array(z.string().describe('Canonical parent work identifier.'))
      .describe(
        'Explicit parent documents; retrieve with this tool in get mode when a subdivision lacks files.',
      ),
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
    'Search adopted texts, committee documents, or plenary documents, then retrieve metadata and source-file links with mode get and document_id. Get accepts IDs from procedures, speeches, votes, questions and answers without a source family; parent_document_ids lead from subdivisions to parent files. Only adopted_texts supports text, title, sitting dates and related_process_id. Committee supports term but no year; plenary supports year but no term. Use euparl_list_reference topic document_types for family-specific work_type codes. Detail returns links, not extracted full text; continue search with page.next_offset.',
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
        'Get-only canonical work ID, eli/dl/doc/ prefix or exact public URI; no family restriction.',
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
      ...pagingInputFields,
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
      when: 'A code, identifier, language, date range or source-specific filter is unsupported.',
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
    ctx.enrich({ appliedFilters: result.enrichment.appliedFilters });
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
