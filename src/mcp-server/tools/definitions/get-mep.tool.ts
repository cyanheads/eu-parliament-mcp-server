/**
 * @fileoverview MEP identity and separately paged published membership history.
 * @module mcp-server/tools/definitions/get-mep.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyEnrichment,
  enrichmentFields,
  enrichmentTrailer,
  formatResult,
  optionalString,
  pageSchema,
  pagingInputFields,
  serviceInput,
} from '@/mcp-server/tools/utils/eu-parliament-tool.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const sectionSchema = z
  .enum(['overview', 'memberships'])
  .describe('Identity overview or separately paged membership history.');

/** Read published identity and historical membership intervals for one member. */
export const getMepTool = tool('euparl_get_mep', {
  title: 'Read a member and membership history',
  description:
    'Read an MEP identity or membership history including published committee, delegation, and political-group records. Default section overview returns identity and membership_count; section memberships pages full membership records. Missing end dates do not establish current membership. Continue memberships with page.next_offset and snapshot; restart at offset 0 without snapshot after snapshot_changed. Missing detail succeeds with found false; discover IDs with euparl_search_meps.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mep_id: z
        .string()
        .min(1)
        .regex(/^(?:https:\/\/data\.europarl\.europa\.eu\/person\/|person\/)?\d+$/)
        .describe(
          'Decimal person ID, person/ prefix, or exact https://data.europarl.europa.eu/person/ URI.',
        ),
      section: sectionSchema
        .default('overview')
        .describe(
          'Default overview returns identity and membership count; memberships returns the selected history page.',
        ),
      ...pagingInputFields,
      snapshot: optionalString().describe(
        'Returned membership snapshot; required for membership offset above 0, optional at offset 0.',
      ),
    })
    .strict(),
  output: z
    .object({
      found: z.boolean().describe('Whether Parliament published member detail.'),
      mep_id: z.string().describe('Normalized decimal person identifier.'),
      source_url: z.string().describe('Public member source URL.'),
      name: z.string().optional().describe('Published full name.'),
      given_name: z.string().optional().describe('Published given name.'),
      family_name: z.string().optional().describe('Published family name.'),
      citizenship: z
        .string()
        .optional()
        .describe('Published citizenship; distinct from country of representation.'),
      place_of_birth: z
        .string()
        .optional()
        .describe('Published place of birth, never inferred from citizenship.'),
      section: sectionSchema,
      membership_count: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Parsed membership count on a found overview; absent relations do not prove no membership history.',
        ),
      memberships: z
        .array(
          z
            .object({
              id: z.string().describe('Published membership identity.'),
              organization_id: z
                .string()
                .optional()
                .describe(
                  'Published organization identity; resolve supported decimal organization IDs with euparl_list_reference topic organizations and organization_ids.',
                ),
              classification: z
                .string()
                .optional()
                .describe('Published membership classification.'),
              role: z.string().optional().describe('Published membership role.'),
              start_date: z
                .string()
                .optional()
                .describe('Published membership interval start date.'),
              end_date: z
                .string()
                .optional()
                .describe(
                  'Published membership interval end date; absence does not establish current membership.',
                ),
            })
            .strict()
            .describe('Published historical membership and available interval.'),
        )
        .optional()
        .describe(
          'Selected membership history page; present only on a found memberships response.',
        ),
      page: pageSchema
        .optional()
        .describe('Membership continuation metadata; absent on overview or missing detail.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Person identifier or language is unsupported.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Overview has nonzero offset or membership continuation lacks a snapshot.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The complete membership collection or normalized scope changed.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
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
    const result = await getEuParliamentService().getMep(serviceInput(input), ctx);
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? pageSchema.parse(result.data.page) : undefined,
    );
    return result.data;
  },
  // Renders section beside the identity keys, ahead of the optional name fields.
  format: ({ found, mep_id, source_url, section, ...rest }) =>
    formatResult(serviceInput({ found, mep_id, source_url, section, ...rest })),
});
