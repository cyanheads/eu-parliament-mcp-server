/**
 * @fileoverview Complete-roster MEP discovery with local token filtering and paging.
 * @module mcp-server/tools/definitions/search-meps.tool
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

/** Find members across the complete current or selected parliamentary-term roster. */
export const searchMepsTool = tool('euparl_search_meps', {
  title: 'Find members of the European Parliament',
  description:
    'Find MEPs by name, country, political group, gender, or parliamentary term. Omitted term selects members in office today; explicit term selects that published term roster. Name matching requires every normalized token after case, diacritic, and punctuation normalization over the complete roster before paging. Country and group describe roster context, never voting-date affiliation. Continue with page.next_offset and snapshot; restart at offset 0 without snapshot after snapshot_changed. Read identity and membership history with euparl_get_mep. Empty matches succeed with guidance.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      name_contains: optionalString().describe(
        'All-token name filter over the complete selected roster; case, diacritics, and punctuation are normalized, without fuzzy scoring.',
      ),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Parliamentary term 0–10; omitted selects members in office today.'),
      country: optionalString().describe(
        'Supported ISO alpha-2 country code, case-insensitive; GB maps to historical UK and does not establish current membership. See euparl_list_reference topic mep_filters.',
      ),
      political_group: optionalString().describe(
        'Supported political group code, case-insensitive; accepts EPP, S&D, Verts/ALE, Greens/EFA, The Left, GUE/NGL, Renew, PfE, and Patriots aliases. Query aliases never rewrite historical organization identities. See euparl_list_reference topic mep_filters.',
      ),
      gender: optionalString().describe(
        'Supported gender code FEMALE, MALE, NAP, NKN, or NST, case-insensitive.',
      ),
      ...pagingInputFields,
      snapshot: optionalString().describe(
        'Returned roster snapshot; required for offset above 0, optional at offset 0.',
      ),
    })
    .strict(),
  output: z
    .object({
      items: z
        .array(
          z
            .object({
              mep_id: z
                .string()
                .describe('Canonical decimal person identifier for euparl_get_mep.'),
              name: z.string().optional().describe('Published full name.'),
              given_name: z.string().optional().describe('Published given name.'),
              family_name: z.string().optional().describe('Published family name.'),
              country: z
                .string()
                .optional()
                .describe(
                  'Published country in this roster context; may be absent on historical rosters.',
                ),
              political_group: z
                .string()
                .optional()
                .describe(
                  'Published political group in this roster context; never inferred for a vote date.',
                ),
            })
            .strict()
            .describe('Published member identity and available roster context.'),
        )
        .describe('Complete member records on the selected local page.'),
      page: pageSchema,
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A code, term, or language is unsupported.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonzero local offset lacks a snapshot.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The complete roster or normalized retrieval scope changed.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Complete roster acquisition repeats a page before exhaustion.',
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
    const result = await getEuParliamentService().searchMeps(serviceInput(input), ctx);
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ items, page }) => formatResult({ items, page }),
});
