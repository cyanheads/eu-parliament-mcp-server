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
  localizedTextSchema,
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
      .describe(
        'Canonical question work identifier, preserving prefix, term, full year and sequence.',
      ),
    work_type: z.string().optional().describe('Published question work-type code or URI.'),
    source_url: z.string().describe('Public linked-data question source URL.'),
  })
  .strict()
  .describe('Sparse parliamentary question discovery record.');
const questionSchema = questionSummarySchema
  .extend({
    title: localizedTextSchema
      .optional()
      .describe('Published question title and actual selected source language.'),
    date: z.string().optional().describe('Published question document date.'),
    term_id: z.string().optional().describe('Published parliamentary-term reference.'),
    creator_ids: z
      .array(z.string().describe('Published creator reference.'))
      .describe('All explicit creator references, without inferred authorship.'),
    links: z
      .array(linkSchema)
      .describe('All source files in the selected question expression language.'),
    answers: z
      .array(
        z
          .object({
            document_id: z
              .string()
              .describe(
                'Canonical answer work identifier accepted by euparl_search_documents mode get.',
              ),
            date: z.string().optional().describe('Published answer document date, when embedded.'),
            links: z
              .array(linkSchema)
              .describe(
                'All selected-language answer files published in embedded answer metadata.',
              ),
          })
          .strict()
          .describe('Published answer relationship and any embedded file metadata.'),
      )
      .describe(
        'Published answer links; an empty array does not establish that the question is unanswered.',
      ),
  })
  .strict()
  .describe(
    'Question metadata and published answer links, without extracted question or answer bodies.',
  );

/** List questions or resolve a citation exactly across the published year catalogue. */
export const listQuestionsTool = tool('euparl_list_questions', {
  title: 'List parliamentary questions',
  description:
    'List parliamentary questions by year and work_type or retrieve metadata, source-file links and published answers with mode get and question_id. Human citations such as E-000001/2025 retain their full year; supplying term resolves directly, while omission searches the complete year catalogue and requires an unambiguous exact match. Canonical IDs bypass that scan. Use euparl_list_reference topic question_types for work_type codes. No keyword, author or addressee search is available. Empty answers means no answer relation was published in this response. Get rejects list filters and nondefault paging; continue lists with page.next_offset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: z
        .enum(['list', 'get'])
        .default('list')
        .describe(
          'Default list discovers questions; get requires question_id and forbids year and work_type.',
        ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('List-only four-digit question year.'),
      work_type: optionalString().describe(
        'List-only question code from euparl_list_reference topic question_types; case-insensitive and whitespace-trimmed.',
      ),
      question_id: optionalString().describe(
        'Get-only canonical E-{term}-{year}-{six-digit-sequence}, known document prefix/public URI, or human E-NNNNNN/YYYY citation; corresponding P/O prefixes are accepted.',
      ),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Get-only term 0–10 to disambiguate a human citation; must agree with a canonical ID. Omit to scan the entire citation year without inferring term.',
        ),
      ...pagingInputFields,
    })
    .strict(),
  output: z
    .object({
      mode: z.enum(['list', 'get']).describe('Executed question retrieval mode.'),
      items: z
        .array(questionSummarySchema)
        .optional()
        .describe('Whole sparse records on a list page; absent in get mode.'),
      page: pageSchema.optional().describe('List continuation metadata; absent in get mode.'),
      found: z
        .boolean()
        .optional()
        .describe(
          'Get-only result; false only after complete citation resolution or missing published detail.',
        ),
      question: questionSchema
        .optional()
        .describe('Question detail present only when a published record is found.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A question code, identifier or language is unsupported, term conflicts, or a citation matches multiple terms.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Get lacks question_id or supplies list filters or nondefault paging; list supplies question_id or term.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Complete citation-year traversal repeats or cannot advance before exhaustion.',
      recovery:
        'Retry the same euparl tool call later; do not treat an incomplete lookup as a complete result.',
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
    const result = await getEuParliamentService().listQuestions(serviceInput(input), ctx);
    ctx.enrich({ appliedFilters: result.enrichment.appliedFilters });
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
