/**
 * @fileoverview Sitting discovery, compact decisions, rich decision and independent voter paging.
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
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const modeSchema = z
  .enum(['sittings', 'decisions', 'decision', 'voters'])
  .describe(
    'Sitting discovery, compact decision page, one rich decision, or one voter-position page.',
  );
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
              'Exact length of this published voter-ID array; distinct from a published vote tally.',
            ),
        })
        .strict()
        .describe('Count for an available recorded or intended voter array.'),
    )
    .describe(
      'Counts only for published voter arrays; an absent entry means unavailable, a zero count means published empty.',
    ),
  source_url: z.string().describe('Public decision source URL.'),
};
const decisionSummarySchema = z
  .object(decisionFields)
  .strict()
  .describe(
    'Compact decision identity, label, separate document relations, published tallies and voter-array counts; use mode decision for reference text and comment.',
  );
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
const decisionSchema = z
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
  description:
    'Discover sittings with mode sittings and year; default decisions pages compact summaries with labels and separate decided-on and recording document relations for sitting_id. Optional document_id filters decisions before paging by exact document identity or hyphen-boundary descendant. Mode decision requires decision_id and returns one rich record with reference text and commentary; it rejects nondefault paging and snapshot. Optional decision-only mep_id returns independent recorded and intended positions with publication availability, without a roster lookup; empty positions do not prove absence from the vote. Mode voters requires decision_id and one position, paging recorded and intended voters independently. Missing arrays succeed with available false; published empty arrays have available true. Optional resolve_names requires explicit roster_term and joins only published names from that complete term roster, never voting-date affiliations or current-roster substitutes. Some IDs may remain unresolved. Continue local decisions or voters with page.next_offset and snapshot; restart at offset 0 without snapshot after snapshot_changed. Missing sitting decisions succeed empty; absent selected decision fails decision_not_found.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: modeSchema
        .default('decisions')
        .describe(
          'Default decisions returns compact summaries; sittings discovers by year, decision returns one rich record, voters pages one position.',
        ),
      year: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Four-digit year, required only for sittings and forbidden in other modes.'),
      document_id: optionalString().describe(
        'Decisions-only document filter: canonical ID, eli/dl/doc/ prefix or exact public URI. Matches decided-on or recording relations by exact ID or hyphen-boundary descendant before paging.',
      ),
      mep_id: optionalString().describe(
        'Decision-only member lookup: canonical numeric ID, person/ prefix or exact public person URI. Uses published arrays without a roster join; empty positions do not prove absence from the vote.',
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
      decision_id: optionalString(
        z
          .string()
          .min(1)
          .regex(
            /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/event\/|eli\/dl\/event\/)?[A-Za-z0-9][A-Za-z0-9_-]*$/,
          ),
      ).describe(
        'Required for decision and voters: exact returned canonical decision ID, known eli/dl/event/ prefix, or exact public event URI; forbidden for sittings and decisions.',
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
      ...pagingInputFields,
      snapshot: optionalString().describe(
        'Returned decisions or voter-position snapshot; required for local offset above 0, optional at offset 0; forbidden for sittings and decision.',
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
      decisions: z
        .array(decisionSummarySchema)
        .optional()
        .describe(
          'Compact whole-decision page with selected-language labels and separate decided-on and recording document relations.',
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
          'Selected sitting, compact decision, or voter-position page; absent for a rich decision.',
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
      when: 'Identifier, calendar date, year, term, or language is unsupported.',
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
      when: 'Complete selected decisions, voters, resolved names, or normalized retrieval scope changed.',
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
      when: 'Complete name-resolution roster acquisition repeats a page before exhaustion.',
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
