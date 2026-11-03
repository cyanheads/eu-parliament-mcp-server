/**
 * @fileoverview Shared lossless Parliament response rendering and field schemas.
 * @module mcp-server/tools/utils/eu-parliament-tool
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { clampLimits } from '@/config/server-config.js';
import {
  type PagedCollection,
  pageCaps,
} from '@/services/eu-parliament/eu-parliament-normalization.js';
import { fieldPathText } from '@/services/eu-parliament/eu-parliament-rendering.js';
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
    limit: z
      .number()
      .int()
      .positive()
      .describe(
        "Effective whole-item page size: the requested limit, clamped to the collection's page cap and, on a 10000-result search, to the results left in the window.",
      ),
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
const wholeNumber = 'limit must be a whole number.';
const capList = (collections: readonly PagedCollection[]) =>
  new Intl.ListFormat('en', { type: 'disjunction' }).format(
    collections.map((collection) => `${pageCaps[collection].maximum} ${pageCaps[collection].noun}`),
  );
/**
 * Whole-item `limit` for a tool paging `collections`. With clamping on (the default) a larger
 * value is accepted and the service clamps it to the collection cap, so the schema advertises no
 * `maximum`: `multipleOf(1)` stands in for `.int()`, which Zod 4 emits with
 * `maximum: 9007199254740991`, and the integer refinement catches float noise `multipleOf`
 * tolerates. With EUPARL_CLAMP_LIMITS=false the tool's largest cap is enforced and advertised.
 * The mode is read per call and per `tools/list` emission (the `.meta()` getters), never when
 * the definition module is imported, which happens before `setup()` parses the environment.
 */
function limitInput(collections: readonly [PagedCollection, ...PagedCollection[]]) {
  const maximum = Math.max(...collections.map((collection) => pageCaps[collection].maximum));
  const smaller = collections.filter((collection) => pageCaps[collection].maximum < maximum);
  const clampText = (capped: readonly PagedCollection[]) =>
    `Pages hold at most ${capList(capped)}; a larger limit returns that many with a notice.`;
  return z
    .number()
    .multipleOf(1, wholeNumber)
    .min(1)
    .refine(Number.isInteger, { message: wholeNumber, when: ({ issues }) => issues.length === 0 })
    .check((payload) => {
      if (!clampLimits() && payload.value > maximum)
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum,
          inclusive: true,
          input: payload.value,
        });
    })
    .default(20)
    .meta({
      get maximum() {
        return clampLimits() ? undefined : maximum;
      },
      get description() {
        return clampLimits()
          ? `Whole items requested; default 20. ${clampText(collections)}`
          : `Whole items requested; default 20, at most ${maximum}.${smaller.length ? ` ${clampText(smaller)}` : ''}`;
      },
    });
}
/** Paging fields for a tool whose pages draw from `collections`; `limit` states their caps. */
export function pagingInputFields(...collections: [PagedCollection, ...PagedCollection[]]) {
  return {
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe('Zero-based collection offset; default 0.'),
    limit: limitInput(collections),
    language: optionalString().describe(
      'Supported EU ISO-639-1 language, case-insensitive; default en; source text is never translated.',
    ),
  };
}
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
/** Full field-path response twin; a blank line keeps each value independent. */
export function formatResult(value: unknown) {
  return [{ type: 'text' as const, text: fieldPathText(value) }];
}
/** Structured enrichment needs a renderer rather than the generic object trailer. */
export const enrichmentTrailer = {
  appliedFilters: { render: (value: unknown) => fieldPathText(value, 'appliedFilters') },
  notice: { render: (value: unknown) => fieldPathText(value, 'notice') },
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
