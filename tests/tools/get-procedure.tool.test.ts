/** @fileoverview Procedure section contracts, nested evidence, and stateless continuations. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getProcedureTool } from '../../src/mcp-server/tools/definitions/get-procedure.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { envelopeResponse } from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
const snapshotHint =
  'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.';
const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
const procedure = {
  id: 'eli/dl/proc/2025-9001',
  process_id: '2025-9001',
  label: '2025/9001(COD)',
  process_type: 'def/ep-procedure-types/COD',
  current_stage: 'def/stages/ADOPTED',
  process_title: {
    en: 'Example `code` **literal**\n[title](https://example.org) | \\ end',
    fr: 'Titre exemple',
  },
  consists_of: [
    {
      id: 'eli/dl/event/EXAMPLE-1',
      activity_id: 'EXAMPLE-1',
      activity_date: '2025-01-15',
      had_activity_type: 'def/ep-activities/PLENARY_VOTE',
      occured_at_stage: 'def/stages/RDG1',
      decided_on_a_realization_of: ['eli/dl/doc/A-10-2025-900001'],
      was_scheduled_in: ['eli/dl/event/MTG-PL-2025-01-15'],
    },
    {
      id: 'eli/dl/event/EXAMPLE-2',
      based_on_a_realization_of: ['eli/dl/doc/A-10-2025-900001'],
      recorded_in_a_realization_of: ['eli/dl/doc/PV-10-2025-01-15'],
    },
  ],
  had_participation: [
    {
      id: 'eli/dl/participation/EXAMPLE-1',
      had_participant_person: ['person/900000001'],
      had_participant_organization: ['org/EXAMPLE'],
      participation_role: 'def/ep-roles/AUTHOR',
      activity_date: '2024-01-15',
      occured_at_stage: 'def/stages/RDG1',
      politicalGroup: 'org/HISTORICAL',
      participation_in_name_of: 'org/REPRESENTED',
      parliamentary_term: 'org/ep-9',
    },
    { id: 'eli/dl/participation/EXAMPLE-2', had_participant_person: ['person/900000002'] },
  ],
};
const snapshotOf = (data: Record<string, unknown>) =>
  z.object({ snapshot: z.string() }).parse(data.page).snapshot;
afterEach(() => vi.useRealTimers());

describe('euparl_get_procedure contract', () => {
  it.each([
    '2025-9001',
    '2025/9001(COD)',
    'eli/dl/proc/2025-9001',
    'https://data.europarl.europa.eu/eli/dl/proc/2025-9001',
  ])('resolves %s to the exact canonical route and rich overview', async (procedure_id) => {
    const fetcher = installToolHttp(() => envelopeResponse([procedure]));
    const data = expectSuccessTwin(await runToolContract(getProcedureTool, { procedure_id }));
    expect(data).toMatchObject({
      found: true,
      procedure_id: '2025-9001',
      reference: '2025/9001(COD)',
      title: {
        value: 'Example `code` **literal**\n[title](https://example.org) | \\ end',
        language: 'en',
      },
      process_type: 'def/ep-procedure-types/COD',
      stage: 'def/stages/ADOPTED',
      source_url: 'https://data.europarl.europa.eu/eli/dl/proc/2025-9001',
      section: 'overview',
      available_sections: [
        { name: 'events', count: 2 },
        { name: 'participants', count: 2 },
        { name: 'documents', count: 2 },
      ],
      appliedFilters: { procedure_id: '2025-9001', section: 'overview', language: 'en' },
    });
    expect(data).not.toHaveProperty('events');
    expect(data).not.toHaveProperty('participants');
    expect(data).not.toHaveProperty('documents');
    expect(data).not.toHaveProperty('page');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
      '/api/v2/procedures/2025-9001',
    );
  });

  it('renders every historical participant field without joining current affiliations', async () => {
    installToolHttp(() => envelopeResponse([procedure]));
    const data = expectSuccessTwin(
      await runToolContract(getProcedureTool, {
        procedure_id: '2025-9001',
        section: 'participants',
      }),
    );
    expect(data.participants).toEqual([
      {
        id: 'eli/dl/participation/EXAMPLE-1',
        person_ids: ['900000001'],
        organization_ids: ['org/EXAMPLE'],
        role: 'def/ep-roles/AUTHOR',
        date: '2024-01-15',
        stage: 'def/stages/RDG1',
        political_group_id: 'org/HISTORICAL',
        represented_organization_id: 'org/REPRESENTED',
        term_id: 'org/ep-9',
      },
      { id: 'eli/dl/participation/EXAMPLE-2', person_ids: ['900000002'], organization_ids: [] },
    ]);
    expect(data.totalCount).toBe(2);
  });

  it('renders deeper event relations and deduplicated documents with active public links', async () => {
    installToolHttp(() => envelopeResponse([procedure]));
    const events = expectSuccessTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025-9001', section: 'events' }),
    );
    expect(events.events).toEqual([
      {
        id: 'EXAMPLE-1',
        date: '2025-01-15',
        activity_type: 'def/ep-activities/PLENARY_VOTE',
        stage: 'def/stages/RDG1',
        document_ids: ['A-10-2025-900001'],
        sitting_ids: ['MTG-PL-2025-01-15'],
      },
      { id: 'EXAMPLE-2', document_ids: ['A-10-2025-900001', 'PV-10-2025-01-15'], sitting_ids: [] },
    ]);
    const documents = expectSuccessTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025-9001', section: 'documents' }),
    );
    expect(documents.documents).toEqual([
      {
        document_id: 'A-10-2025-900001',
        source_url: 'https://data.europarl.europa.eu/eli/dl/doc/A-10-2025-900001',
      },
      {
        document_id: 'PV-10-2025-01-15',
        source_url: 'https://data.europarl.europa.eu/eli/dl/doc/PV-10-2025-01-15',
      },
    ]);
  });

  it.each(['events', 'participants', 'documents'] as const)(
    'continues %s with complete snapshots and handles offsets past the end',
    async (section) => {
      installToolHttp(() => envelopeResponse([procedure]));
      const first = expectSuccessTwin(
        await runToolContract(getProcedureTool, { procedure_id: '2025-9001', section, limit: 1 }),
      );
      expect(first).toMatchObject({
        page: { offset: 0, limit: 1, returned: 1, has_more: true, next_offset: 1 },
        totalCount: 2,
        truncated: true,
        shown: 1,
        cap: 1,
      });
      expect(first.notice).toBe('Continue with offset 1 and the returned snapshot.');
      const snapshot = snapshotOf(first);
      const second = expectSuccessTwin(
        await runToolContract(getProcedureTool, {
          procedure_id: '2025-9001',
          section,
          offset: 1,
          limit: 1,
          snapshot,
        }),
      );
      expect(second).toMatchObject({ page: { offset: 1, returned: 1, has_more: false, snapshot } });
      const expected =
        section === 'events'
          ? { id: 'EXAMPLE-2' }
          : section === 'participants'
            ? { id: 'eli/dl/participation/EXAMPLE-2', person_ids: ['900000002'] }
            : { document_id: 'PV-10-2025-01-15' };
      expect(second[section]).toEqual([expect.objectContaining(expected)]);
      const pastEnd = expectSuccessTwin(
        await runToolContract(getProcedureTool, {
          procedure_id: '2025-9001',
          section,
          offset: 1000,
          snapshot,
        }),
      );
      expect(pastEnd[section]).toEqual([]);
      expect(pastEnd.page).toMatchObject({ offset: 1000, returned: 0, has_more: false });
    },
  );

  it('caps whole events and retains cap notice alongside snapshot continuation', async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      id: `eli/dl/event/EXAMPLE-${index}`,
    }));
    installToolHttp(() => envelopeResponse([{ id: procedure.id, consists_of: events }]));
    const data = expectSuccessTwin(
      await runToolContract(getProcedureTool, {
        procedure_id: '2025-9001',
        section: 'events',
        limit: 1000,
      }),
    );
    expect(data.events).toHaveLength(100);
    expect(data).toMatchObject({
      page: { limit: 100, returned: 100, next_offset: 100 },
      totalCount: 101,
      cap: 100,
      shown: 100,
    });
    expect(data.notice).toBe(
      'Requested limit normalized to the effective maximum of 100. Continue with offset 100 and the returned snapshot.',
    );
  });

  it.each(['events', 'participants', 'documents'] as const)(
    'renders a genuinely sparse empty %s collection',
    async (section) => {
      installToolHttp(() => envelopeResponse([{ id: procedure.id }]));
      const data = expectSuccessTwin(
        await runToolContract(getProcedureTool, {
          procedure_id: '2025-9001',
          section,
          language: '',
        }),
      );
      expect(data[section]).toEqual([]);
      expect(data).toMatchObject({
        found: true,
        totalCount: 0,
        page: { returned: 0, has_more: false },
        appliedFilters: { language: 'en' },
      });
      expect(data).not.toHaveProperty('title');
      expect(data).not.toHaveProperty('reference');
    },
  );

  it.each([204, 404])(
    'renders missing HTTP %i as found false with exact text and discovery guidance',
    async (status) => {
      installToolHttp(() => new Response(null, { status }));
      const result = await runToolContract(getProcedureTool, { procedure_id: '2025-9001' });
      const data = expectSuccessTwin(result);
      expect(data).toEqual({
        found: false,
        procedure_id: '2025-9001',
        source_url: 'https://data.europarl.europa.eu/eli/dl/proc/2025-9001',
        section: 'overview',
        appliedFilters: { procedure_id: '2025-9001', section: 'overview', language: 'en' },
        notice:
          'No procedure detail was published. Call euparl_list_procedures to discover references.',
      });
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'result.found: false\n\nresult.procedure_id: ` "2025-9001" `\n\nresult.source_url: [` "https://data.europarl.europa.eu/eli/dl/proc/2025-9001" `](<https://data.europarl.europa.eu/eli/dl/proc/2025-9001>)\n\nresult.section: ` "overview" `',
      });
    },
  );

  it('preserves fallback notices on both surfaces', async () => {
    installToolHttp(() => envelopeResponse([procedure]));
    const data = expectSuccessTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025-9001', language: 'pl' }),
    );
    expect(data.title).toEqual({ value: procedure.process_title.en, language: 'en' });
    expect(data.notice).toBe('Requested language pl unavailable; returned published en text.');
  });

  it('rejects a citation type conflict with declared recovery', async () => {
    installToolHttp(() => envelopeResponse([procedure]));
    expectErrorTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025/9001(INI)' }),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
  });

  it.each([
    { section: 'overview' as const, offset: 1 },
    { section: 'events' as const, offset: 1 },
  ])('rejects incompatible continuation %j before HTTP', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([procedure]));
    expectErrorTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025-9001', ...input }),
      'invalid_mode_fields',
      modeHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsupported language with declared recovery', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([procedure]));
    expectErrorTwin(
      await runToolContract(getProcedureTool, { procedure_id: '2025-9001', language: 'xx' }),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('detects changed fields beyond the first page and reports restart recovery', async () => {
    installToolHttp((_url, _init, index) =>
      envelopeResponse([
        index === 0
          ? procedure
          : {
              ...procedure,
              consists_of: [
                procedure.consists_of[0],
                { ...procedure.consists_of[1], activity_date: '2025-02-01' },
              ],
            },
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getProcedureTool, {
        procedure_id: '2025-9001',
        section: 'events',
        limit: 1,
      }),
    );
    const result = await runToolContract(getProcedureTool, {
      procedure_id: '2025-9001',
      section: 'events',
      limit: 1,
      offset: 1,
      snapshot: snapshotOf(first),
    });
    expectErrorTwin(result, 'snapshot_changed', snapshotHint, JsonRpcErrorCode.Conflict);
  });

  it('detects changed retrieval scope even when selected rows are identical', async () => {
    installToolHttp(() => envelopeResponse([procedure]));
    const first = expectSuccessTwin(
      await runToolContract(getProcedureTool, {
        procedure_id: '2025-9001',
        section: 'events',
        limit: 1,
      }),
    );
    expectErrorTwin(
      await runToolContract(getProcedureTool, {
        procedure_id: '2025-9001',
        section: 'events',
        limit: 1,
        offset: 1,
        language: 'fr',
        snapshot: snapshotOf(first),
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('rejects blank and malformed identifiers at schema boundary', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([procedure]));
    for (const procedure_id of ['', ' ', 'https://evil.example/2025-9001', '2025-9001?text=x']) {
      const result = await runToolContract(getProcedureTool, { procedure_id });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      expect(contractText(result)).toContain('euparl_get_procedure');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders upstream rejection with exact recovery', async () => {
    installToolHttp(() => new Response('private trace', { status: 400 }));
    const result = await runToolContract(getProcedureTool, { procedure_id: '2025-9001' });
    expectErrorTwin(result, 'upstream_rejected', rejectedHint, JsonRpcErrorCode.InvalidParams);
    expect(contractText(result)).not.toContain('private trace');
  });

  it('renders rate-limit recovery after fake-timed bounded retries', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp(
      () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }),
      async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    );
    const pending = runToolContract(getProcedureTool, { procedure_id: '2025-9001' });
    await vi.runAllTimersAsync();
    expectErrorTwin(await pending, 'upstream_rate_limited', rateHint, JsonRpcErrorCode.RateLimited);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
