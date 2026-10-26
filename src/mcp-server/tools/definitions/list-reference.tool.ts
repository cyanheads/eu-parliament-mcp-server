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
import { referenceTopics } from '@/services/eu-parliament/eu-parliament-reference.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

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
    name: localizedTextSchema
      .optional()
      .describe('Published full organization name from prefLabel in its actual selected language.'),
    start_date: z.string().optional().describe('Published organization interval start date.'),
    end_date: z
      .string()
      .optional()
      .describe(
        'Published organization interval end date; absence does not establish current status.',
      ),
    found: z
      .boolean()
      .optional()
      .describe('Organization lookup result; false only for HTTP 204 or 404.'),
    organization_id: z
      .string()
      .optional()
      .describe('Normalized decimal organization identifier on lookup results.'),
    source_url: z
      .string()
      .optional()
      .describe('Public organization identity URL on lookup results.'),
  })
  .strict()
  .describe('Reference entry; organization identities are not inferred query codes.');

/** Discover supported filters, identifier syntax and coverage limitations. */
export const listReferenceTool = tool('euparl_list_reference', {
  title: 'List parliamentary reference data',
  description:
    'List parliamentary codes, identifier formats, historical committees and political groups, or coverage limitations. Choose organizations with organization_ids to resolve supported membership organization IDs into published names and dates; ordered per-item found false means no detail was published. Organization lookups page the supplied IDs with an effective maximum of 20 per call; repeat the same ID list with page.next_offset. Other topics retain historical coverage and an effective maximum of 100. These lists do not require snapshots; missing end dates do not establish current status.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      topic: z
        .enum(referenceTopics)
        .describe(
          'Reference topic; organizations requires organization_ids, which other topics reject.',
        ),
      organization_ids: z
        .array(
          z
            .string()
            .describe(
              'Decimal organization ID, org/ prefix, or exact https://data.europarl.europa.eu/org/ URI.',
            ),
        )
        .optional()
        .describe(
          'Required nonempty list only for organizations; order and duplicates retained, with at most 20 looked up per page.',
        ),
      ...pagingInputFields,
      limit: pagingInputFields.limit.describe(
        'Whole items requested; default 20, effective maximum 20 for organizations or 100 for other topics, with notice.',
      ),
    })
    .strict(),
  output: z
    .object({
      topic: z.enum(referenceTopics).describe('Requested reference topic.'),
      items: z.array(entrySchema).describe('Whole reference entries on this page.'),
      page: pageSchema,
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'organizations lacks organization_ids or another topic supplies them.',
      recovery:
        'Choose organizations with organization_ids, or omit organization_ids for another reference topic.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonblank language or organization identifier is unsupported.',
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
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ topic, items, page }) => formatResult({ topic, items, page }),
});
