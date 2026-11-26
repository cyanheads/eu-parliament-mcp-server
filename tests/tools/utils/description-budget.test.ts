/**
 * @fileoverview Ceiling on the server-authored description text `tools/list` carries: each tool
 * description, every field describe in the advertised input and output schemas, and every
 * `errors[].when`, which the framework renders into the advertised error envelope.
 * @module tests/tools/utils/description-budget.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getMepTool } from '../../../src/mcp-server/tools/definitions/get-mep.tool.js';
import { getPlenaryVotesTool } from '../../../src/mcp-server/tools/definitions/get-plenary-votes.tool.js';
import { getProcedureTool } from '../../../src/mcp-server/tools/definitions/get-procedure.tool.js';
import { listProceduresTool } from '../../../src/mcp-server/tools/definitions/list-procedures.tool.js';
import { listQuestionsTool } from '../../../src/mcp-server/tools/definitions/list-questions.tool.js';
import { listReferenceTool } from '../../../src/mcp-server/tools/definitions/list-reference.tool.js';
import { searchDocumentsTool } from '../../../src/mcp-server/tools/definitions/search-documents.tool.js';
import { searchMepsTool } from '../../../src/mcp-server/tools/definitions/search-meps.tool.js';
import { searchSpeechesTool } from '../../../src/mcp-server/tools/definitions/search-speeches.tool.js';

/**
 * UTF-8 bytes of description text allowed across the nine tools, in default clamp mode. Set to
 * the 52,960 B the description pass left, rounded up to the next 500 B; the pass started from
 * 71,318 B. A change that needs more text raises this deliberately rather than letting the
 * catalog grow unnoticed.
 */
const descriptionCeilingBytes = 53_000;

const definitions = [
  listReferenceTool,
  listProceduresTool,
  getProcedureTool,
  searchDocumentsTool,
  searchSpeechesTool,
  searchMepsTool,
  getMepTool,
  getPlenaryVotesTool,
  listQuestionsTool,
] as const;

/** Every string `description` under a JSON Schema node. */
function descriptions(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptions);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : descriptions(value),
  );
}

/**
 * Description bytes of one definition, from the same conversions `tools/list` serializes. The
 * framework types `enrichment` and `errors` as optional; a definition without them adds nothing.
 */
function descriptionBytes(definition: (typeof definitions)[number]): number {
  const input = definition.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  const output = z.toJSONSchema(definition.output.extend(definition.enrichment ?? {}));
  return [
    definition.description,
    ...descriptions(input),
    ...descriptions(output),
    ...(definition.errors ?? []).map((entry) => entry.when),
  ].reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
}

describe('tools/list description text', () => {
  it(`stays within ${descriptionCeilingBytes} bytes across the nine tools`, () => {
    const perTool = Object.fromEntries(
      definitions.map((definition) => [definition.name, descriptionBytes(definition)]),
    );
    const total = Object.values(perTool).reduce((sum, bytes) => sum + bytes, 0);
    expect(total, `description bytes per tool: ${JSON.stringify(perTool)}`).toBeLessThanOrEqual(
      descriptionCeilingBytes,
    );
  });
});
