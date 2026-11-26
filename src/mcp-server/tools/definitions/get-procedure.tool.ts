/**
 * @fileoverview Procedure overview and separately paged evidence collections.
 * @module mcp-server/tools/definitions/get-procedure.tool
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
import {
  firstDecisionSitting,
  labelCitation,
} from '@/services/eu-parliament/eu-parliament-reference.js';
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const eventSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Event ID. A PLENARY_VOTE_RESULTS event id is a vote item: pass it as vote_item_id to euparl_get_plenary_votes, with the sitting on its date, for every decision of that vote.',
      ),
    date: z.string().optional().describe('Published activity date.'),
    activity_type: z.string().optional().describe('Published activity type code or URI.'),
    stage: z.string().optional().describe('Published event stage.'),
    document_ids: z
      .array(z.string().describe('Document ID.'))
      .describe('Event documents, deduplicated and sorted.'),
    sitting_ids: z
      .array(z.string().describe('Sitting ID.'))
      .describe(
        `Scheduled sitting relations, sorted. When absent, the vote-event date selects the sitting for euparl_get_plenary_votes decisions with vote_item_id or document_id. Older sittings publish vote items without decision links and decisions without report relations, so neither filter matches there: list the sitting's vote items with mode vote_items, or match label_contains to the report citation (${labelCitation}) or to words of the vote item's title in the title's language (decision records start with the ${firstDecisionSitting} sitting).`,
      ),
  })
  .strict()
  .describe('One procedure event.');
const participantSchema = z
  .object({
    id: z.string().describe('Participation ID.'),
    person_ids: z
      .array(z.string().describe('Person ID for euparl_get_mep.'))
      .describe('Participating people, sorted.'),
    organization_ids: z
      .array(z.string().describe('Organization ID.'))
      .describe(
        'Participating organizations, sorted; resolve with euparl_list_reference topic organizations.',
      ),
    role: z.string().optional().describe('Published historical participation role.'),
    date: z.string().optional().describe('Published participation date.'),
    stage: z.string().optional().describe('Published participation stage.'),
    political_group_id: z
      .string()
      .optional()
      .describe(
        'Published historical group code (org/S-D), never joined to a current group; resolve with euparl_list_reference topic organizations.',
      ),
    represented_organization_id: z
      .string()
      .optional()
      .describe(
        'Organization represented, usually a committee (org/IMCO); resolve with euparl_list_reference topic organizations.',
      ),
    term_id: z.string().optional().describe('Published parliamentary-term identity.'),
  })
  .strict()
  .describe('Historical procedure participation.');
const documentSchema = z
  .object({
    document_id: z.string().describe('Document ID for euparl_search_documents mode get.'),
    source_url: z.string().describe('Public document source URL.'),
  })
  .strict()
  .describe('Linked document; no inferred title or legal identifier.');
const sectionSchema = z
  .enum(['overview', 'events', 'participants', 'documents'])
  .describe('Selected section.');

/** Read procedure identity and one complete evidence section at a time. */
export const getProcedureTool = tool('euparl_get_procedure', {
  title: 'Read a parliamentary procedure',
  description:
    'Read a procedure: title, stage, events, participants or linked documents. Default section overview returns scalar fields and section counts; events, participants and documents page one collection. Continue with page.next_offset and snapshot; after snapshot_changed, restart at offset 0 without it. Participation groups stay historical. Missing detail returns found false; euparl_list_procedures discovers references. euparl_search_documents mode get reads linked documents; files are linked, not parsed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      procedure_id: z
        .string()
        .min(1)
        .regex(
          /^(?:https:\/\/data\.europarl\.europa\.eu\/eli\/dl\/proc\/|eli\/dl\/proc\/)?\d{4}[-/]\d{4}[A-Z]?(?:\([A-Z]+\))?$/,
        )
        .describe(
          'Procedure YYYY-NNNN or YYYY/NNNN, optional letter suffix and (TYPE), eli/dl/proc/ prefix or public URI.',
        ),
      section: sectionSchema
        .default('overview')
        .describe(
          'Default overview returns scalars and counts; a collection section pages its items.',
        ),
      ...pagingInputFields('procedure_sections'),
      snapshot: optionalString().describe('Returned collection snapshot; required above offset 0.'),
    })
    .strict(),
  output: z
    .object({
      found: z.boolean().describe('Whether Parliament published procedure detail.'),
      procedure_id: z.string().describe('Normalized procedure ID.'),
      reference: z.string().optional().describe('Exact published procedure reference.'),
      title: localizedTextSchema.optional().describe('Published procedure title.'),
      process_type: z.string().optional().describe('Published procedure type.'),
      stage: z.string().optional().describe('Published current procedure stage.'),
      source_url: z.string().describe('Public procedure source URL.'),
      section: sectionSchema,
      available_sections: z
        .array(
          z
            .object({
              name: z.string().describe('Section name.'),
              count: z
                .number()
                .int()
                .nonnegative()
                .describe('Parsed item count; absent relations do not prove no activity.'),
            })
            .strict()
            .describe('One section and its count.'),
        )
        .optional()
        .describe('Section counts on a found overview only.'),
      events: z
        .array(eventSchema)
        .optional()
        .describe('Events section page in date order, undated last, ties by id.'),
      participants: z
        .array(participantSchema)
        .optional()
        .describe('Participants section page in date order, undated last, ties by id.'),
      documents: z
        .array(documentSchema)
        .optional()
        .describe('Documents section page, deduplicated, sorted by document_id.'),
      page: pageSchema
        .optional()
        .describe('Collection page position; absent on overview or missing detail.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An identifier, citation type or language is unsupported or conflicts with the published procedure.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Overview has a nonzero offset, or continuation lacks its snapshot.',
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
    const result = await getEuParliamentService().getProcedure(serviceInput(input), ctx);
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? pageSchema.parse(result.data.page) : undefined,
    );
    return result.data;
  },
  format: (result) => formatResult(serviceInput(result)),
});
