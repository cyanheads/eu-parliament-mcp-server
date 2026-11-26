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
    offset: z.number().int().nonnegative().describe('Zero-based offset of this page.'),
    limit: z
      .number()
      .int()
      .positive()
      .describe('Effective page size after caps and the search window.'),
    returned: z.number().int().nonnegative().describe('Items on this page.'),
    has_more: z.boolean().describe('True when more matches exist or cannot be ruled out.'),
    next_offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Offset of the next page; absent at the search-window boundary even when has_more is true.',
      ),
    snapshot: z
      .string()
      .optional()
      .describe('Pass back with next_offset to continue this local collection.'),
  })
  .strict()
  .describe('Page position.');
/** Published text and the actual selected source language. */
export const localizedTextSchema = z
  .object({
    value: z.string().describe('Published text.'),
    language: z.string().describe('Actual language of the text.'),
  })
  .strict()
  .describe('Published localized text.');
/** A document title: `value` is the first published title, `values` every one when there are several. */
export const localizedTitleSchema = localizedTextSchema
  .extend({
    value: z.string().describe('Published title; the first of several.'),
    values: z
      .array(z.string().describe('Published title.'))
      .min(2)
      .optional()
      .describe('Every title in this language, in published order; only when there are several.'),
  })
  .strict()
  .describe('Published title.');
/**
 * Published file link with unmodified optional metadata. Several issue dates or sizes published for
 * one language and format (one manifestation) name no file, so each of its links carries the list.
 */
export const linkSchema = z
  .object({
    url: z.string().describe('Absolute public file URL.'),
    media_type: z.string().optional().describe('Published media type.'),
    language: z.string().optional().describe('Published expression language.'),
    issued: z
      .string()
      .optional()
      .describe('Published issue date; absent when issued_values lists several.'),
    issued_values: z
      .array(z.string().describe('Published issue date.'))
      .min(2)
      .optional()
      .describe(
        'Every issue date of this language and format when several, in published order; none names a file, so every link of the format carries the list.',
      ),
    size_bytes: z
      .string()
      .optional()
      .describe(
        'Published byte size, a decimal string; absent when size_bytes_values lists several.',
      ),
    size_bytes_values: z
      .array(z.string().describe('Published byte size, a decimal string.'))
      .min(2)
      .optional()
      .describe(
        'Every byte size of this language and format when several, decimal strings in published order; none names a file, so every link of the format carries the list.',
      ),
  })
  .strict()
  .describe('Published source-file link.');
const wholeNumber = 'limit must be a whole number.';
const capList = (collections: readonly PagedCollection[]) =>
  new Intl.ListFormat('en', { type: 'disjunction' }).format(
    collections
      .filter((collection) => pageCaps[collection].maximum < Number.MAX_SAFE_INTEGER)
      .map((collection) => `${pageCaps[collection].maximum} ${pageCaps[collection].noun}`),
  );
/** The largest limit EUPARL_CLAMP_LIMITS=false accepts for `collection`. */
function strictMaximum(collection: PagedCollection): number {
  const caps = pageCaps[collection];
  return 'strictMaximum' in caps ? caps.strictMaximum : caps.maximum;
}
/**
 * Whole-item `limit` for a tool paging `collections`. With clamping on (the default) a larger
 * value is accepted and the service clamps it to the collection cap, so the schema advertises no
 * `maximum`: `multipleOf(1)` stands in for `.int()`, which Zod 4 emits with
 * `maximum: 9007199254740991`, and the integer refinement catches float noise `multipleOf`
 * tolerates. With EUPARL_CLAMP_LIMITS=false a fully bounded tool's largest strict bound is
 * enforced and advertised; mixed tools keep local modes open. A strict bound above every page cap
 * (adopted texts, non-keyword speeches and MEP declarations accept their search window) answers
 * with the selected mode's cap.
 * The mode is read per call and per `tools/list` emission (the `.meta()` getters), never when
 * the definition module is imported, which happens before `setup()` parses the environment.
 */
function limitInput(collections: readonly [PagedCollection, ...PagedCollection[]]) {
  const maximum = Math.max(...collections.map(strictMaximum));
  // Some mode's cap sits below the strict bound, so an accepted limit can still narrow there.
  const narrows = collections.some((collection) => pageCaps[collection].maximum < maximum);
  return z
    .number()
    .multipleOf(1, wholeNumber)
    .min(1)
    .refine(Number.isInteger, { message: wholeNumber, when: ({ issues }) => issues.length === 0 })
    .check((payload) => {
      if (!clampLimits() && maximum < Number.MAX_SAFE_INTEGER && payload.value > maximum)
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
        return clampLimits() || maximum === Number.MAX_SAFE_INTEGER ? undefined : maximum;
      },
      get description() {
        const bounded = collections.filter(
          (collection) => pageCaps[collection].maximum < Number.MAX_SAFE_INTEGER,
        );
        const local = collections.some(
          (collection) => pageCaps[collection].maximum === Number.MAX_SAFE_INTEGER,
        );
        const larger =
          !clampLimits() && !local
            ? `above ${maximum} is rejected${narrows ? ", and a smaller limit above the mode's cap narrows to it with a notice" : ''}`
            : 'a larger limit narrows to the cap with a notice';
        return `Items per page; default 20.${local ? ' Local collections return every requested row, with no output-size cap.' : ''}${bounded.length ? ` Caps: ${capList(bounded)}; ${larger}.` : ''}`;
      },
    });
}
/** Paging fields for a tool whose pages draw from `collections`; `limit` states their caps. */
export function pagingInputFields(...collections: [PagedCollection, ...PagedCollection[]]) {
  return {
    offset: z.number().int().nonnegative().default(0).describe('Zero-based offset; default 0.'),
    limit: limitInput(collections),
    language: optionalString().describe(
      'EU ISO 639-1 language, any case; default en; text is never translated.',
    ),
  };
}
/** Common result-set context, rendered completely on both surfaces. */
export const enrichmentFields = {
  appliedFilters: z.record(z.string(), z.unknown()).describe('Normalized scope and filters.'),
  notice: z
    .string()
    .optional()
    .describe('Publication, language fallback, empty-result or continuation guidance.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact total; only when published or counted over the whole collection.'),
  available: z
    .boolean()
    .optional()
    .describe('Whether the source array was published; a published empty array counts.'),
  truncated: z
    .boolean()
    .optional()
    .describe('True when this page holds only part of the collection.'),
  shown: z.number().int().nonnegative().optional().describe('Items on this partial page.'),
  cap: z.number().int().positive().optional().describe('Effective page limit.'),
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
