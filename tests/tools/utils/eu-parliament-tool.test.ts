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
  [listProceduresTool, undefined],
  [listQuestionsTool, 1000],
  [searchDocumentsTool, 10000],
  [searchSpeechesTool, 10000],
  [searchMepsTool, undefined],
  [getMepTool, undefined],
  [getProcedureTool, undefined],
  [getPlenaryVotesTool, undefined],
  [listReferenceTool, undefined],
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
  it.each([searchDocumentsTool, searchSpeechesTool])(
    '$name keeps keyword relevance and discloses its paging uncertainty on both surfaces',
    async (definition) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const result = await runToolContract(definition, { text: 'climate', offset: 7, limit: 37 });
      const data = expectSuccessTwin(result);
      expect(data.notice).toContain(
        'Keyword searches retain upstream relevance order; pages can repeat or omit records as ordering changes.',
      );
      const query = new URL(String(fetcher.mock.calls[0]?.[0])).searchParams;
      expect(query.get('offset')).toBe('7');
      expect(query.get('limit')).toBe('37');
      expect(query.has('sort-by')).toBe(false);
    },
  );
  it.each(toolRows)(
    '$name advertises a whole-number limit with no maximum by default',
    ({ definition }) => {
      expect(advertisedLimit(definition)).toEqual({
        type: 'number',
        minimum: 1,
        multipleOf: 1,
        default: 20,
        description: expect.stringContaining('Whole items requested; default 20.'),
      });
    },
  );
  it.each(toolRows)(
    '$name advertises its largest cap $maximum as maximum only with EUPARL_CLAMP_LIMITS=false',
    ({ definition, maximum }) => {
      strictMode();
      if (maximum === undefined) expect(advertisedLimit(definition)).not.toHaveProperty('maximum');
      else
        expect(advertisedLimit(definition)).toMatchObject({
          type: 'number',
          multipleOf: 1,
          maximum,
        });
      vi.unstubAllEnvs();
      initServerConfig();
      expect(advertisedLimit(definition)).not.toHaveProperty('maximum');
    },
  );
  it('distinguishes local modes from verified upstream bounds without Infinity in schemas', () => {
    expect(advertisedLimit(listProceduresTool).description).toContain('1000 procedures');
    expect(advertisedLimit(listProceduresTool).description).toContain('without an output-size cap');
    expect(advertisedLimit(listReferenceTool).description).toContain('20 organization lookups');
    expect(advertisedLimit(getPlenaryVotesTool).description).toContain('1000 sittings');
    expect(advertisedLimit(searchSpeechesTool).description).toContain('1000 keyword speeches');
    for (const { definition } of toolRows)
      expect(JSON.stringify(advertisedLimit(definition))).not.toContain('Infinity');
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
  it.each([1001, 1e100])(
    'accepts limit %s by default and rejects it in a fully bounded tool with EUPARL_CLAMP_LIMITS=false',
    async (limit) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expect(expectSuccessTwin(await runToolContract(listQuestionsTool, { limit }))).toMatchObject({
        page: { limit: 1000 },
      });
      strictMode();
      expect(
        expectSuccessTwin(await runToolContract(listQuestionsTool, { limit: 1000 })),
      ).toMatchObject({ page: { limit: 1000 } });
      const rejected = await runToolContract(listQuestionsTool, { limit });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      expect(contractText(rejected)).toContain('Too big: expected number to be <=1000');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps mixed local modes open in strict mode while bounding organization work', async () => {
    strictMode();
    const fetcher = installToolHttp(() => new Response(null, { status: 404 }));
    const staticPage = expectSuccessTwin(
      await runToolContract(listReferenceTool, { topic: 'procedure_types', limit: 1e100 }),
    );
    expect(staticPage.page).toMatchObject({ limit: Number.MAX_SAFE_INTEGER });
    expect(staticPage.notice).toContain('9007199254740991');
    const organizations = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ['1'],
        limit: 1001,
      }),
    );
    expect(organizations.page).toMatchObject({ limit: 20 });
    expect(organizations.notice).toContain('effective maximum of 20 organization lookups');
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
