/**
 * @fileoverview Parliamentary question discovery and exact citation resolution.
 * @module mcp-server/tools/definitions/list-questions.tool
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

const questionSummarySchema = z
  .object({
    question_id: z
      .string()
      .describe('Canonical question ID: prefix, term, full year and sequence.'),
    work_type: z.string().optional().describe('Published work-type code or URI.'),
    source_url: z.string().describe('Public linked-data source URL.'),
  })
  .strict()
  .describe('Question discovery record.');
const questionSchema = questionSummarySchema
  .extend({
    title: localizedTitleSchema.optional().describe('Published question title.'),
    alternative_title: localizedTitleSchema
      .optional()
      .describe(
        'Published alternative title: question type, citation, addressee in words, Rule and authors, <br/> separators kept as published.',
      ),
    date: z.string().optional().describe('Published question date.'),
    term_id: z.string().optional().describe('Published parliamentary-term reference.'),
    creator_ids: z
      .array(z.string().describe('Published creator reference.'))
      .describe('All explicit creator references, without inferred authorship.'),
    addressee_ids: z
      .array(z.string().describe('Addressee reference, verbatim.'))
      .describe(
        'Organizations published with the ADDRESSEE role, in published order: org/COM, org/EU_COMMISSION, org/EU_COUNCIL or org/HRVP; some records publish an EU authority URI (http://publications.europa.eu/resource/authority/corporate-body/…) beside such a code or in its place; empty when no role is published. They do not resolve through euparl_list_reference topic organizations, where COM is the Communist and Allies Group; alternative_title names the addressee in words.',
      ),
    original_languages: z
      .array(z.string().describe('ISO 639-1 code, or an unlisted authority code verbatim.'))
      .describe(
        'Languages the question was written in, in published order: authority codes mapped to ISO 639-1 for the 24 EU languages; empty when unpublished.',
      ),
    links: z.array(linkSchema).describe('Source files in the selected language.'),
    answers: z
      .array(
        z
          .object({
            document_id: z
              .string()
              .describe('Answer document ID for euparl_search_documents mode get.'),
            date: z.string().optional().describe('Published answer date, when embedded.'),
            links: z
              .array(linkSchema)
              .describe('Selected-language answer files from embedded answer metadata.'),
          })
          .strict()
          .describe('One published answer and any embedded files.'),
      )
      .describe(
        'Published answer links; empty does not establish that the question is unanswered.',
      ),
  })
  .strict()
  .describe('Question metadata and answer links; no extracted bodies.');

/** List questions or resolve exact citations across overlapping parliamentary terms. */
export const listQuestionsTool = tool('euparl_list_questions', {
  title: 'List parliamentary questions',
  description:
    'List parliamentary questions by year and work_type, or read one with mode get and question_id: metadata, addressees, original languages, source-file links and published answers. Human citations such as E-000001/2025 keep their full year; without term, every overlapping term is checked and one verified match is required; canonical IDs resolve directly. euparl_list_reference topic question_types lists work_type codes. There is no keyword, author or addressee search. Empty answers means no answer relation was published, not that the question is unanswered.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: z
        .enum(['list', 'get'])
        .default('list')
        .describe('Default list; get requires question_id and takes no year or work_type.'),
      year: z.number().int().min(1000).max(9999).optional().describe('List only: four-digit year.'),
      work_type: optionalString().describe(
        'List only: code from euparl_list_reference topic question_types, any case.',
      ),
      question_id: optionalString().describe(
        'Get only: canonical E-{term}-{year}-{sequence}, document prefix or public URI, or a human E-sequence/YYYY citation; E/P/O/G/K prefixes in any case, sequences padded to six digits.',
      ),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Get only: term 0–10 that disambiguates a human citation and agrees with a canonical ID; omit to check every term overlapping the citation year.',
        ),
      ...pagingInputFields('questions'),
    })
    .strict(),
  output: z
    .object({
      mode: z.enum(['list', 'get']).describe('Selected mode.'),
      items: z.array(questionSummarySchema).optional().describe('List page; absent in get mode.'),
      page: pageSchema.optional().describe('List page position; absent in get mode.'),
      found: z
        .boolean()
        .optional()
        .describe(
          'Get only; false only after complete citation resolution or for unpublished detail.',
        ),
      question: questionSchema.optional().describe('Get only, when found.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A question code, identifier or language is unsupported, term conflicts, or a citation matches several terms.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Get lacks question_id or supplies list filters or pages; list supplies question_id or term.',
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
    const result = await getEuParliamentService().listQuestions(serviceInput(input), ctx);
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? result.data.page : undefined,
    );
    return result.data;
  },
  format: ({ mode, items, page, found, question }) =>
    formatResult(serviceInput({ mode, items, page, found, question })),
});
