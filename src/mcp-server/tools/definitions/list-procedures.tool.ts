/**
 * @fileoverview Sparse procedure reference discovery.
 * @module mcp-server/tools/definitions/list-procedures.tool
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

const procedureSchema = z
  .object({
    procedure_id: z.string().describe('Procedure ID for euparl_get_procedure.'),
    reference: z.string().optional().describe('Exact published procedure reference, not a title.'),
    process_type: z.string().optional().describe('Published procedure type code or URI.'),
    source_url: z.string().describe('Public procedure source URL.'),
  })
  .strict()
  .describe('Procedure catalogue row.');

/** List sparse procedure references without fetching every detail. */
export const listProceduresTool = tool('euparl_list_procedures', {
  title: 'List parliamentary procedures',
  description:
    'List procedure references by procedure type; euparl_get_procedure reads a returned procedure_id for title, stage and participants. euparl_list_reference topic procedure_types lists process_type codes. There is no keyword, year, committee or stage filter. With process_type, every procedure of that type is listed in procedure_id order; continue with page.next_offset, passing page.snapshot to detect a changed set. Without it, only the first 10000 results are reachable and Parliament serves pages from two orderings, so pages can repeat or omit procedures; set process_type for a complete walk.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z
    .object({
      process_type: optionalString().describe(
        'Procedure-type code from euparl_list_reference topic procedure_types, any case.',
      ),
      ...pagingInputFields('procedures', 'local_procedures'),
      snapshot: optionalString().describe(
        'page.snapshot of a process_type listing; optional at every offset, fails snapshot_changed if the set changed; rejected without process_type.',
      ),
    })
    .strict(),
  output: z
    .object({
      items: z.array(procedureSchema).describe('Procedures on this page.'),
      page: pageSchema,
    })
    .strict(),
  enrichment: enrichmentFields,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A procedure type or language is unsupported, or an offset without process_type reaches the 10000-result search window.',
      recovery:
        'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_mode_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'snapshot is supplied without process_type.',
      recovery:
        'Remove snapshot, or repeat the call with the process_type of the listing that returned it.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The process_type set changed since the supplied snapshot.',
      recovery:
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_paging_stalled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A process_type read came back incomplete or reached the 10000-result window.',
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
    const result = await getEuParliamentService().listProcedures(serviceInput(input), ctx);
    applyEnrichment(ctx.enrich, result.enrichment, result.data.page);
    return result.data;
  },
  format: ({ items, page }) => formatResult({ items, page }),
});
