/**
 * @fileoverview Sitting discovery, sitting vote items, compact decisions, rich decision and
 * independent voter paging.
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
  .enum(['sittings', 'vote_items', 'decisions', 'decision', 'voters'])
  .describe(
    'Sitting discovery, sitting vote-item page, compact decision page, one rich decision, or one voter-position page.',
  );
const documentIdsSchema = z.array(
  z.string().describe('Canonical document identifier accepted by document get.'),
);
const voteItemSchema = z
  .object({
    vote_item_id: z
      .string()
      .describe('Canonical vote item identifier; pass it as vote_item_id in decisions mode.'),
    label: localizedTextSchema
      .optional()
      .describe('Whole published vote item title in its actual selected language.'),
    document_ids: documentIdsSchema.describe(
      'Documents the vote item is based on, such as the report or motions, in published order; absent relations are empty.',
    ),
    procedure_ids: z
      .array(
        z.string().describe('Canonical procedure identifier accepted by euparl_get_procedure.'),
      )
      .describe(
        'Procedures the vote item belongs to, in published order; absent relations are empty.',
      ),
    recording_document_ids: documentIdsSchema.describe(
      'Documents recording the vote item, such as its minutes item, in published order; absent relations are empty.',
    ),
    decision_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Number of decisions the vote item publishes links to; absent, never 0, where it publishes none, as on sittings before 2024.',
      ),
    source_url: z.string().describe('Public vote item source URL.'),
  })
  .strict()
  .describe('One published PLENARY_VOTE_RESULTS vote item: one agenda item voted at the sitting.');
const positionSchema = z
  .enum(voterPositions)
  .describe(
    'Recorded or intended voter position; intended corrections remain separate from recorded votes.',
  );
const decisionFields = {
  decision_id: z.string().describe('Canonical decision activity identifier.'),
  label: localizedTextSchema
    .optional()
    .describe('Whole published decision label in its actual selected language.'),
  document_ids: z
    .array(z.string().describe('Canonical document identifier accepted by document get.'))
    .describe('Explicit documents decided on, in published order; absent relations are empty.'),
  recording_document_ids: z
    .array(z.string().describe('Canonical recording document identifier accepted by document get.'))
    .describe(
      'Explicit documents recording this decision, in published order; absent relations are empty.',
    ),
  partial_document_ids: z
    .array(z.string().describe('Canonical document identifier accepted by document get.'))
    .describe(
      'Explicit documents only part of which this decision decided on, such as one split vote on an amendment, in published order; absent relations are empty.',
    ),
  vote_item_ids: z
    .array(z.string().describe('Canonical vote item identifier accepted by vote_item_id.'))
    .describe(
      'Explicit vote items this decision belongs to, in published order; vote_item_id selects every decision of one. Absent relations are empty.',
    ),
  date: z.string().optional().describe('Published decision date.'),
  start_time: z.string().optional().describe('Published activity start timestamp.'),
  order: z.string().optional().describe('Published decision order, preserved as a string.'),
  method: z
    .string()
    .optional()
    .describe('Published decision method; no voter availability is inferred from it.'),
  outcome: z
    .string()
    .optional()
    .describe('Published decision outcome; never computed from tallies.'),
  attendees: z
    .number()
    .optional()
    .describe('Published attendee tally; absent stays absent and published zero stays zero.'),
  favor: z
    .number()
    .optional()
    .describe('Published votes in favor; absent stays absent and published zero stays zero.'),
  against: z
    .number()
    .optional()
    .describe('Published votes against; absent stays absent and published zero stays zero.'),
  abstention: z
    .number()
    .optional()
    .describe('Published abstention tally; absent stays absent and published zero stays zero.'),
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
              'Number of person IDs in this published voter array, leaving out entries that name no person; distinct from a published vote tally.',
            ),
        })
        .strict()
        .describe('Count for an available recorded or intended voter array.'),
    )
    .describe(
      'Counts only for published voter arrays; an absent entry means unavailable. A zero count means the array names no person: published empty, or holding only entries without an identifier, which a notice discloses.',
    ),
  source_url: z.string().describe('Public decision source URL.'),
};
/** Canonical event ID, its known prefix, or its exact public URI. */
const eventIdPattern =
  /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/event\/|eli\/dl\/event\/)?[A-Za-z0-9][A-Za-z0-9_-]*$/;
const memberPositionSchema = z
  .object({
    positions: z
      .array(
        z
          .enum(['favor', 'against', 'abstention'])
          .describe('Published position containing this member.'),
      )
      .describe(
        'All matching published positions, preserving conflicts; empty does not prove absence from the vote.',
      ),
    unavailable_positions: z
      .array(
        z
          .enum(['favor', 'against', 'abstention'])
          .describe('Position whose voter array was omitted.'),
      )
      .describe('Unpublished positions; published empty arrays remain available.'),
    availability: z
      .enum(['published', 'partial', 'unavailable'])
      .describe(
        'Published when all three arrays exist, unavailable when none exist, otherwise partial.',
      ),
  })
  .strict()
  .describe('Membership in one independent recorded or intended set of voter arrays.');
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
        'Requested member lookup from the complete decision; intended corrections never replace recorded positions.',
      ),
  })
  .strict()
  .describe(
    'Compact decision identity, label, relations, tallies, voter counts and optional member positions.',
  );
const decisionSchema = decisionSummarySchema
  .extend({
    reference_text: localizedTextSchema
      .optional()
      .describe('Whole published reference text in its actual selected language.'),
    comment: localizedTextSchema
      .optional()
      .describe('Whole published commentary in its actual selected language.'),
  })
  .strict()
  .describe('One rich decision with complete selected text and explicit document relationships.');

/** Explore sittings and decisions without combining voter pages with rich decision pages. */
export const getPlenaryVotesTool = tool('euparl_get_plenary_votes', {
  title: 'Explore plenary sittings, decisions, and voters',
  description: `Discover sittings with mode sittings and year. Mode vote_items lists what a sitting voted on: its PLENARY_VOTE_RESULTS vote items in published order, each with its title label, based-on documents, procedures, recording documents and decision_count, from one sitting-wide read; pass a vote_item_id to decisions mode for its decisions. Vote items on sittings before 2024 publish no decision links, so decision_count is absent there. Default decisions pages compact summaries with labels, separate decided-on, part-of and recording document relations, and vote items for sitting_id. Vote items, decisions and voters return the requested whole-item count or remaining rows without an output-size cap. Optional label_contains, in decisions or vote_items, selects a literal selected-language substring of decision labels (report citations, amendments) or vote item titles, ignoring case, repeated whitespace and dash style without altering published text or establishing a final vote; in a decision label ${labelCitation}. Optional document_id filters decisions before paging by exact document identity or hyphen-boundary descendant; optional vote_item_id, such as a procedure's PLENARY_VOTE_RESULTS event, selects every decision of that vote item. Mode decision requires decision_id and returns one rich record with reference text and commentary; it rejects nondefault paging and snapshot. Optional decisions or decision mep_id returns independent recorded and intended positions with publication availability, without a roster lookup; empty positions do not prove absence from the vote. Mode voters requires decision_id and one position, paging recorded and intended voters independently. Missing arrays succeed with available false; published empty arrays have available true. Optional resolve_names requires explicit roster_term and joins only published names from that complete term roster, never voting-date affiliations or current-roster substitutes. Some IDs may remain unresolved. Continue local vote items, decisions or voters with page.next_offset and snapshot; restart at offset 0 without snapshot after snapshot_changed. Missing sitting vote items or decisions succeed empty; absent selected decision fails decision_not_found.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: modeSchema
        .default('decisions')
        .describe(
          'Default decisions returns compact summaries; sittings discovers by year, vote_items lists the vote items of sitting_id, decision returns one rich record, voters pages one position.',
        ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Four-digit year, required only for sittings and forbidden in other modes.'),
      document_id: optionalString().describe(
        'Decisions-only document filter: canonical ID, eli/dl/doc/ prefix or exact public URI, in any letter case, or a report, adopted-text, motion or agenda citation such as A9-0188/2023, P9_A(2023)0188, T9-0138/2024, B9-0163/2024 (the B- motion) or RC-B9-0163/2024. Matches decided-on, part-of or recording relations by exact ID or hyphen-boundary descendant before paging.',
      ),
      vote_item_id: optionalString(z.string().min(1).regex(eventIdPattern)).describe(
        "Decisions-only vote item filter: canonical MTG-PL-YYYY-MM-DD-VOT-ITM- ID, eli/dl/event/ prefix or exact public event URI, such as a procedure's PLENARY_VOTE_RESULTS event, a vote_items row or a returned vote_item_ids entry. Selects every decision of that vote item before paging; its date must match sitting_id.",
      ),
      mep_id: optionalString().describe(
        'Decisions or decision member lookup: canonical numeric ID, person/ prefix or exact public person URI. Uses published arrays without a roster join; empty positions do not prove absence from the vote.',
      ),
      label_contains: optionalString().describe(
        `Decisions or vote_items literal substring of the selected-language label, ignoring case, repeated whitespace and dash style, applied before paging. Decision labels carry report citations and amendment numbers and combine with document_id and vote_item_id; in a decision label ${labelCitation}. Vote item labels are titles such as Artificial Intelligence Act. Matching text does not establish a final vote.`,
      ),
      sitting_id: optionalString(
        z
          .string()
          .min(1)
          .regex(
            /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/event\/|eli\/dl\/event\/)?(?:MTG-PL-)?\d{4}-\d{2}-\d{2}$/,
          ),
      ).describe(
        'Required outside sittings: real YYYY-MM-DD date, MTG-PL-YYYY-MM-DD, known event prefix, or exact public event URI.',
      ),
      decision_id: optionalString(z.string().min(1).regex(eventIdPattern)).describe(
        'Required for decision and voters: exact returned canonical decision ID, known eli/dl/event/ prefix, or exact public event URI; forbidden for sittings, vote_items and decisions.',
      ),
      position: z
        .preprocess(
          (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
          positionSchema.optional(),
        )
        .describe(
          'Required only for voters: favor, against, abstention, intended_favor, intended_against, or intended_abstention.',
        ),
      resolve_names: z
        .boolean()
        .default(false)
        .describe(
          'Default false retains IDs only; true is voters-only and requires roster_term for complete names-only roster resolution.',
        ),
      roster_term: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe(
          'Explicit parliamentary term 0–10 containing the sitting; required with resolve_names true, forbidden otherwise. No term is inferred from dates.',
        ),
      ...pagingInputFields('sittings', 'vote_items', 'decisions', 'voters'),
      snapshot: optionalString().describe(
        'Returned vote-item, decisions or voter-position snapshot; required for local offset above 0, optional at offset 0; forbidden for sittings and decision.',
      ),
    })
    .strict(),
  output: z
    .object({
      mode: modeSchema,
      sitting_id: z
        .string()
        .optional()
        .describe('Normalized selected sitting identifier; absent in sitting discovery.'),
      decision_id: z
        .string()
        .optional()
        .describe('Normalized selected decision identifier; present in decision and voters modes.'),
      position: positionSchema
        .optional()
        .describe('Selected recorded or intended position in voters mode.'),
      sittings: z
        .array(
          z
            .object({
              sitting_id: z.string().describe('Published sitting activity identifier.'),
              date: z.string().optional().describe('Published sitting date.'),
              label: localizedTextSchema
                .optional()
                .describe('Published sitting label in its actual selected language.'),
              source_url: z.string().describe('Public sitting source URL.'),
            })
            .strict()
            .describe('Published sitting discovery record.'),
        )
        .optional()
        .describe('Sitting discovery page, present only in sittings mode.'),
      vote_items: z
        .array(voteItemSchema)
        .optional()
        .describe(
          'Whole vote-item page of the sitting in published order, present only in vote_items mode; roll-call, split and separate-vote requests are left out.',
        ),
      decisions: z
        .array(decisionSummarySchema)
        .optional()
        .describe(
          'Compact whole-decision page with selected-language labels, separate decided-on, part-of and recording document relations, and vote items.',
        ),
      decision: decisionSchema
        .optional()
        .describe('Complete selected rich decision, present only in decision mode.'),
      voters: z
        .array(
          z
            .object({
              mep_id: z
                .string()
                .describe('Canonical published voter person ID; retained even when unresolved.'),
              name: z
                .string()
                .optional()
                .describe(
                  'Published identity from the explicitly selected term roster; absence means unresolved, not absent voter.',
                ),
            })
            .strict()
            .describe('Published voter identity with optional names-only roster join.'),
        )
        .optional()
        .describe(
          'Independent page for one recorded or intended position, preserving published ID order.',
        ),
      page: pageSchema
        .optional()
        .describe(
          'Selected sitting, vote-item, compact decision, or voter-position page; absent for a rich decision. Local pages retain the requested count or remaining rows without a character budget; next_offset resumes at the first item left out.',
        ),
      voter_resolution: z
        .object({
          scope: z
            .string()
            .describe(
              'Name resolution scope, parliamentary_term; no historical affiliation is joined.',
            ),
          term: z
            .number()
            .int()
            .min(0)
            .max(10)
            .describe('Explicitly selected term whose complete published roster supplied names.'),
          sitting_date: z
            .string()
            .optional()
            .describe('Published decision date, when available; no date is inferred.'),
          resolved: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Number of voters resolved across the complete selected position before paging.',
            ),
          unresolved: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Number of voters without a published roster name across the complete selected position before paging.',
            ),
        })
        .strict()
        .optional()
        .describe(
          'Names-only provenance and complete-position resolution counts; names do not prove spelling or affiliation on the voting date.',
        ),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier, calendar date, year, term, or language is unsupported, or vote_item_id belongs to a different sitting date than sitting_id.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Required mode fields are missing, incompatible fields are supplied, or local continuation lacks a snapshot.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Complete selected vote items, decisions, voters, resolved names, or normalized retrieval scope changed.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      thrownBy: 'service',
    },
    {
      reason: 'decision_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The selected decision is absent from the complete sitting collection.',
      recovery:
        'Call euparl_get_plenary_votes with mode decisions and the same sitting_id, then use an exact returned decision_id.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Complete name-resolution roster acquisition repeats a page before exhaustion, or the vote-results read omits a vote item its sitting lists.',
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
