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
    "Find MEPs by name, person ID, country, political group, gender, term or mandate date. Without term or mandate_date, members in office today; term selects that term's roster, mandate_date the members seated that day. Name matching needs every token, after case, diacritic and punctuation normalization, over the whole roster before paging. mep_ids takes the person IDs other tools return (voter mep_id, participant person_ids, question creator person/ references) in one call; IDs not in the roster come back in unmatched_mep_ids. Country and group are as published for the selected roster, never inferred for another date; term rosters publish neither. Continue with page.next_offset and snapshot; after snapshot_changed, restart at offset 0 without it. euparl_get_mep reads identity and membership history.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      name_contains: optionalString().describe(
        'Every token must match, over the whole roster; case, diacritics and punctuation normalized, no fuzzy scoring. Needs a letter or digit.',
      ),
      mep_ids: z
        .array(
          z
            .string()
            .describe(
              'Person ID: decimal (124867), person/124867 or https://data.europarl.europa.eu/person/124867.',
            ),
        )
        .optional()
        .describe(
          'Person IDs to keep, as other tools return them: voter mep_id, participant person_ids, question creator person/ references. Canonicalized and deduplicated; an empty list counts as omitted; an org/ or other non-person entry is rejected. Narrows with every other filter, no extra request. Pick the roster the IDs belong to: mandate_date (the vote or sitting date) for country and group as published that day, term for names only.',
        ),
      term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Term 0–10, exclusive with mandate_date; omit both for members in office today.'),
      mandate_date: optionalString().describe(
        "Members seated on this YYYY-MM-DD date, not after today (UTC); exclusive with term. Country and group match as published that day. A term's first sitting day can return an incomplete roster or an upstream error; use the next day.",
      ),
      country: optionalString().describe(
        'ISO alpha-2 code, any case. United Kingdom members are published as GB (UK accepted), on historical rosters only. See euparl_list_reference topic mep_filters.',
      ),
      political_group: optionalString().describe(
        'Group code, current or historical (PPE, S-D, PPE-DE, GUE-NGL…), or published label (S&D, Verts/ALE, The Left), any case; EPP, Greens/EFA and Patriots also work. euparl_list_reference topic mep_filters lists codes, labels and periods. GUE/NGL is GUE-NGL on terms 0–8 and through 2020-12-18, else THE-LEFT. Current and mandate_date rosters match the code in force that day; a term roster matches memberships not ended when the term began, not who sat in the group during the term (use mandate_date).',
      ),
      gender: optionalString().describe('Gender code FEMALE, MALE, NAP, NKN or NST, any case.'),
      ...pagingInputFields('meps'),
      snapshot: optionalString().describe('Returned roster snapshot; required above offset 0.'),
    })
    .strict(),
  output: z
    .object({
      items: z
        .array(
          z
            .object({
              mep_id: z.string().describe('Person ID for euparl_get_mep.'),
              name: z.string().optional().describe('Published full name.'),
              given_name: z.string().optional().describe('Published given name.'),
              family_name: z.string().optional().describe('Published family name.'),
              country: z
                .string()
                .optional()
                .describe('Published country in this roster; can be absent on historical rosters.'),
              political_group: z
                .string()
                .optional()
                .describe(
                  'Published political group in this roster; never inferred for a vote date.',
                ),
            })
            .strict()
            .describe('Member identity and roster context.'),
        )
        .describe('Members on this page.'),
      unmatched_mep_ids: z
        .array(z.string().describe('Person ID.'))
        .optional()
        .describe(
          'Requested mep_ids with no row in the selected roster after every filter, in first-seen order, the same on every page; only when mep_ids was supplied. A wrong term or date is the usual cause; euparl_get_mep reads any member by ID.',
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
      when: 'A code, term or language is unsupported; a mep_ids entry is not a person ID; name_contains has no letter or digit; or mandate_date is not a real date or is after today (UTC).',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A nonzero offset lacks a snapshot, or mandate_date is combined with term.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The roster changed since the supplied snapshot.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A roster read came back incomplete.',
      recovery:
        'Retry the same euparl tool call later; do not treat an incomplete lookup as a complete result.',
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
    const result = await getEuParliamentService().searchMeps(serviceInput(input), ctx);
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ items, unmatched_mep_ids, page }) =>
    formatResult(serviceInput({ items, unmatched_mep_ids, page })),
});
