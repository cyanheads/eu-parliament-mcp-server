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
  localizedTitleSchema,
  optionalString,
  pageSchema,
  pagingInputFields,
  serviceInput,
} from '@/mcp-server/tools/utils/eu-parliament-tool.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

/** One capacity an MEP declared in, from a participation of the declaration record. */
const capacitySchema = z
  .object({
    person_ids: z
      .array(z.string().describe('Person ID for euparl_get_mep.'))
      .describe('Declarant person IDs, in published order.'),
    role: z
      .string()
      .optional()
      .describe('Published role code, verbatim, such as def/ep-roles/RAPPORTEUR.'),
    organization_id: z
      .string()
      .optional()
      .describe('Published committee or body, verbatim, such as org/LIBE.'),
    procedure_id: z.string().optional().describe('Procedure ID for euparl_get_procedure.'),
    activity_label: z.string().optional().describe('Published activity label, verbatim.'),
    political_group_id: z
      .string()
      .optional()
      .describe('Published political group in this capacity, verbatim.'),
  })
  .strict()
  .describe('One declared capacity; each field only when published.');
const capacities = (scope: string) =>
  z
    .array(capacitySchema)
    .optional()
    .describe(
      `${scope}: one capacity per published participation, in published order; absent when none.`,
    );
const versionIds = (scope: string, relation: string) =>
  z
    .array(z.string().describe('Declaration document ID.'))
    .optional()
    .describe(`${scope}: ${relation}; absent when unpublished; read with mode get.`);
const rowScope = 'Declaration rows only';
const detailScope = 'Declaration detail only, from the declaration record';

const documentSummarySchema = z
  .object({
    document_id: z.string().describe('Work ID for mode get.'),
    identifier: z.string().optional().describe('Original published work identifier.'),
    label: z.string().optional().describe('Published label, when catalogued.'),
    work_type: z.string().optional().describe('Published work-type code or URI.'),
    source_url: z.string().describe('Public linked-data source URL.'),
    title: localizedTitleSchema
      .optional()
      .describe(
        'Adopted-text and declaration rows only: title in the requested language, the only one a list returns; absent when the row has none (the notice counts them; mode get reads other languages).',
      ),
    date: z.string().optional().describe('Adopted-text and declaration rows only: published date.'),
    procedure_ids: z
      .array(z.string().describe('Procedure ID.'))
      .optional()
      .describe(
        "Adopted-text and declaration rows only: procedures named by an adopted text's family relation (sitting events left out) or a declaration's refers-to relation, in published order, as detail reads them; use euparl_get_procedure.",
      ),
    awareness_of_conflict: z
      .boolean()
      .optional()
      .describe(`${rowScope}: whether the member declared awareness of a conflict of interest.`),
    conflict_description: z
      .string()
      .optional()
      .describe(
        `${rowScope}: the member's published description of the conflict, verbatim in the language filed; absent when none.`,
      ),
    capacities: capacities(rowScope),
    previous_version_ids: versionIds(rowScope, 'declarations this one replaces'),
    superseded_by_ids: versionIds(rowScope, 'declarations replacing this one'),
  })
  .strict()
  .describe('Document discovery record.');
// Output keys follow schema order, and .extend() keeps a redeclared key at its base position.
const documentDetailSchema = documentSummarySchema
  .omit({
    title: true,
    date: true,
    procedure_ids: true,
    awareness_of_conflict: true,
    conflict_description: true,
    capacities: true,
    previous_version_ids: true,
    superseded_by_ids: true,
  })
  .extend({
    title: localizedTitleSchema.optional().describe('Published title.'),
    date: z.string().optional().describe('Published document date.'),
    term_id: z.string().optional().describe('Published parliamentary-term reference.'),
    creator_ids: z
      .array(z.string().describe('Published creator reference.'))
      .describe('All published creator references, without inferred authorship.'),
    procedure_ids: z
      .array(z.string().describe('Procedure ID.'))
      .describe(
        'Procedures from explicit relations, then those an adopted text, plenary or committee document publishes on its family record, without repeats; use euparl_get_procedure.',
      ),
    parent_document_ids: z
      .array(z.string().describe('Parent work ID.'))
      .describe('Parent documents; read with mode get when a subdivision lacks files.'),
    adopted_document_ids: z
      .array(z.string().describe('Adopted document ID.'))
      .describe(
        'Adopted document relations in published order; mode get reads them, though a target can be unavailable upstream.',
      ),
    based_on_document_ids: z
      .array(z.string().describe('Source document ID.'))
      .describe('Based-on document relations in published order; no procedure link is inferred.'),
    public_register_ref: z
      .string()
      .optional()
      .describe('Published public-register notation, verbatim.'),
    awareness_of_conflict: z
      .boolean()
      .optional()
      .describe(`${detailScope}: whether the member declared awareness of a conflict of interest.`),
    conflict_description: z
      .string()
      .optional()
      .describe(
        `${detailScope}: the member's published description of the conflict, verbatim in the language filed; absent when none.`,
      ),
    capacities: capacities(`${detailScope} (a notice says when that read failed)`),
    previous_version_ids: versionIds(detailScope, 'declarations this one replaces'),
    superseded_by_ids: versionIds(detailScope, 'declarations replacing this one'),
    links: z
      .array(linkSchema)
      .describe('Every source-file link in the selected language, with its metadata.'),
  })
  .strict()
  .describe('Published work metadata and file links; no extracted body.');

/** Discover documents by family or retrieve any canonical work ID. */
export const searchDocumentsTool = tool('euparl_search_documents', {
  title: 'Search parliamentary documents',
  description:
    "Search adopted texts, committee documents, plenary documents, or MEP declarations on awareness of conflicts of interest (source mep_declarations); mode get with document_id returns any work's metadata and source-file links, not extracted text. Get takes document IDs from every tool, whatever the family; parent_document_ids lead from subdivisions to parent files, and adopted and based-on relations read with mode get, though a target can be unavailable upstream. Detail procedure_ids add the procedure an adopted text, plenary or committee document publishes on its family record; adopted and based-on relations never imply procedure links. Filters: text and sitting dates serve adopted_texts; title and related_process_id serve adopted_texts and mep_declarations; person_id and awareness_of_conflict serve mep_declarations; committee takes term but no year, plenary year but no term. euparl_list_reference topic document_types lists work_type codes. Adopted-text rows carry title, date and procedure_ids; declaration rows add what was declared, capacities and version links; committee and plenary rows carry identity only, so their title and date need mode get. Non-keyword adopted texts sort by document_id; keyword searches keep relevance order, and declaration searches past 100 matches read aligned 100-row pages; either can repeat or omit records across pages. Adopted texts and declarations reach the first 10000 results; continue with page.next_offset when present, otherwise narrow the filters.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: z
        .enum(['search', 'get'])
        .default('search')
        .describe('Default search; get requires document_id and takes no source or search filter.'),
      source: z
        .enum(['adopted_texts', 'committee', 'plenary', 'mep_declarations'])
        .optional()
        .describe(
          'Search only; default adopted_texts. mep_declarations lists MEP declarations on awareness of conflicts of interest.',
        ),
      document_id: optionalString().describe(
        'Get only: a work ID from any tool, any family: canonical ID (TA-9-2024-0138), eli/dl/doc/ prefix or public URI in any case, or a returned citation (label, public_register_ref or decision label): T9-0138/2024, P9_TA(2024)0138, A9-0188/2023, P9_A(2023)0188, B9-0163/2024 (read as B-, else the QOB- question motion), RC-B9-0163/2024 or P9_OJQ(2024)03-13. Question citations belong to euparl_list_questions.',
      ),
      text: optionalString().describe(
        'adopted_texts only: keyword search in the requested language.',
      ),
      title: optionalString().describe(
        'adopted_texts and mep_declarations only: title search in the requested language. A declaration title names the member, capacity, committee and procedure.',
      ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Document year; adopted_texts, plenary and mep_declarations search.'),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Term 0–10; adopted_texts, committee and mep_declarations search, never with person_id.',
        ),
      work_type: optionalString().describe(
        'Search only: family-specific code from euparl_list_reference topic document_types, any case.',
      ),
      sitting_date: optionalString().describe(
        'adopted_texts only: sitting date YYYY-MM-DD, or range start with sitting_date_end.',
      ),
      sitting_date_end: optionalString().describe(
        'adopted_texts only: inclusive range end YYYY-MM-DD; needs sitting_date and not before it.',
      ),
      related_process_id: optionalString().describe(
        'Procedure reference YYYY-NNNN, YYYY/NNNN(TYPE), prefix or public URI; adopted_texts and mep_declarations search.',
      ),
      person_id: optionalString().describe(
        'mep_declarations only: declarant person ID (124867), person/ prefix or public person URI; never with term.',
      ),
      awareness_of_conflict: z
        .boolean()
        .optional()
        .describe(
          'mep_declarations only: true keeps declarations of awareness of a conflict of interest, false those declaring none.',
        ),
      ...pagingInputFields('documents', 'adopted_documents', 'keyword_documents', 'declarations'),
    })
    .strict(),
  output: z
    .object({
      mode: z.enum(['search', 'get']).describe('Selected mode.'),
      source: z
        .enum(['adopted_texts', 'committee', 'plenary', 'mep_declarations'])
        .optional()
        .describe('Effective family in search mode.'),
      items: z.array(documentSummarySchema).optional().describe('Search page; absent in get mode.'),
      page: pageSchema.optional().describe('Search page position; absent in get mode.'),
      found: z
        .boolean()
        .optional()
        .describe('Get only: false when the record is missing or empty.'),
      document: documentDetailSchema.optional().describe('Get only, when found.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A code, identifier, language, date range or source filter is unsupported, term is combined with person_id, or an adopted-text or declaration offset reaches the 10000-result search window.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Get lacks document_id, mixes search filters or pages; search supplies document_id.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Parliament rejects the validated request.',
      recovery:
        'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Parliament rate limiting outlasts the retries.',
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
