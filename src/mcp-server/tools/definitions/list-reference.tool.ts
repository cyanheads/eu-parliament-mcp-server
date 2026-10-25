/**
 * @fileoverview Parliamentary reference tables and live corporate bodies.
 * @module mcp-server/tools/definitions/list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyEnrichment,
  enrichmentFields,
  enrichmentTrailer,
  formatResult,
  localizedTextSchema,
  pageSchema,
  pagingInputFields,
  serviceInput,
} from '@/mcp-server/tools/utils/eu-parliament-tool.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const topics = [
  'committees',
  'political_groups',
  'procedure_types',
  'document_types',
  'question_types',
  'activity_types',
  'mep_filters',
  'identifiers',
  'coverage',
] as const;
const entrySchema = z
  .object({
    code: z.string().describe('Published identifier or supported query token.'),
    label: localizedTextSchema.optional().describe('Published selected-language body label.'),
    id: z.string().optional().describe('Published corporate-body identity, including org/ prefix.'),
    description: z
      .string()
      .optional()
      .describe('Accepted spelling, source family or coverage explanation.'),
    classification: z.string().optional().describe('Published corporate-body classification.'),
  })
  .strict()
  .describe('Reference entry; organization identities are not inferred query codes.');

/** Discover supported filters, identifier syntax and coverage limitations. */
export const listReferenceTool = tool('euparl_list_reference', {
  title: 'List parliamentary reference data',
  description:
    'List parliamentary codes, identifier formats, committees, political groups, and coverage limitations. Choose topic to discover accepted filter values before calling another euparl tool. Committees and political groups are live bodies; organization identifiers are not inferred filter codes. Continue with page.next_offset; these lists do not require snapshots.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({ topic: z.enum(topics).describe('Reference topic to list.'), ...pagingInputFields })
    .strict(),
  output: z
    .object({
      topic: z.enum(topics).describe('Requested reference topic.'),
      items: z.array(entrySchema).describe('Whole reference entries on this page.'),
      page: pageSchema,
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonblank language is unsupported.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
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
    const result = await getEuParliamentService().listReference(serviceInput(input), ctx);
    ctx.enrich({ appliedFilters: result.enrichment.appliedFilters });
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ topic, items, page }) => formatResult({ topic, items, page }),
});
