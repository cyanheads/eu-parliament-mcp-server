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
import { pageCaps } from '@/services/eu-parliament/eu-parliament-normalization.js';
import { referenceTopics } from '@/services/eu-parliament/eu-parliament-reference.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const entrySchema = z
  .object({
    code: z.string().describe('Published identifier or supported query token.'),
    label: localizedTextSchema
      .optional()
      .describe(
        'Published label: a corporate body label, or the label of a political group code in mep_filters (mul).',
      ),
    id: z.string().optional().describe('Corporate-body ID, with org/ prefix.'),
    description: z
      .string()
      .optional()
      .describe('Accepted spelling, source family or coverage explanation.'),
    classification: z.string().optional().describe('Published corporate-body classification.'),
    name: localizedTextSchema.optional().describe('Published full organization name (prefLabel).'),
    start_date: z.string().optional().describe('Published interval start date.'),
    end_date: z
      .string()
      .optional()
      .describe('Published interval end date; absence does not establish current status.'),
    found: z.boolean().optional().describe('Lookup result; false only for HTTP 204 or 404.'),
    organization_id: z
      .string()
      .optional()
      .describe(
        'Supplied ID or code on lookup results, trimmed, without org/ or the URI origin, case unchanged.',
      ),
    source_url: z.string().optional().describe('Public organization URL on lookup results.'),
  })
  .strict()
  .describe('Reference entry; organization identities are not inferred query codes.');

/** Discover supported filters, identifier syntax and coverage limitations. */
export const listReferenceTool = tool('euparl_list_reference', {
  title: 'List parliamentary reference data',
  description:
    "List parliamentary codes, identifier formats, historical committees and political groups, or coverage limitations. Topic organizations with organization_ids resolves the organization IDs other tools return, decimal (org/5154) or code (org/IMCO, org/S-D, org/ep-9), into published names and dates; a question's addressee_ids do not resolve here (COM is the Communist and Allies Group). Per-item found false means no detail was published, as for a code in the wrong case. Lookups page the supplied IDs; repeat the same ID list with page.next_offset. Committees and political groups keep historical coverage. No snapshots; missing end dates do not establish current status.",
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
              'Decimal ID or case-sensitive code (IMCO, S-D, ep-9), bare, after org/, or in the https://data.europarl.europa.eu/org/ URI; labels such as S&D are rejected.',
            ),
        )
        .optional()
        .describe(
          `Organizations only (required, nonempty); order and duplicates kept, at most ${pageCaps.organizations.maximum} looked up per page.`,
        ),
      ...pagingInputFields('reference', 'static_reference', 'organizations'),
    })
    .strict(),
  output: z
    .object({
      topic: z.enum(referenceTopics).describe('Selected topic.'),
      items: z.array(entrySchema).describe('Entries on this page.'),
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
    const result = await getEuParliamentService().listReference(serviceInput(input), ctx);
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ topic, items, page }) => formatResult({ topic, items, page }),
});
