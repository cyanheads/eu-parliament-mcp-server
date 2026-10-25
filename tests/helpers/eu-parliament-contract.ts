/** @fileoverview HTTP injection and independent wire-surface assertions for Parliament tools. */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import type { ClientOptions } from '../../src/services/eu-parliament/eu-parliament-client.js';
import { initEuParliamentService } from '../../src/services/eu-parliament/eu-parliament-service.js';

type WireResult = Awaited<ReturnType<typeof runToolContract>>;
type Responder = (
  url: URL,
  init: RequestInit | undefined,
  index: number,
) => Response | Promise<Response>;

/** Initialize the real singleton service with a request-recording network fake. */
export function installToolHttp(respond: Responder, wait: ClientOptions['wait'] = async () => {}) {
  let index = 0;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => respond(new URL(String(input)), init, index++));
  initEuParliamentService({ fetch: fetcher, wait });
  return fetcher;
}

/** Every block contributes to text assertions; unexpected media is an explicit failure. */
export function contractText(result: WireResult): string {
  return z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .parse(result.content)
    .map((block) => block.text)
    .join('\n');
}

/** Compare each structured leaf with the independently decoded rendered value. */
export function expectSuccessTwin(result: WireResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  const structured = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  const text = contractText(result);
  const enrichment = new Set([
    'appliedFilters',
    'notice',
    'totalCount',
    'truncated',
    'shown',
    'cap',
    'available',
  ]);
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (!value.length) expect(text).toContain(`${path}: []`);
      value.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) expect(text).toContain(`${path}: {}`);
      entries.forEach(([key, item]) => {
        visit(item, `${path}.${key}`);
      });
    } else if (typeof value === 'string') {
      const line = text.split('\n').find((item) => item.startsWith(`${path}: `));
      expect(line, path).toBeDefined();
      const code = /(`+) (".*") \1/.exec(line!);
      expect(code, path).not.toBeNull();
      expect(JSON.parse(code![2]!), path).toBe(value);
      if (/^https?:\/\/[^\s<>]*$/.test(value))
        expect(line).toContain(`](<${value.replaceAll('\\', '%5C')}>)`);
    } else {
      expect(text, path).toContain(`${path}: ${String(value)}`);
    }
  };
  for (const [key, value] of Object.entries(structured)) {
    if (key === 'totalCount') expect(text).toContain(`**${String(value)} total**`);
    else if (['truncated', 'shown', 'cap', 'available'].includes(key))
      expect(text).toContain(`**${key}:** ${String(value)}`);
    else visit(value, enrichment.has(key) ? key : `result.${key}`);
  }
  return structured;
}

/** Assert a declared failure's stable reason, literal recovery and complete text twin. */
export function expectErrorTwin(
  result: WireResult,
  reason: string,
  hint: string,
  code?: number,
): void {
  expect(result.isError).toBe(true);
  const parsed = z
    .object({
      error: z.object({
        code: z.number(),
        message: z.string(),
        data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
      }),
    })
    .parse(result.structuredContent);
  expect(parsed.error.data).toMatchObject({ reason, recovery: { hint } });
  if (code !== undefined) expect(parsed.error.code).toBe(code);
  const text = contractText(result);
  expect(text).toContain(parsed.error.message);
  expect(text).toContain(`Recovery: ${hint}`);
  expect(text).toContain(`reason ${reason}`);
}
