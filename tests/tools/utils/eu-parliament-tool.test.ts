/** @fileoverview Shared `limit` schema (advertised caps, whole-number checks, clamp switch) and field-path text. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { initServerConfig } from '../../../src/config/server-config.js';
import { getMepTool } from '../../../src/mcp-server/tools/definitions/get-mep.tool.js';
import { getPlenaryVotesTool } from '../../../src/mcp-server/tools/definitions/get-plenary-votes.tool.js';
import { getProcedureTool } from '../../../src/mcp-server/tools/definitions/get-procedure.tool.js';
import { listProceduresTool } from '../../../src/mcp-server/tools/definitions/list-procedures.tool.js';
import { listQuestionsTool } from '../../../src/mcp-server/tools/definitions/list-questions.tool.js';
import { listReferenceTool } from '../../../src/mcp-server/tools/definitions/list-reference.tool.js';
import { searchDocumentsTool } from '../../../src/mcp-server/tools/definitions/search-documents.tool.js';
import { searchMepsTool } from '../../../src/mcp-server/tools/definitions/search-meps.tool.js';
import { searchSpeechesTool } from '../../../src/mcp-server/tools/definitions/search-speeches.tool.js';
import { formatResult } from '../../../src/mcp-server/tools/utils/eu-parliament-tool.js';
import {
  contractText,
  expectSuccessTwin,
  installToolHttp,
} from '../../helpers/eu-parliament-contract.js';
import { envelopeResponse } from '../../helpers/eu-parliament-fixtures.js';

/** Each tool beside the largest page cap among the collections it serves. */
const tools = [
  [listProceduresTool, 300],
  [listQuestionsTool, 300],
  [searchDocumentsTool, 225],
  [searchSpeechesTool, 80],
  [searchMepsTool, 300],
  [getMepTool, 225],
  [getProcedureTool, 125],
  [getPlenaryVotesTool, 1000],
  [listReferenceTool, 350],
] as const;

/** Test rows named by tool, so a failing row says which tool broke. */
const toolRows = tools.map(([definition, maximum]) => ({
  name: definition.name,
  definition,
  maximum,
}));

/** The `limit` property exactly as `tools/list` serializes it from the SDK's conversion path. */
function advertisedLimit(definition: (typeof tools)[number][0]) {
  const json = definition.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  return z
    .object({ properties: z.object({ limit: z.record(z.string(), z.unknown()) }) })
    .parse(JSON.parse(JSON.stringify(json))).properties.limit;
}

function strictMode(): void {
  vi.stubEnv('EUPARL_CLAMP_LIMITS', 'false');
  initServerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
  initServerConfig();
});

describe('shared limit input', () => {
  it.each(toolRows)(
    '$name advertises a whole-number limit with no maximum by default',
    ({ definition }) => {
      expect(advertisedLimit(definition)).toEqual({
        type: 'number',
        minimum: 1,
        multipleOf: 1,
        default: 20,
        description: expect.stringContaining('a larger limit returns that many with a notice.'),
      });
    },
  );
  it.each(toolRows)(
    '$name advertises its largest cap $maximum as maximum only with EUPARL_CLAMP_LIMITS=false',
    ({ definition, maximum }) => {
      strictMode();
      expect(advertisedLimit(definition)).toMatchObject({ type: 'number', multipleOf: 1, maximum });
      vi.unstubAllEnvs();
      initServerConfig();
      expect(advertisedLimit(definition)).not.toHaveProperty('maximum');
    },
  );
  it('states each mode-specific cap in the advertised description', () => {
    expect(advertisedLimit(listProceduresTool).description).toBe(
      'Whole items requested; default 20. Pages hold at most 300 procedures; a larger limit returns that many with a notice.',
    );
    expect(advertisedLimit(getPlenaryVotesTool).description).toBe(
      'Whole items requested; default 20. Pages hold at most 100 sittings, 100 decisions, or 1000 voters; a larger limit returns that many with a notice.',
    );
    expect(advertisedLimit(listReferenceTool).description).toBe(
      'Whole items requested; default 20. Pages hold at most 350 reference entries or 20 organization lookups; a larger limit returns that many with a notice.',
    );
    expect(advertisedLimit(searchSpeechesTool).description).toBe(
      'Whole items requested; default 20. Pages hold at most 80 speeches; a larger limit returns that many with a notice.',
    );
    strictMode();
    expect(advertisedLimit(listProceduresTool).description).toBe(
      'Whole items requested; default 20, at most 300.',
    );
    expect(advertisedLimit(listReferenceTool).description).toBe(
      'Whole items requested; default 20, at most 350. Pages hold at most 20 organization lookups; a larger limit returns that many with a notice.',
    );
    expect(advertisedLimit(getPlenaryVotesTool).description).toBe(
      'Whole items requested; default 20, at most 1000. Pages hold at most 100 sittings or 100 decisions; a larger limit returns that many with a notice.',
    );
  });
  it.each([1.5, 20.000000000000004, 0])(
    'rejects limit %d with one argument issue before HTTP',
    async (limit) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract(listProceduresTool, { limit });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      const issues = z
        .object({ error: z.object({ data: z.object({ issues: z.array(z.unknown()) }) }) })
        .parse(result.structuredContent).error.data.issues;
      expect(issues).toHaveLength(1);
      expect(contractText(result)).toContain(
        limit === 0 ? 'Too small: expected number to be >=1' : 'limit must be a whole number.',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('accepts a limit far above the cap by default and rejects it with EUPARL_CLAMP_LIMITS=false', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expect(
      expectSuccessTwin(await runToolContract(listProceduresTool, { limit: 301 })),
    ).toMatchObject({ page: { limit: 300 } });
    strictMode();
    expect(
      expectSuccessTwin(await runToolContract(listProceduresTool, { limit: 300 })),
    ).toMatchObject({ page: { limit: 300 } });
    const rejected = await runToolContract(listProceduresTool, { limit: 301 });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(contractText(rejected)).toContain('Too big: expected number to be <=300');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('clamps a smaller mode cap with its notice under EUPARL_CLAMP_LIMITS=false', async () => {
    strictMode();
    const fetcher = installToolHttp(() =>
      Response.json({ data: [{ id: 'eli/dl/event/MTG-PL-2025-01-15' }], meta: { total: 1 } }),
    );
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, limit: 1000 }),
      ),
    ).toMatchObject({
      page: { limit: 100 },
      notice: 'Requested limit normalized to the effective maximum of 100 sittings.',
    });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
    const rejected = await runToolContract(getPlenaryVotesTool, {
      mode: 'sittings',
      year: 2025,
      limit: 1001,
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('field-path rendering', () => {
  it('renders each leaf as its own paragraph, quoting strings and linking URLs', () => {
    expect(
      formatResult({
        mode: 'decisions',
        decisions: [
          {
            decision_id: 'D-1',
            document_ids: ['A-1'],
            recording_document_ids: [],
            favor: 2,
            source_url: 'https://data.europarl.europa.eu/eli/dl/event/D-1',
          },
        ],
        page: { offset: 0, has_more: false },
      }),
    ).toEqual([
      {
        type: 'text',
        text: [
          'result.mode: ` "decisions" `',
          'result.decisions[0].decision_id: ` "D-1" `',
          'result.decisions[0].document_ids[0]: ` "A-1" `',
          'result.decisions[0].recording_document_ids: []',
          'result.decisions[0].favor: 2',
          'result.decisions[0].source_url: [` "https://data.europarl.europa.eu/eli/dl/event/D-1" `](<https://data.europarl.europa.eu/eli/dl/event/D-1>)',
          'result.page.offset: 0',
          'result.page.has_more: false',
        ].join('\n\n'),
      },
    ]);
  });
});
