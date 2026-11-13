/** @fileoverview HTTP-boundary checks for Parliament transport and operation budgets. */
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EuParliamentClient } from '../../../src/services/eu-parliament/eu-parliament-client.js';
import { envelopeResponse } from '../../helpers/eu-parliament-fixtures.js';

const record = z.object({ identifier: z.string() });
const signal = () => new AbortController().signal;
const instantWait = async () => {};

afterEach(() => vi.useRealTimers());

describe('EuParliamentClient', () => {
  it.each([
    ['adopted-texts', 'doc-id:asc'],
    ['speeches', 'sitting-date:asc,numbering:asc'],
  ])('forwards the verified %s sorting key', async (path, sort) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelopeResponse([{ identifier: 'example' }]));
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    await client.get(path!, { 'sort-by': sort }, record, client.operation(signal()));
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('sort-by')).toBe(sort);
    await expect(
      client.get(
        'parliamentary-questions',
        { 'sort-by': sort },
        record,
        client.operation(signal()),
      ),
    ).rejects.toThrow('Unsupported query parameter: sort-by');
  });
  it.each([204, 404])(
    'checks cancellation before accepting an HTTP %i empty response',
    async (status) => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        controller.abort(new DOMException('Caller stopped', 'AbortError'));
        return new Response(null, { status });
      });
      const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
      await expect(
        client.get('meps', {}, record, client.operation(controller.signal)),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('checks the shared deadline before accepting a missing candidate', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now = 40001;
      return new Response(null, { status: 404 });
    });
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait, now: () => now });
    await expect(
      client.get(
        'parliamentary-questions/E-10-2025-900001',
        {},
        record,
        client.operation(signal()),
      ),
    ).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('classifies HTTP 403 as a permanent upstream rejection without retry-later guidance', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('private trace', { status: 403 }));
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    const pending = client.get('speeches', { text: 'blocked' }, record, client.operation(signal()));
    await expect(pending).rejects.toMatchObject({
      data: { reason: 'upstream_rejected', retryable: false },
    });
    await expect(pending).rejects.not.toThrow(/Retry later/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses fixed origin, explicit negotiation, and encoded query values', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelopeResponse([{ identifier: 'example' }]));
    const client = new EuParliamentClient({ fetch: fetcher });
    expect(
      await client.get(
        'adopted-texts',
        { text: 'climate & energy', limit: 1 },
        record,
        client.operation(signal()),
      ),
    ).toEqual({ status: 'ok', data: [{ identifier: 'example' }] });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://data.europarl.europa.eu/api/v2/adopted-texts?text=climate+%26+energy&limit=1&format=application%2Fld%2Bjson',
    );
    expect(init?.headers).toMatchObject({ Accept: 'application/ld+json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends language on the adopted-texts list route only, where it replaces view', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher });
    await client.get(
      'adopted-texts',
      { offset: 0, limit: 100, language: 'hr', 'search-language': 'hr' },
      record,
      client.operation(signal()),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://data.europarl.europa.eu/api/v2/adopted-texts?offset=0&limit=100&language=hr&search-language=hr&format=application%2Fld%2Bjson',
    );
    for (const [path, query] of [
      ['adopted-texts', { view: 'list' }],
      ['committee-documents', { language: 'en' }],
      ['plenary-documents', { language: 'en' }],
    ] as const)
      await expect(client.get(path, query, record, client.operation(signal()))).rejects.toThrow(
        `Unsupported query parameter: ${Object.keys(query)[0]}`,
      );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['adopted-texts', 'committee-documents', 'plenary-documents'])(
    'reads the %s family record with only the language query',
    async (family) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
      const client = new EuParliamentClient({ fetch: fetcher });
      await client.get(
        `${family}/TA-9-2024-0138`,
        { language: 'mul' },
        record,
        client.operation(signal()),
      );
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        `https://data.europarl.europa.eu/api/v2/${family}/TA-9-2024-0138?language=mul&format=application%2Fld%2Bjson`,
      );
    },
  );

  it.each([
    [
      'speeches',
      { offset: 0, limit: 100, 'include-output': 'xml_fragment', language: 'en' },
      'speeches?offset=0&limit=100&include-output=xml_fragment&language=en',
    ],
    [
      'speeches/MTG-PL-2024-03-12-OTH-22050000',
      { 'include-output': 'xml_fragment', language: 'en' },
      'speeches/MTG-PL-2024-03-12-OTH-22050000?include-output=xml_fragment&language=en',
    ],
  ])('sends the speech text options on %s', async (path, query, route) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher });
    await client.get(path, query, record, client.operation(signal()));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://data.europarl.europa.eu/api/v2/${route}&format=application%2Fld%2Bjson`,
    );
  });

  it.each([
    ['speeches/S-1', { limit: 1 }],
    ['speeches/S-1', { 'search-language': 'en' }],
    ['speeches/S-1/x', { language: 'en' }],
    ['documents/ABC', { 'include-output': 'xml_fragment' }],
    ['parliamentary-questions/E-10-2025-000001', { language: 'en' }],
    ['parliamentary-questions', { 'include-output': 'xml_fragment' }],
  ])('keeps speech text options off other routes: %s %j', async (path, query) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new EuParliamentClient({ fetch: fetcher });
    await expect(client.get(path, query, record, client.operation(signal()))).rejects.toThrow(
      /^Unsupported (?:query parameter|Parliament endpoint)/,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['https://evil.example/x', {}],
    ['meps', { text: 'ignored upstream' }],
    ['meps', { 'mandate-date': '2024-03-13' }],
    ['documents/ABC', { limit: 1 }],
    ['documents/ABC', { language: 'mul' }],
    ['procedures/2021-0106', { language: 'mul' }],
    ['corporate-bodies/IMCO', { language: 'mul' }],
    ['adopted-texts/TA-1', { limit: 1 }],
    ['plenary-documents/A-1', { 'work-type': 'REPORT_PLENARY' }],
    ['committee-documents/A/B', { language: 'mul' }],
    ['external-documents/SP-1', { language: 'mul' }],
  ])('rejects unapproved path/query before fetch: %s', async (path, query) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new EuParliamentClient({ fetch: fetcher });
    await expect(client.get(path, query, record, client.operation(signal()))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends mandate-date on the current-roster route', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher });
    await client.get(
      'meps/show-current',
      { 'mandate-date': '2024-03-13', 'country-of-representation': 'MT' },
      record,
      client.operation(signal()),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://data.europarl.europa.eu/api/v2/meps/show-current?mandate-date=2024-03-13&country-of-representation=MT&format=application%2Fld%2Bjson',
    );
  });

  it('reads a sitting vote-results route with only the format query', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher });
    await client.get(
      'meetings/MTG-PL-2024-03-13/vote-results',
      {},
      record,
      client.operation(signal()),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://data.europarl.europa.eu/api/v2/meetings/MTG-PL-2024-03-13/vote-results?format=application%2Fld%2Bjson',
    );
  });

  it.each([{ offset: 0 }, { limit: 50 }, { language: 'en' }])(
    'rejects the vote-results paging and language query %j before fetch',
    async (query) => {
      const fetcher = vi.fn<typeof fetch>();
      const client = new EuParliamentClient({ fetch: fetcher });
      await expect(
        client.get(
          'meetings/MTG-PL-2024-03-13/vote-results',
          query,
          record,
          client.operation(signal()),
        ),
      ).rejects.toThrow(`Unsupported query parameter: ${Object.keys(query)[0]}`);
      await expect(
        client.get(
          'meetings/MTG-PL-2024-03-13/vote-results/x',
          {},
          record,
          client.operation(signal()),
        ),
      ).rejects.toThrow('Unsupported Parliament endpoint');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    'documents/..',
    'documents/%2e%2e',
    'documents/ABC?text=unapproved',
    'documents/ABC#fragment',
  ])('rejects detail identifiers that change URL routing: %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher });
    await expect(client.get(path, {}, record, client.operation(signal()))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [204, 'empty'],
    [404, 'missing'],
  ] as const)('handles empty %i before body parsing', async (status, resultStatus) => {
    const response = new Response(null, { status });
    const read = vi.spyOn(response, 'text');
    const client = new EuParliamentClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    expect(await client.get('meps', {}, record, client.operation(signal()))).toEqual({
      status: resultStatus,
      data: [],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['not json', '{"@graph":[]}', '{"data":[{"identifier":42}]}'])(
    'does not retry malformed successful bodies: %s',
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
      await expect(
        client.get('meps', {}, record, client.operation(signal())),
      ).rejects.toMatchObject({ data: { retryable: false } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a response body read failure as part of the GET attempt', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('connection interrupted'));
        },
      }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(envelopeResponse([{ identifier: 'after-retry' }]));
    const waits: number[] = [];
    const client = new EuParliamentClient({
      fetch: fetcher,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await client.get('meps', {}, record, client.operation(signal()))).toMatchObject({
      data: [{ identifier: 'after-retry' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toContain(1000);
  });

  it.each([400, 401, 403, 422])('does not retry permanent HTTP %i', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('internal trace must stay private', { status }));
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    await expect(client.get('meps', {}, record, client.operation(signal()))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'bounds transient HTTP %i to three attempts',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response('<html>gateway trace</html>', {
            status,
            headers: { 'retry-after': '999' },
          }),
      );
      const waits: number[] = [];
      const client = new EuParliamentClient({
        fetch: fetcher,
        wait: async (ms) => {
          waits.push(ms);
        },
      });
      const error = await client
        .get('meps', {}, record, client.operation(signal()))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain('gateway trace');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(waits.filter((ms) => ms === 10_000)).toHaveLength(2);
    },
  );

  it.each([429, 503])(
    'makes one attempt when the caller bounds a read to one: HTTP %i',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      const waits: number[] = [];
      const client = new EuParliamentClient({
        fetch: fetcher,
        wait: async (ms) => {
          waits.push(ms);
        },
      });
      await expect(
        client.get('meps', {}, record, client.operation(signal()), { attempts: 1 }),
      ).rejects.toMatchObject({ data: { retryable: true } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    },
  );

  it.each([
    ['7', 0, 7000, 7],
    ['Thu, 01 Jan 1970 00:00:03 GMT', 700, 2300, 3],
    ['Thu, 01 Jan 1970 00:00:01 GMT', 700, 300, 1],
    ['999', 0, 10_000, 999],
    ['0', 0, 0, 0],
  ])(
    'reports a persistent 429 with Retry-After %j at clock %i as retry_after_ms %i and retryAfter %i seconds',
    async (header, now, retry_after_ms, retryAfter) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () => new Response(null, { status: 429, headers: { 'retry-after': header } }),
        );
      const waits: number[] = [];
      const client = new EuParliamentClient({
        fetch: fetcher,
        now: () => now,
        wait: async (ms) => {
          waits.push(ms);
        },
      });
      const error = await client
        .get('meps', {}, record, client.operation(signal()))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data).toEqual({
        reason: 'upstream_rate_limited',
        retryable: true,
        retry_after_ms,
        retryAfter,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      // Between attempts the client still sleeps the capped wait, never the reported one.
      expect(waits.filter((ms) => ms === retry_after_ms)).toHaveLength(2);
    },
  );

  it.each([
    ['no Retry-After header', {}],
    ['an unparseable Retry-After header', { 'retry-after': 'soon' }],
  ])('reports no retry interval for a persistent 429 with %s', async (_case, headers) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 429, headers }));
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    const error = await client
      .get('meps', {}, record, client.operation(signal()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).toEqual({
      reason: 'upstream_rate_limited',
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('spaces concurrent requests FIFO by 700ms using fake timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const client = new EuParliamentClient({
      fetch: fetcher,
      wait: async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    });
    const operations = [1, 2, 3].map((offset) =>
      client.get('meps', { offset }, record, client.operation(signal())),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(700);
    await Promise.all(operations);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('offset')),
    ).toEqual(['1', '2', '3']);
  });

  it('shares one deadline across successive requests', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const client = new EuParliamentClient({ fetch: fetcher, now: () => now, wait: instantWait });
    const operation = client.operation(signal());
    await client.get('meps', {}, record, operation);
    now = 40_000;
    await expect(client.get('meps', {}, record, operation)).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  describe('operation deadline on the fake clock', () => {
    /** Aborts like AbortSignal.timeout, on the faked setTimeout. */
    const fakeTimeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          ),
        ms,
      );
      return controller.signal;
    };
    const fakeWait = (ms: number, waitSignal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        waitSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(waitSignal.reason);
          },
          { once: true },
        );
      });
    /**
     * Upstream that answers `ms` after each request starts unless the request aborts first; an
     * abort after the answer is ignored, as fetch ignores it.
     */
    const answersAfter = (ms: number) => {
      const starts: number[] = [];
      const aborts: number[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            starts.push(Date.now());
            const onAbort = () => {
              clearTimeout(timer);
              aborts.push(Date.now());
              reject(init?.signal?.reason);
            };
            const timer = setTimeout(() => {
              init?.signal?.removeEventListener('abort', onAbort);
              resolve(envelopeResponse([{ identifier: 'complete' }]));
            }, ms);
            init?.signal?.addEventListener('abort', onAbort, { once: true });
          }),
      );
      const client = new EuParliamentClient({
        fetch: fetcher,
        now: () => Date.now(),
        timeout: fakeTimeout,
        wait: fakeWait,
      });
      return { client, starts, aborts };
    };
    const bulkQuery = { offset: 0, limit: 10_000, 'process-type': 'RSP' };

    it.each([20_000, 39_000])(
      'allows a normal read taking %i ms to finish in one attempt',
      async (durationMs) => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { client, starts, aborts } = answersAfter(durationMs);
        const outcome = client
          .get('meps', {}, record, client.operation(signal()))
          .catch((caught: unknown) => caught);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(await outcome).toEqual({ status: 'ok', data: [{ identifier: 'complete' }] });
        expect(starts).toEqual([0]);
        expect(aborts).toEqual([]);
      },
    );

    it('lets the bulk read run past 15 seconds and finish in one attempt inside the deadline', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { client, starts, aborts } = answersAfter(20_000);
      const outcome = client
        .get('procedures', bulkQuery, record, client.operation(signal()))
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await outcome).toMatchObject({ status: 'ok', data: [{ identifier: 'complete' }] });
      expect(starts).toEqual([0]);
      expect(aborts).toEqual([]);
    });

    it('allows the response body to complete after 15 seconds within the same deadline', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(stream) {
                const onAbort = () => {
                  clearTimeout(timer);
                  stream.error(init?.signal?.reason);
                };
                const timer = setTimeout(() => {
                  init?.signal?.removeEventListener('abort', onAbort);
                  stream.enqueue(
                    new TextEncoder().encode('{"data":[{"identifier":"body-complete"}]}'),
                  );
                  stream.close();
                }, 20_000);
                init?.signal?.addEventListener('abort', onAbort, { once: true });
              },
            }),
          ),
      );
      const client = new EuParliamentClient({
        fetch: fetcher,
        timeout: fakeTimeout,
        wait: fakeWait,
      });
      const pending = client
        .get('meps', {}, record, client.operation(signal()))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await pending).toEqual({ status: 'ok', data: [{ identifier: 'body-complete' }] });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('still settles a bulk read that outlasts the operation at the 40-second deadline', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { client, starts, aborts } = answersAfter(45_000);
      const outcome = client
        .get('procedures', bulkQuery, record, client.operation(signal()))
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/deadline/) });
      expect(starts).toEqual([0]);
      expect(aborts).toEqual([40_000]);
    });

    it('propagates caller cancellation during a bulk read without another attempt', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const controller = new AbortController();
      const { client, starts, aborts } = answersAfter(30_000);
      const outcome = client
        .get('procedures', bulkQuery, record, client.operation(controller.signal))
        .catch((caught: unknown) => caught);
      setTimeout(() => controller.abort(new DOMException('Caller stopped', 'AbortError')), 18_000);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(starts).toEqual([0]);
      expect(aborts).toEqual([18_000]);
    });
  });

  it('propagates caller cancellation without retry', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      controller.abort(new DOMException('Caller stopped', 'AbortError'));
      init?.signal?.throwIfAborted();
      return envelopeResponse([]);
    });
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    await expect(
      client.get('meps', {}, record, client.operation(controller.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued request before it reaches the network', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => envelopeResponse([]));
    const client = new EuParliamentClient({
      fetch: fetcher,
      wait: async (ms, waitSignal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          waitSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(waitSignal.reason);
            },
            { once: true },
          );
        });
      },
    });
    await client.get('meps', {}, record, client.operation(signal()));
    const pending = client.get('meps', {}, record, client.operation(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(new DOMException('Caller stopped', 'AbortError'));
    await rejected;
    await vi.advanceTimersByTimeAsync(700);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels during a response body read without issuing another request', async () => {
    const controller = new AbortController();
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(stream) {
              init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
                once: true,
              });
              bodyStarted?.();
            },
          }),
        ),
    );
    const client = new EuParliamentClient({ fetch: fetcher, wait: instantWait });
    const pending = client.get('meps', {}, record, client.operation(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort(new DOMException('Caller stopped', 'AbortError'));
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks the operation deadline after fully reading a successful body', async () => {
    let now = 0;
    const response = envelopeResponse([]);
    vi.spyOn(response, 'text').mockImplementation(async () => {
      now = 40_000;
      return '{"data":[]}';
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = new EuParliamentClient({ fetch: fetcher, now: () => now, wait: instantWait });
    await expect(client.get('meps', {}, record, client.operation(signal()))).rejects.toThrow(
      /deadline/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
