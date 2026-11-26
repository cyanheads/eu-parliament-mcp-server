/**
 * @fileoverview Sitting discovery, sitting agenda and vote items, compact decisions, rich decision
 * and independent voter paging.
 * @module mcp-server/tools/definitions/get-plenary-votes.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyEnrichment,
  enrichmentFields,
  enrichmentTrailer,
  formatResult,
  localizedTextSchema,
  optionalString,
  pageSchema,
  pagingInputFields,
  serviceInput,
} from '@/mcp-server/tools/utils/eu-parliament-tool.js';
import { voterPositions } from '@/services/eu-parliament/eu-parliament-normalization.js';
import { labelCitation } from '@/services/eu-parliament/eu-parliament-reference.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const modeSchema = z
  .enum(['sittings', 'agenda_items', 'vote_items', 'decisions', 'decision', 'voters'])
  .describe('Selected mode.');
const documentIdsSchema = z.array(z.string().describe('Document ID for euparl_search_documents.'));
const procedureIdsSchema = z.array(z.string().describe('Procedure ID for euparl_get_procedure.'));
const agendaItemSchema = z
  .object({
    agenda_item_id: z
      .string()
      .describe(
        'Agenda item ID, such as MTG-PL-2026-11-24-OJ-ITM-V-69; changes when the item moves to another sitting; not a vote_item_id.',
      ),
    activity_type: z
      .string()
      .optional()
      .describe(
        'Published activity type: def/ep-activities/PLENARY_DEBATE, PLENARY_VOTE or REQUEST_VOTE_URGENCY (vote on a Rule 170 urgency request).',
      ),
    label: localizedTextSchema.optional().describe('Published agenda item title.'),
    heading: localizedTextSchema
      .optional()
      .describe(
        'Published group heading, only on grouped items such as Rule 150 human-rights debates and Rule 170 urgency votes.',
      ),
    order: z
      .string()
      .optional()
      .describe(
        'Published agenda position as a string such as 9.0; rows sort by its numeric value.',
      ),
    start_time: z
      .string()
      .optional()
      .describe('Start of the agenda time slot listing the item; absent when no slot lists it.'),
    procedure_ids: procedureIdsSchema.describe(
      'Procedures the item is scheduled for, in published order; empty when unpublished, as on Explanations of votes.',
    ),
    document_ids: documentIdsSchema.describe(
      'Documents the item is based on (proposal, report, motions), in published order; empty when unpublished.',
    ),
    source_url: z.string().describe('Public agenda item source URL.'),
  })
  .strict()
  .describe('One agenda item: a debate, vote or urgency vote foreseen at the sitting.');
const voteItemSchema = z
  .object({
    vote_item_id: z.string().describe('Vote item ID; pass it as vote_item_id in decisions mode.'),
    label: localizedTextSchema.optional().describe('Published vote item title.'),
    document_ids: documentIdsSchema.describe(
      'Documents the vote item is based on (report, motions), in published order; empty when unpublished.',
    ),
    procedure_ids: procedureIdsSchema.describe(
      'Procedures of the vote item, in published order; empty when unpublished.',
    ),
    recording_document_ids: documentIdsSchema.describe(
      'Documents recording the vote item (its minutes item), in published order; empty when unpublished.',
    ),
    decision_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Decisions the vote item links; absent, never 0, where it links none, as before 2024.',
      ),
    source_url: z.string().describe('Public vote item source URL.'),
  })
  .strict()
  .describe('One PLENARY_VOTE_RESULTS vote item: one agenda item voted at the sitting.');
const positionSchema = z
  .enum(voterPositions)
  .describe('Recorded position, or intended (a correction kept separate from recorded votes).');
const decisionFields = {
  decision_id: z.string().describe('Decision ID for decision_id.'),
  label: localizedTextSchema.optional().describe('Published decision label.'),
  document_ids: documentIdsSchema.describe(
    'Documents decided on, in published order; empty when unpublished.',
  ),
  recording_document_ids: documentIdsSchema.describe(
    'Documents recording this decision, in published order; empty when unpublished.',
  ),
  partial_document_ids: documentIdsSchema.describe(
    'Documents only part of which this decision decided on (one split vote on an amendment), in published order; empty when unpublished.',
  ),
  vote_item_ids: z
    .array(z.string().describe('Vote item ID for vote_item_id.'))
    .describe('Vote items this decision belongs to, in published order; empty when unpublished.'),
  date: z.string().optional().describe('Published decision date.'),
  start_time: z.string().optional().describe('Published activity start timestamp.'),
  order: z.string().optional().describe('Published decision order, as a string.'),
  method: z
    .string()
    .optional()
    .describe('Published method; voter availability is not inferred from it.'),
  outcome: z.string().optional().describe('Published outcome; never computed from tallies.'),
  attendees: z
    .number()
    .optional()
    .describe('Published attendees; absent stays absent, zero stays zero.'),
  favor: z
    .number()
    .optional()
    .describe('Published votes in favor; absent stays absent, zero stays zero.'),
  against: z
    .number()
    .optional()
    .describe('Published votes against; absent stays absent, zero stays zero.'),
  abstention: z
    .number()
    .optional()
    .describe('Published abstentions; absent stays absent, zero stays zero.'),
  voter_counts: z
    .array(
      z
        .object({
          position: positionSchema,
          count: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Person IDs in this voter array, without entries naming no person; not the published tally.',
            ),
        })
        .strict()
        .describe('Count of one published voter array.'),
    )
    .describe(
      'Counts for published voter arrays only; a missing entry means unavailable. Zero means the array names no person (published empty, or only entries without an ID, which a notice discloses).',
    ),
  source_url: z.string().describe('Public decision source URL.'),
};
/** Canonical event ID, its known prefix, or its exact public URI. */
const eventIdPattern =
  /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/event\/|eli\/dl\/event\/)?[A-Za-z0-9][A-Za-z0-9_-]*$/;
const memberPositionSchema = z
  .object({
    positions: z
      .array(z.enum(['favor', 'against', 'abstention']).describe('Position listing this member.'))
      .describe(
        'Positions listing the member, conflicts kept; empty does not prove absence from the vote.',
      ),
    unavailable_positions: z
      .array(z.enum(['favor', 'against', 'abstention']).describe('Unpublished position.'))
      .describe('Unpublished positions; published empty arrays remain available.'),
    availability: z
      .enum(['published', 'partial', 'unavailable'])
      .describe('published: all three arrays exist; unavailable: none; otherwise partial.'),
  })
  .strict()
  .describe('Membership in one recorded or intended set of voter arrays.');
const decisionSummarySchema = z
  .object({
    ...decisionFields,
    mep_position: z
      .object({
        recorded: memberPositionSchema,
        intended: memberPositionSchema,
      })
      .strict()
      .optional()
      .describe(
        'mep_id lookup over the whole decision; intended corrections never replace recorded positions.',
      ),
  })
  .strict()
  .describe('Compact decision record.');
const decisionSchema = decisionSummarySchema
  .extend({
    reference_text: localizedTextSchema.optional().describe('Published reference text.'),
    comment: localizedTextSchema.optional().describe('Published commentary.'),
  })
  .strict()
  .describe('Rich decision with complete text and document relations.');
/** Recorded positions counted in one breakdown row. */
const tallyFields = {
  favor: z.number().int().nonnegative().describe('Recorded in favor.'),
  against: z.number().int().nonnegative().describe('Recorded against.'),
  abstention: z.number().int().nonnegative().describe('Recorded abstentions.'),
};

/** Explore sittings and decisions without combining voter pages with rich decision pages. */
export const getPlenaryVotesTool = tool('euparl_get_plenary_votes', {
  title: 'Explore plenary sittings, decisions, and voters',
  description: `Plenary sittings, agendas, votes and voters. Mode sittings lists a year's sittings. Mode agenda_items lists a sitting's published agenda, from the 2024-12-16 sitting on (and the weeks of 2023-07-10 and 2024-04-22): debate, vote and urgency-vote items in agenda order with type, title, heading, time slot, procedures and documents; it changes until the sitting, and a moved item changes ID. Mode vote_items lists a sitting's PLENARY_VOTE_RESULTS vote items with title, documents, procedures and decision_count (absent before 2024, whose vote items link no decisions); pass a vote_item_id to decisions. Default mode decisions pages compact decision summaries of sitting_id, filtered before paging by document_id (exact ID or hyphen-boundary descendant), vote_item_id (a vote_items row or a procedure's PLENARY_VOTE_RESULTS event) or label_contains. label_contains, in decisions or vote_items, matches a literal substring of decision labels (report citations, amendments) or vote item titles, ignoring case, repeated whitespace and dash style without altering published text or establishing a final vote; in a decision label ${labelCitation}. Mode decision returns one rich record with reference text and commentary; breakdown adds its recorded voters by political group and country from the sitting-date roster, values that go back to euparl_search_meps with that mandate_date. mep_id in decisions or decision returns recorded and intended positions; empty positions do not prove absence from the vote. Mode voters pages one position of decision_id; a missing array returns available false, a published empty one available true. resolve_names needs roster_term and joins names from that term roster only, never voting-date affiliations; some IDs stay unresolved. Continue with page.next_offset and snapshot; after snapshot_changed, restart at offset 0 without it.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: modeSchema
        .default('decisions')
        .describe(
          "decisions (default) pages compact summaries; sittings lists a year's; agenda_items and vote_items list those of sitting_id; decision returns one rich record; voters pages one position.",
        ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Sittings mode only (required): four-digit year.'),
      document_id: optionalString().describe(
        'Decisions only: canonical ID, eli/dl/doc/ prefix or public URI in any case, or a citation such as A9-0188/2023, P9_A(2023)0188, T9-0138/2024, B9-0163/2024 or RC-B9-0163/2024. Matches decided-on, part-of or recording relations by exact ID or hyphen-boundary descendant, before paging.',
      ),
      vote_item_id: optionalString(z.string().min(1).regex(eventIdPattern)).describe(
        "Decisions only: MTG-PL-YYYY-MM-DD-VOT-ITM- ID, eli/dl/event/ prefix or public event URI, from a vote_items row, a vote_item_ids entry or a procedure's PLENARY_VOTE_RESULTS event. Selects every decision of that vote item; its date must match sitting_id.",
      ),
      mep_id: optionalString().describe(
        'Decisions or decision: numeric person ID, person/ prefix or public person URI. Reads published arrays, no roster join; empty positions do not prove absence from the vote.',
      ),
      label_contains: optionalString().describe(
        `Decisions or vote_items: literal substring of the selected-language label, ignoring case, repeated whitespace and dash style, before paging. Decision labels carry report citations and amendment numbers and combine with document_id and vote_item_id; in a decision label ${labelCitation}. Vote item labels are titles. A match does not establish a final vote.`,
      ),
      sitting_id: optionalString(
        z
          .string()
          .min(1)
          .regex(
            /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/event\/|eli\/dl\/event\/)?(?:MTG-PL-)?\d{4}-\d{2}-\d{2}$/,
          ),
      ).describe(
        'Required outside sittings: YYYY-MM-DD, MTG-PL-YYYY-MM-DD, event prefix or public event URI.',
      ),
      decision_id: optionalString(z.string().min(1).regex(eventIdPattern)).describe(
        'Decision and voters only (required): returned decision ID, eli/dl/event/ prefix or public event URI.',
      ),
      position: z
        .preprocess(
          (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
          positionSchema.optional(),
        )
        .describe('Voters only (required).'),
      resolve_names: z
        .boolean()
        .default(false)
        .describe('Voters only; default false. True joins names from the roster_term roster.'),
      roster_term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Term 0–10 holding the sitting; required with resolve_names, else forbidden. Never inferred from dates.',
        ),
      breakdown: z
        .boolean()
        .default(false)
        .describe(
          'Decision mode only; default false. True adds breakdown: recorded favor, against and abstention voters tallied by the political group and country published for each on the sitting date (the euparl_search_meps roster for that mandate_date), one extra request. A decision that does not publish all three recorded voter arrays (a hand vote), whose arrays name no person, or an unreadable roster returns no breakdown, with a notice.',
        ),
      ...pagingInputFields('sittings', 'agenda_items', 'vote_items', 'decisions', 'voters'),
      snapshot: optionalString().describe(
        'Snapshot returned by an agenda-item, vote-item, decisions or voters page; required above offset 0.',
      ),
    })
    .strict(),
  output: z
    .object({
      mode: modeSchema,
      sitting_id: z.string().optional().describe('Normalized sitting ID; absent in sittings mode.'),
      decision_id: z
        .string()
        .optional()
        .describe('Normalized decision ID in decision and voters modes.'),
      position: positionSchema.optional().describe('Selected position in voters mode.'),
      sittings: z
        .array(
          z
            .object({
              sitting_id: z.string().describe('Sitting ID for sitting_id.'),
              date: z.string().optional().describe('Published sitting date.'),
              label: localizedTextSchema.optional().describe('Published sitting label.'),
              source_url: z.string().describe('Public sitting source URL.'),
            })
            .strict()
            .describe('One sitting.'),
        )
        .optional()
        .describe('Sittings mode page.'),
      agenda_items: z
        .array(agendaItemSchema)
        .optional()
        .describe('agenda_items mode page, in numeric agenda order; time slots are not rows.'),
      vote_items: z
        .array(voteItemSchema)
        .optional()
        .describe(
          'vote_items mode page, in published order; roll-call, split and separate-vote requests are left out.',
        ),
      decisions: z.array(decisionSummarySchema).optional().describe('Decisions mode page.'),
      decision: decisionSchema.optional().describe('Decision mode record.'),
      voters: z
        .array(
          z
            .object({
              mep_id: z.string().describe('Voter person ID, kept when unresolved.'),
              name: z
                .string()
                .optional()
                .describe(
                  'Name from the roster_term roster; absent means unresolved, not an absent voter.',
                ),
            })
            .strict()
            .describe('One voter.'),
        )
        .optional()
        .describe('Voters mode page for one position, in published ID order.'),
      page: pageSchema
        .optional()
        .describe('Page of the selected collection; absent in decision mode.'),
      voter_resolution: z
        .object({
          scope: z
            .string()
            .describe('Always parliamentary_term; no historical affiliation is joined.'),
          term: z.number().int().min(0).max(10).describe('Term whose roster supplied names.'),
          sitting_date: z.string().optional().describe('Published decision date; never inferred.'),
          resolved: z
            .number()
            .int()
            .nonnegative()
            .describe('Voters resolved across the whole position, before paging.'),
          unresolved: z
            .number()
            .int()
            .nonnegative()
            .describe('Voters without a roster name across the whole position, before paging.'),
        })
        .strict()
        .optional()
        .describe(
          'Name-resolution provenance and counts; names do not prove spelling or affiliation on the voting date.',
        ),
      breakdown: z
        .object({
          mandate_date: z
            .string()
            .describe(
              'Sitting date whose roster supplied groups and countries; pass it as euparl_search_meps mandate_date.',
            ),
          political_groups: z
            .array(
              z
                .object({
                  political_group: z
                    .string()
                    .optional()
                    .describe(
                      "Group label as that day's roster publishes it, such as S&D, Verts/ALE, GUE/NGL or The Left; pass it to euparl_search_meps as political_group with mandate_date for its members. Absent on the row of voters listed without a group.",
                    ),
                  ...tallyFields,
                })
                .strict()
                .describe('Recorded voters of one group.'),
            )
            .describe(
              'One row per group, by voters descending then label; the row without political_group last.',
            ),
          countries: z
            .array(
              z
                .object({
                  country: z
                    .string()
                    .optional()
                    .describe(
                      "ISO alpha-2 country as that day's roster publishes it (GB for United Kingdom members); pass it to euparl_search_meps as country with mandate_date. Absent on the row of voters listed without a country.",
                    ),
                  ...tallyFields,
                })
                .strict()
                .describe('Recorded voters of one country.'),
            )
            .describe(
              'One row per country, by voters descending then code; the row without country last.',
            ),
          unmatched_mep_ids: z
            .array(z.string().describe('Recorded voter person ID.'))
            .describe(
              'Recorded voters missing from that roster, once each in first-recorded order, in no row; euparl_get_mep reads them.',
            ),
        })
        .strict()
        .optional()
        .describe(
          "With breakdown true, once the roster is read: recorded voters tallied by group and country on the mandate_date roster, never current affiliations. Per position, each table plus that position's unmatched voters equals voter_counts; intended corrections are left out.",
        ),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An identifier, date, year, term or language is unsupported, or vote_item_id is from another sitting date.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode fields are missing or incompatible, or local continuation lacks a snapshot.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The selected collection changed since the supplied snapshot.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      thrownBy: 'service',
    },
    {
      reason: 'decision_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The decision is absent from the sitting.',
      recovery:
        'Call euparl_get_plenary_votes with mode decisions and the same sitting_id, then use an exact returned decision_id.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A roster, vote-results or agenda read came back incomplete.',
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
    const result = await getEuParliamentService().getPlenaryVotes(serviceInput(input), ctx);
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? result.data.page : undefined,
    );
    return result.data;
  },
  format: (result) => formatResult(serviceInput(result)),
});
