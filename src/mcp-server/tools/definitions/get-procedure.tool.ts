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
import { getEuParliamentService } from '@/services/eu-parliament/eu-parliament-service.js';

const eventSchema = z
  .object({
    id: z.string().describe('Published canonical event identifier.'),
    date: z.string().optional().describe('Published activity date.'),
    activity_type: z.string().optional().describe('Published activity type code or URI.'),
    stage: z.string().optional().describe('Published event stage.'),
    document_ids: z
      .array(z.string().describe('Canonical related document identifier.'))
      .describe('Explicit event document relations, deduplicated in first-seen order.'),
    sitting_ids: z
      .array(z.string().describe('Canonical scheduled sitting identifier.'))
      .describe(
        'Explicit scheduled sitting relations; when absent, a published vote-event date can select a sitting for euparl_get_plenary_votes decisions with document_id.',
      ),
  })
  .strict()
  .describe('Published procedure event.');
const participantSchema = z
  .object({
    id: z.string().describe('Published participation identity.'),
    person_ids: z
      .array(z.string().describe('Canonical person identifier.'))
      .describe('Explicit participating people.'),
    organization_ids: z
      .array(z.string().describe('Published organization identity.'))
      .describe('Explicit participating organizations.'),
    role: z.string().optional().describe('Published historical participation role.'),
    date: z.string().optional().describe('Published participation date.'),
    stage: z.string().optional().describe('Published participation stage.'),
    political_group_id: z
      .string()
      .optional()
      .describe('Published historical political group; never joined to a current group.'),
    represented_organization_id: z
      .string()
      .optional()
      .describe('Published organization represented by this participation.'),
    term_id: z.string().optional().describe('Published parliamentary-term identity.'),
  })
  .strict()
  .describe('Historical procedure participation.');
const documentSchema = z
  .object({
    document_id: z
      .string()
      .describe('Canonical document identifier for euparl_search_documents mode get.'),
    source_url: z.string().describe('Public document source URL.'),
  })
  .strict()
  .describe('Explicit linked parliamentary document; no inferred title or legal identifier.');
const sectionSchema = z
  .enum(['overview', 'events', 'participants', 'documents'])
  .describe('Procedure retrieval section.');

/** Read procedure identity and one complete evidence section at a time. */
export const getProcedureTool = tool('euparl_get_procedure', {
  title: 'Read a parliamentary procedure',
  description:
    'Read a procedure title, stage, events, participants, or linked parliamentary documents. Default section overview returns scalar fields and collection counts; events, participants, and documents page one selected collection. Continue with page.next_offset and the returned snapshot; restart at offset 0 without snapshot if the collection changes. Historical participation groups remain historical. Missing detail succeeds with found false; discover references with euparl_list_procedures. Linked documents can be read with euparl_search_documents mode get; files are linked, not parsed.',
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
          'Procedure YYYY-NNNN or YYYY/NNNN, optional letter suffix and (TYPE), known eli/dl/proc/ prefix or exact public procedure URI.',
        ),
      section: sectionSchema
        .default('overview')
        .describe(
          'Default overview returns scalars and counts; choose a collection for complete paged items.',
        ),
      ...pagingInputFields,
      snapshot: optionalString().describe(
        'Previous collection snapshot; required for local offset above 0, optional at offset 0.',
      ),
    })
    .strict(),
  output: z
    .object({
      found: z.boolean().describe('Whether Parliament published procedure detail.'),
      procedure_id: z.string().describe('Normalized canonical procedure identifier.'),
      reference: z.string().optional().describe('Exact published procedure reference.'),
      title: localizedTextSchema
        .optional()
        .describe('Published procedure title in the actual selected language.'),
      process_type: z.string().optional().describe('Published procedure type.'),
      stage: z.string().optional().describe('Published current procedure stage.'),
      source_url: z.string().describe('Public procedure source URL.'),
      section: sectionSchema,
      available_sections: z
        .array(
          z
            .object({
              name: z.string().describe('Collection section name.'),
              count: z
                .number()
                .int()
                .nonnegative()
                .describe(
                  'Exact parsed collection size; absence of relations does not prove no activity.',
                ),
            })
            .strict()
            .describe('Available section and parsed item count.'),
        )
        .optional()
        .describe('Section counts on a found overview only.'),
      events: z
        .array(eventSchema)
        .optional()
        .describe('Selected event page, present only for the events section.'),
      participants: z
        .array(participantSchema)
        .optional()
        .describe('Selected historical participation page, present only for participants.'),
      documents: z
        .array(documentSchema)
        .optional()
        .describe('Selected deduplicated linked-document page, present only for documents.'),
      page: pageSchema
        .optional()
        .describe('Selected collection continuation; absent on overview or missing detail.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier, citation type or language is unsupported or conflicts with the published procedure.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Overview has a nonzero offset, or collection continuation lacks its snapshot.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The complete selected collection or its retrieval scope changed.',
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
