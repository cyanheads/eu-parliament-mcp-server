/**
 * @fileoverview Tenth-term speech metadata discovery and detail retrieval.
 * @module mcp-server/tools/definitions/search-speeches.tool
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

const speechSchema = z
  .object({
    speech_id: z
      .string()
      .describe('Canonical activity identifier accepted by this tool in get mode.'),
    date: z.string().optional().describe('Published activity date.'),
    start_time: z.string().optional().describe('Published activity start timestamp.'),
    end_time: z.string().optional().describe('Published activity end timestamp.'),
    title: localizedTextSchema
      .optional()
      .describe('Published activity label and its actual selected language; not a transcript.'),
    activity_type: z.string().optional().describe('Published speech activity-type code or URI.'),
    participants: z
      .array(
        z
          .object({
            person_ids: z
              .array(z.string().describe('Canonical person identifier accepted by euparl_get_mep.'))
              .describe('Published person participants for this participation.'),
            role: z.string().optional().describe('Published participation role.'),
          })
          .strict()
          .describe('Published speech participation.'),
      )
      .describe('All published speech participations, preserving order.'),
    document_ids: z
      .array(z.string().describe('Canonical recording document identifier.'))
      .describe(
        'Published recording documents; use euparl_search_documents mode get, then follow parent_document_ids if needed.',
      ),
    source_url: z.string().describe('Public speech activity source URL.'),
  })
  .strict()
  .describe(
    'Speech activity metadata and source-document references, without extracted spoken text.',
  );

/** Find tenth-term speech activities and follow their published document IDs. */
export const searchSpeechesTool = tool('euparl_search_speeches', {
  title: 'Search parliamentary speeches',
  description:
    'Search speech activities in the tenth parliamentary term or retrieve one with mode get and speech_id. Text and title search return activity metadata, not transcripts. Follow document_ids with euparl_search_documents mode get and any returned parent_document_ids to source files. Use euparl_list_reference topic activity_types for activity_type codes; older-term search is unavailable. Get rejects search filters and nondefault paging; continue search with page.next_offset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      mode: z
        .enum(['search', 'get'])
        .default('search')
        .describe(
          'Default search discovers speech activities; get requires speech_id and rejects search filters.',
        ),
      speech_id: optionalString().describe(
        'Get-only canonical activity ID, eli/dl/event/ prefix or exact public URI.',
      ),
      text: optionalString().describe(
        'Search-only keywords in the selected language; matching does not guarantee transcript output.',
      ),
      title: optionalString().describe(
        'Search-only published activity title keywords in the selected language.',
      ),
      person_id: optionalString().describe(
        'Search-only numeric MEP identifier, person/ prefix or exact public person URI.',
      ),
      activity_type: optionalString().describe(
        'Search-only code from euparl_list_reference topic activity_types; case-insensitive and whitespace-trimmed.',
      ),
      sitting_date: optionalString().describe(
        'Search-only sitting date YYYY-MM-DD; start date when a range end is supplied.',
      ),
      sitting_date_end: optionalString().describe(
        'Search-only inclusive end date YYYY-MM-DD; requires sitting_date and cannot precede it.',
      ),
      ...pagingInputFields,
    })
    .strict(),
  output: z
    .object({
      mode: z.enum(['search', 'get']).describe('Executed speech retrieval mode.'),
      items: z
        .array(speechSchema)
        .optional()
        .describe('Whole speech activity records on the search page; absent in get mode.'),
      page: pageSchema.optional().describe('Search continuation metadata; absent in get mode.'),
      found: z
        .boolean()
        .optional()
        .describe('Get-only publication result; false for missing or empty detail.'),
      speech: speechSchema.optional().describe('Published activity detail when get succeeds.'),
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An activity code, identifier, language or date range is unsupported.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Get lacks speech_id, supplies search filters or nondefault paging; search supplies speech_id.',
      recovery:
        'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.',
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
    const result = await getEuParliamentService().searchSpeeches(serviceInput(input), ctx);
    ctx.enrich({ appliedFilters: result.enrichment.appliedFilters });
    applyEnrichment(
      ctx.enrich,
      result.enrichment,
      'page' in result.data ? result.data.page : undefined,
    );
    return result.data;
  },
  format: ({ mode, items, page, found, speech }) =>
    formatResult(serviceInput({ mode, items, page, found, speech })),
});
