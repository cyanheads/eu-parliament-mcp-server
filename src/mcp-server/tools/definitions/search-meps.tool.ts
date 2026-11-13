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

/** Find members across the complete current, dated, or selected parliamentary-term roster. */
export const searchMepsTool = tool('euparl_search_meps', {
  title: 'Find members of the European Parliament',
  description:
    'Find MEPs by name, person ID, country, political group, gender, parliamentary term, or mandate date. Omitting term and mandate_date selects members in office today; term selects that published term roster; mandate_date selects members seated on that date. Name matching requires every normalized token after case, diacritic, and punctuation normalization over the complete roster before paging. mep_ids names the person IDs other tools return (voter mep_id, participant person_ids, question creator person/ references) in one call; requested IDs absent from the roster come back in unmatched_mep_ids. Country and group are published for the selected roster, never inferred for another date; term rosters publish neither. Continue with page.next_offset and snapshot; restart at offset 0 without snapshot after snapshot_changed. Read identity and membership history with euparl_get_mep. Empty matches succeed with guidance.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      name_contains: optionalString().describe(
        'All-token name filter over the complete selected roster; case, diacritics, and punctuation are normalized, without fuzzy scoring. Must keep at least one letter or digit.',
      ),
      mep_ids: z
        .array(
          z
            .string()
            .describe(
              'Person ID as euparl_get_mep accepts it: decimal (124867), person/124867, or https://data.europarl.europa.eu/person/124867.',
            ),
        )
        .optional()
        .describe(
          'Person IDs to keep from the selected roster, as other tools return them: voter mep_id, participant person_ids, question creator person/ references. Canonicalized and deduplicated; an empty list counts as omitted; an org/ creator or other non-person entry is rejected. Narrows together with every other filter, with no extra upstream request. Pick the roster the IDs belong to: mandate_date (the vote or sitting date) for country and group as published that day, term for names only.',
        ),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Parliamentary term 0–10, exclusive with mandate_date; omitting both selects members in office today.',
        ),
      mandate_date: optionalString().describe(
        "Members holding a seat on this YYYY-MM-DD date, not after today (UTC); exclusive with term. Country and group are matched and returned as published on that date. A term's first sitting day can return an incomplete roster or an upstream error; use the following day.",
      ),
      country: optionalString().describe(
        'Supported ISO alpha-2 country code, case-insensitive. United Kingdom members are published as GB (UK accepted), on historical rosters only. See euparl_list_reference topic mep_filters.',
      ),
      political_group: optionalString().describe(
        "Published political group code, current or historical (PPE, S-D, PPE-DE, ALDE, GUE-NGL…), or its published label (S&D, Verts/ALE, The Left, IND/DEM), case-insensitive; EPP, Greens/EFA and Patriots are accepted too. euparl_list_reference topic mep_filters lists every code with its label and periods. GUE/NGL selects GUE-NGL on terms 0–8 and dates through 2020-12-18, the last day the dated roster matches GUE-NGL, and THE-LEFT otherwise. With mandate_date, or on the current roster, it matches only the code in force that day. On a term roster it matches the term's members holding a membership in the code that had not ended when the term began, later memberships included, not who sat in the group during the term; use mandate_date for that. Query aliases never rewrite historical organization identities.",
      ),
      gender: optionalString().describe(
        'Supported gender code FEMALE, MALE, NAP, NKN, or NST, case-insensitive.',
      ),
      ...pagingInputFields('meps'),
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
      unmatched_mep_ids: z
        .array(z.string().describe('Canonical decimal person ID.'))
        .optional()
        .describe(
          'Requested mep_ids with no row in the selected roster after every filter, canonical, in first-seen order; the same on every page. Present only when mep_ids was supplied. A wrong term or date is the usual cause; euparl_get_mep reads any member by ID.',
        ),
      page: pageSchema,
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A code, term, or language is unsupported; a mep_ids entry is not a person ID; name_contains has no letter or digit; or mandate_date is not a real date or is after today (UTC).',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonzero local offset lacks a snapshot, or mandate_date is combined with term.',
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
  format: ({ items, unmatched_mep_ids, page }) =>
    formatResult(serviceInput({ items, unmatched_mep_ids, page })),
});
