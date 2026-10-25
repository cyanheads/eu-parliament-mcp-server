/**
 * @fileoverview Fixed-origin Parliament JSON-LD transport with operation-wide budgets.
 * @module services/eu-parliament/eu-parliament-client
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  invalidParams,
  McpError,
  rateLimited,
  serializationError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { z } from 'zod';
import packageMetadata from '../../../package.json' with { type: 'json' };

const origin = 'https://data.europarl.europa.eu/';
const lists = ['offset', 'limit'];
const allowlists = new Map<string, readonly string[]>([
  ['procedures', [...lists, 'process-type']],
  ['corporate-bodies', [...lists, 'body-classification']],
  [
    'adopted-texts',
    [
      ...lists,
      'text',
      'title',
      'search-language',
      'year',
      'work-type',
      'parliamentary-term',
      'sitting-date',
      'sitting-date-end',
      'related-process-id',
      'view',
    ],
  ],
  ['committee-documents', [...lists, 'work-type', 'parliamentary-term']],
  ['plenary-documents', [...lists, 'work-type', 'year']],
  [
    'speeches',
    [
      ...lists,
      'text',
      'title',
      'search-language',
      'person-id',
      'activity-type',
      'sitting-date',
      'sitting-date-end',
      'parliamentary-term',
    ],
  ],
  [
    'meps',
    [...lists, 'parliamentary-term', 'country-of-representation', 'political-group', 'gender'],
  ],
  ['meps/show-current', [...lists, 'country-of-representation', 'political-group', 'gender']],
  ['meetings', [...lists, 'year']],
  ['parliamentary-questions', [...lists, 'year', 'work-type']],
]);

/** One budget shared by every request in a domain operation. */
export interface Operation {
  callerSignal: AbortSignal;
  deadlineAt: number;
  signal: AbortSignal;
}
/** Injectable transport and pacing clock; wait must reject when its signal aborts. */
export interface ClientOptions {
  fetch: typeof globalThis.fetch;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** Parsed response, distinguishing empty and missing before reading a body. */
export interface Envelope<T> {
  data: T[];
  next?: string | number;
  status: 'ok' | 'empty' | 'missing';
  total?: number;
}
const metadata = z
  .object({
    total: z.number().int().nonnegative().optional(),
    next: z.union([z.string(), z.number()]).nullish(),
  })
  .optional();

/** Only constructs fixed-origin routes and never downloads linked files. */
export class EuParliamentClient {
  readonly now: () => number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private nextStart = 0;
  private pending = 0;
  constructor(options: ClientOptions) {
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal });
      });
  }
  /** Starts the 40-second deadline before acquisition or queueing. */
  operation(callerSignal: AbortSignal): Operation {
    return {
      callerSignal,
      signal: AbortSignal.any([callerSignal, AbortSignal.timeout(40_000)]),
      deadlineAt: this.now() + 40_000,
    };
  }
  private check(operation: Operation): void {
    operation.callerSignal.throwIfAborted();
    if (operation.signal.aborted || this.now() >= operation.deadlineAt)
      throw timeout(
        'Parliament lookup exceeded its 40-second deadline. Retry the complete lookup.',
      );
  }
  private async pace(operation: Operation): Promise<void> {
    this.check(operation);
    if (this.pending >= 100)
      throw serviceUnavailable('Parliament request queue is full. Retry later.', {
        retryable: false,
      });
    const start = Math.max(this.now(), this.nextStart);
    this.nextStart = start + 700;
    this.pending++;
    try {
      if (start > this.now()) await this.wait(start - this.now(), operation.signal);
    } catch (cause) {
      this.check(operation);
      throw cause;
    } finally {
      this.pending--;
    }
    this.check(operation);
  }
  /** Parses a fully read JSON-LD envelope against the noun schema. */
  async get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: z.ZodType<T>,
    operation: Operation,
  ): Promise<Envelope<T>> {
    if (!/^[A-Za-z0-9_/-]+$/.test(path)) throw new Error('Unsupported Parliament endpoint');
    const allowed =
      allowlists.get(path) ??
      (/^(?:procedures|documents|speeches|meps|parliamentary-questions)\/[^/]+$|^meetings\/[^/]+\/decisions$/.test(
        path,
      )
        ? []
        : undefined);
    if (!allowed) throw new Error('Unsupported Parliament endpoint');
    const url = new URL(`api/v2/${path}`, origin);
    for (const [key, value] of Object.entries(query)) {
      if (!allowed.includes(key)) throw new Error(`Unsupported query parameter: ${key}`);
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('format', 'application/ld+json');
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check(operation);
      await this.pace(operation);
      const attemptSignal = AbortSignal.any([
        operation.signal,
        AbortSignal.timeout(Math.min(15_000, operation.deadlineAt - this.now())),
      ]);
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetcher(url, {
          signal: attemptSignal,
          headers: {
            Accept: 'application/ld+json',
            'User-Agent': `eu-parliament-mcp-server/${packageMetadata.version}`,
          },
        });
        if (response.status === 204 || response.status === 404) {
          await response.body?.cancel();
          return { status: response.status === 204 ? 'empty' : 'missing', data: [] };
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 400 || response.status === 422)
            throw invalidParams(
              'Parliament rejected the validated request. Use supported identifiers and filters.',
              { reason: 'upstream_rejected', status: response.status },
            );
          const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
          const header = response.headers.get('retry-after');
          if (header) {
            const seconds = /^\d+$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - this.now();
            if (Number.isFinite(seconds)) retryAfterMs = Math.min(10_000, Math.max(0, seconds));
          }
          if (response.status === 429)
            throw rateLimited('Parliament rate limit reached. Wait before retrying.', {
              reason: 'upstream_rate_limited',
              retryable: true,
              ...(retryAfterMs !== undefined && { retry_after_ms: retryAfterMs }),
            });
          throw serviceUnavailable('Parliament could not serve the request. Retry later.', {
            status: response.status,
            retryable: transient,
          });
        }
        const text = await response.text();
        this.check(operation);
        attemptSignal.throwIfAborted();
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (cause) {
          throw serializationError(
            'Parliament returned malformed JSON-LD.',
            { retryable: false },
            { cause },
          );
        }
        const parsed = z
          .object({
            data: z.array(schema),
            meta: metadata,
            next: z.union([z.string(), z.number()]).nullish(),
          })
          .safeParse(value);
        if (!parsed.success)
          throw serializationError(
            'Parliament returned an unexpected JSON-LD record shape.',
            { retryable: false },
            { cause: parsed.error },
          );
        const next = parsed.data.meta?.next ?? parsed.data.next;
        return {
          status: 'ok',
          data: parsed.data.data,
          ...(parsed.data.meta?.total !== undefined && { total: parsed.data.meta.total }),
          ...(next != null && { next }),
        };
      } catch (cause) {
        this.check(operation);
        const transient =
          cause instanceof McpError
            ? cause.data?.retryable === true ||
              (cause.data?.retryable !== false && cause.code === -32000)
            : cause instanceof TypeError ||
              (cause instanceof Error && (cause.name === 'TimeoutError' || attemptSignal.aborted));
        if (!transient || attempt === 2) {
          if (cause instanceof McpError) throw cause;
          if (attemptSignal.aborted)
            throw timeout('Parliament request timed out after bounded retries.', undefined, {
              cause,
            });
          if (cause instanceof TypeError)
            throw serviceUnavailable(
              'Parliament network request failed after bounded retries.',
              undefined,
              { cause },
            );
          throw cause;
        }
        try {
          await this.wait(retryAfterMs ?? 1000 * 2 ** attempt, operation.signal);
        } catch (waitError) {
          this.check(operation);
          throw waitError;
        }
      }
    }
    throw new Error('Unreachable retry state');
  }
}
