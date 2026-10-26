/**
 * @fileoverview Shared lossless Parliament response rendering and field schemas.
 * @module mcp-server/tools/utils/eu-parliament-tool
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import type { Enrichment } from '@/services/eu-parliament/eu-parliament-service.js';

/** Accept form-client blank values without changing nonblank source text. */
export function optionalString(schema = z.string()) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

/** Omit parsed optional undefined values before passing exact optional service inputs. */
export function serviceInput<T extends object>(
  input: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
/** Shared whole-item list position and stateless continuation metadata. */
export const pageSchema = z
  .object({
    offset: z
      .number()
      .int()
      .nonnegative()
      .describe('Zero-based position in the selected collection.'),
    limit: z.number().int().positive().describe('Effective whole-item page size, at most 100.'),
    returned: z.number().int().nonnegative().describe('Number of complete items on this page.'),
    has_more: z
      .boolean()
      .describe(
        'Whether more matches are known or cannot be ruled out; a search window may prevent continuation.',
      ),
    next_offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Usable next offset when continuation is accessible; absent at a search-window boundary even if has_more is true.',
      ),
    snapshot: z
      .string()
      .optional()
      .describe(
        'Digest of the complete normalized local collection and scope; reuse for continuation.',
      ),
  })
  .strict()
  .describe('Whole-item page metadata.');
/** Published text and the actual selected source language. */
export const localizedTextSchema = z
  .object({
    value: z.string().describe('Exact published text.'),
    language: z.string().describe('Actual language of the published text.'),
  })
  .strict()
  .describe('Selected published localized text.');
/** Published file link with unmodified optional metadata. */
export const linkSchema = z
  .object({
    url: z.string().describe('Absolute public file URL.'),
    media_type: z.string().optional().describe('Published media type.'),
    language: z.string().optional().describe('Published expression language.'),
    issued: z.string().optional().describe('Published issue date.'),
    size_bytes: z.string().optional().describe('Published byte size retained as a decimal string.'),
  })
  .strict()
  .describe('Published source-file link.');
/** Paging fields shared by upstream and complete local collections. */
export const pagingInputFields = {
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Zero-based collection offset; default 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Whole items requested; default 20, effective maximum 100 with notice.'),
  language: optionalString().describe(
    'Supported EU ISO-639-1 language, case-insensitive; default en; source text is never translated.',
  ),
};
/** Common result-set context, rendered completely on both surfaces. */
export const enrichmentFields = {
  appliedFilters: z
    .record(
      z.string().describe('Normalized filter name.'),
      z.unknown().describe('Normalized filter value.'),
    )
    .describe('Actual normalized retrieval scope and filters.'),
  notice: z
    .string()
    .optional()
    .describe('Publication, language fallback, empty-result or continuation guidance.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact count only when published or computed over a complete collection.'),
  available: z
    .boolean()
    .optional()
    .describe(
      'Whether the selected source array was published, including a published empty array.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when this page returns only part of the selected collection.'),
  shown: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Whole items shown on this partial page.'),
  cap: z.number().int().positive().optional().describe('Effective whole-item page limit.'),
};
function quoted(value: string): string {
  const json = JSON.stringify(value);
  let longestRun = 0;
  for (const match of json.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${json} ${fence}`;
}
/** Render every scalar, empty container and array entry, retaining active URL links. */
function renderValue(value: unknown, path = 'result'): string {
  if (Array.isArray(value))
    return value.length
      ? value.map((item, index) => renderValue(item, `${path}[${index}]`)).join('\n')
      : `${path}: []`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length
      ? entries.map(([key, item]) => renderValue(item, `${path}.${key}`)).join('\n')
      : `${path}: {}`;
  }
  if (typeof value === 'string') {
    const text = quoted(value);
    return `${path}: ${/^https?:\/\/[^\s<>]*$/.test(value) ? `[${text}](<${value.replaceAll('\\', '%5C')}>)` : text}`;
  }
  return `${path}: ${String(value)}`;
}
/** Full field-path response twin; a blank line keeps each value independent. */
export function formatResult(value: unknown) {
  return [{ type: 'text' as const, text: renderValue(value).replaceAll('\n', '\n\n') }];
}
/** Structured enrichment needs a renderer rather than the generic object trailer. */
export const enrichmentTrailer = {
  appliedFilters: {
    render: (value: unknown) => renderValue(value, 'appliedFilters').replaceAll('\n', '\n\n'),
  },
  notice: { render: (value: unknown) => renderValue(value, 'notice') },
};
/** Apply filters, availability, notices, exact totals and page-cap disclosure; notices survive truncation. */
export function applyEnrichment(
  enrich: Context['enrich'],
  metadata: Enrichment,
  page?: z.infer<typeof pageSchema>,
): void {
  enrich({
    appliedFilters: metadata.appliedFilters,
    ...(metadata.available !== undefined && { available: metadata.available }),
  });
  if (page?.has_more)
    enrich.truncated({
      shown: page.returned,
      cap: page.limit,
      guidance: [
        metadata.notice,
        page.next_offset !== undefined
          ? `Continue with offset ${page.next_offset}${page.snapshot ? ' and the returned snapshot' : ''}.`
          : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    });
  else if (metadata.notice !== undefined) enrich.notice(metadata.notice);
  if (metadata.totalCount !== undefined) enrich.total(metadata.totalCount);
}
