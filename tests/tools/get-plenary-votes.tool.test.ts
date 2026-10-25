/** @fileoverview Sitting, compact decision, rich decision and independent voter contracts. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getPlenaryVotesTool } from '../../src/mcp-server/tools/definitions/get-plenary-votes.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import {
  decisionRecord,
  envelopeResponse,
  rosterRecords,
} from '../helpers/eu-parliament-fixtures.js';

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
const snapshotHint =
  'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.';
const stalledHint =
  'Retry the same euparl tool call later; do not treat an incomplete lookup as a complete result.';
const missingHint =
  'Call euparl_get_plenary_votes with mode decisions and the same sitting_id, then use an exact returned decision_id.';
const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
const selected = { sitting_id: '2025-01-15', decision_id: 'MTG-PL-2025-01-15-DEC-900001' };
const snapshotOf = (data: Record<string, unknown>) =>
  z.object({ snapshot: z.string() }).parse(data.page).snapshot;
afterEach(() => vi.useRealTimers());

describe('euparl_get_plenary_votes contract', () => {
  it('discovers sittings and forwards only year and page parameters', async () => {
    const fetcher = installToolHttp(() =>
      Response.json({
        data: [
          {
            id: 'eli/dl/event/MTG-PL-2025-01-15',
            activity_id: 'MTG-PL-2025-01-15',
            activity_date: '2025-01-15',
            activity_label: { fr: 'Séance exemple' },
          },
        ],
        meta: { total: 2 },
      }),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        mode: 'sittings',
        year: 2025,
        limit: 1,
        language: 'fr',
      }),
    );
    expect(data).toMatchObject({
      mode: 'sittings',
      sittings: [
        {
          sitting_id: 'MTG-PL-2025-01-15',
          date: '2025-01-15',
          label: { value: 'Séance exemple', language: 'fr' },
          source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-01-15',
        },
      ],
      totalCount: 2,
      page: { offset: 0, limit: 1, returned: 1, next_offset: 1 },
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/meetings');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      year: '2025',
      offset: '0',
      limit: '1',
      format: 'application/ld+json',
    });
  });

  it.each([
    '2025-01-15',
    'MTG-PL-2025-01-15',
    'eli/dl/event/MTG-PL-2025-01-15',
    'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-01-15',
  ])('normalizes sitting %s and keeps compact decisions compact', async (sitting_id) => {
    const fetcher = installToolHttp(() => envelopeResponse([decisionRecord]));
    const data = expectSuccessTwin(await runToolContract(getPlenaryVotesTool, { sitting_id }));
    expect(data.decisions).toEqual([
      {
        decision_id: 'MTG-PL-2025-01-15-DEC-900001',
        date: '2025-01-15',
        order: '1.0',
        method: 'def/ep-decision-methods/VOTE_ELECTRONIC_ROLLCALL',
        outcome: 'def/ep-statuses/ADOPTED',
        favor: 2,
        against: 1,
        abstention: 0,
        voter_counts: [
          { position: 'favor', count: 2 },
          { position: 'against', count: 1 },
          { position: 'abstention', count: 0 },
          { position: 'intended_favor', count: 1 },
          { position: 'intended_against', count: 1 },
          { position: 'intended_abstention', count: 1 },
        ],
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-01-15-DEC-900001',
      },
    ]);
    expect(data).not.toHaveProperty('decision');
    expect(data).not.toHaveProperty('voters');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/meetings/MTG-PL-2025-01-15/decisions');
    expect(Object.fromEntries(url.searchParams)).toEqual({ format: 'application/ld+json' });
  });

  it('returns whole rich text, actual fallback language and explicit document relationships', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          ...decisionRecord,
          activity_label: { en: '**literal** `tick`\n[link](https://example.org) \\ end' },
          referenceText: { en: 'Full reference\nsecond line' },
          comment: { en: '``fenced`` comment' },
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'decision', language: 'pl' }),
    );
    expect(data.decision).toMatchObject({
      label: { value: '**literal** `tick`\n[link](https://example.org) \\ end', language: 'en' },
      reference_text: { value: 'Full reference\nsecond line', language: 'en' },
      comment: { value: '``fenced`` comment', language: 'en' },
      document_ids: ['A-10-2025-900001'],
      recording_document_ids: ['PV-10-2025-01-15-RCV-ITM-001'],
    });
    expect(data.notice).toBe('Requested language pl unavailable; returned published en text.');
    expect(data).not.toHaveProperty('page');
    expect(data).not.toHaveProperty('voters');
  });

  it.each([
    ['favor', [{ mep_id: '900000001' }, { mep_id: '900000002' }]],
    ['against', [{ mep_id: '900000003' }]],
    ['abstention', []],
    ['intended_favor', [{ mep_id: '900000004' }]],
    ['intended_against', [{ mep_id: '900000005' }]],
    ['intended_abstention', [{ mep_id: '900000006' }]],
  ])('pages independent %s position preserving its published IDs', async (position, voters) => {
    installToolHttp(() => envelopeResponse([decisionRecord]));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'voters', position }),
    );
    expect(data).toMatchObject({
      mode: 'voters',
      sitting_id: 'MTG-PL-2025-01-15',
      decision_id: 'MTG-PL-2025-01-15-DEC-900001',
      position,
      voters,
      available: true,
      page: { returned: Array.isArray(voters) ? voters.length : 0, has_more: false },
    });
    expect(data).not.toHaveProperty('decision');
    expect(data).not.toHaveProperty('voter_resolution');
  });

  it('keeps absent arrays unavailable and absent tallies absent rather than zero', async () => {
    installToolHttp(() =>
      envelopeResponse([
        { id: decisionRecord.id, had_voter_abstention: [], number_of_votes_abstention: 0 },
      ]),
    );
    const missing = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'voters',
        position: 'favor',
      }),
    );
    expect(missing).toMatchObject({
      voters: [],
      available: false,
      totalCount: 0,
      notice: 'This voter position array was not published in the response.',
    });
    const empty = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'voters',
        position: 'abstention',
      }),
    );
    expect(empty).toMatchObject({ voters: [], available: true, totalCount: 0 });
    const rich = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'decision' }),
    );
    expect(rich.decision).toEqual({
      decision_id: 'MTG-PL-2025-01-15-DEC-900001',
      abstention: 0,
      voter_counts: [{ position: 'abstention', count: 0 }],
      document_ids: [],
      recording_document_ids: [],
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-01-15-DEC-900001',
    });
  });

  it('resolves names from the complete explicit term roster and retains unresolved IDs', async () => {
    const fetcher = installToolHttp((url) =>
      url.pathname.endsWith('/decisions')
        ? envelopeResponse([
            { ...decisionRecord, had_voter_favor: ['person/900000002', 'person/999999999'] },
          ])
        : url.searchParams.has('offset')
          ? Response.json({ data: [rosterRecords[1]], meta: { total: 2 } })
          : Response.json({ data: [rosterRecords[0]], meta: { total: 2, next: 1 } }),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'voters',
        position: 'favor',
        resolve_names: true,
        roster_term: 9,
      }),
    );
    expect(data.voters).toEqual([
      { mep_id: '900000002', name: 'Élodie DEMO' },
      { mep_id: '999999999' },
    ]);
    expect(data.voter_resolution).toEqual({
      scope: 'parliamentary_term',
      term: 9,
      sitting_date: '2025-01-15',
      resolved: 1,
      unresolved: 1,
    });
    expect(data.notice).toBe(
      'Names are published identities in the selected term roster, not proof of spelling or affiliation on the vote date. Some voter identities are unresolved. Call euparl_get_mep with the returned mep_id.',
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    const rosterUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(rosterUrl.pathname).toBe('/api/v2/meps');
    expect(Object.fromEntries(rosterUrl.searchParams)).toEqual({
      'parliamentary-term': '9',
      format: 'application/ld+json',
    });
    expect(data.voters).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ political_group: expect.anything() })]),
    );
  });

  it.each(['decisions', 'voters'] as const)(
    'continues %s whole-item pages and past-end offsets',
    async (mode) => {
      installToolHttp(() =>
        envelopeResponse([decisionRecord, { id: 'eli/dl/event/EXAMPLE-SECOND' }]),
      );
      const input =
        mode === 'decisions'
          ? { sitting_id: selected.sitting_id, mode }
          : { ...selected, mode, position: 'favor' };
      const first = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...input, limit: 1 }),
      );
      expect(first).toMatchObject({
        totalCount: 2,
        page: { next_offset: 1, returned: 1 },
        truncated: true,
        shown: 1,
        cap: 1,
      });
      const snapshot = snapshotOf(first);
      const second = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...input, limit: 1, offset: 1, snapshot }),
      );
      expect(second[mode]).toEqual(
        mode === 'decisions'
          ? [
              {
                decision_id: 'EXAMPLE-SECOND',
                voter_counts: [],
                source_url: 'https://data.europarl.europa.eu/eli/dl/event/EXAMPLE-SECOND',
              },
            ]
          : [{ mep_id: '900000002' }],
      );
      expect(second.page).toMatchObject({ returned: 1, has_more: false, snapshot });
      const past = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...input, offset: 1000, snapshot }),
      );
      expect(past[mode]).toEqual([]);
      expect(past.page).toMatchObject({ returned: 0, has_more: false });
    },
  );

  it('detects voter changes beyond the selected page and changes in scope', async () => {
    let changed = false;
    installToolHttp(() =>
      envelopeResponse([
        {
          ...decisionRecord,
          had_voter_favor: changed
            ? ['person/900000001', 'person/900000003']
            : ['person/900000001', 'person/900000002'],
        },
      ]),
    );
    const input = { ...selected, mode: 'voters', position: 'favor', limit: 1 } as const;
    const first = expectSuccessTwin(await runToolContract(getPlenaryVotesTool, input));
    const snapshot = snapshotOf(first);
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { ...input, language: 'fr', offset: 1, snapshot }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
    changed = true;
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { ...input, offset: 1, snapshot }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('detects a changed compact decision beyond the first selected decision', async () => {
    let changed = false;
    installToolHttp(() =>
      envelopeResponse([
        decisionRecord,
        { id: 'eli/dl/event/EXAMPLE-SECOND', number_of_votes_favor: changed ? 1 : 0 },
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: selected.sitting_id, limit: 1 }),
    );
    changed = true;
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: selected.sitting_id,
        offset: 1,
        snapshot: snapshotOf(first),
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('detects resolved-name drift beyond the page and counts the entire voter position', async () => {
    let changed = false;
    installToolHttp((url) =>
      url.pathname.endsWith('/decisions')
        ? envelopeResponse([decisionRecord])
        : envelopeResponse([
            rosterRecords[0],
            { ...rosterRecords[1], label: changed ? 'Changed published name' : 'Élodie DEMO' },
          ]),
    );
    const input = {
      ...selected,
      mode: 'voters',
      position: 'favor',
      resolve_names: true,
      roster_term: 9,
      limit: 1,
    } as const;
    const first = expectSuccessTwin(await runToolContract(getPlenaryVotesTool, input));
    expect(first.voters).toEqual([{ mep_id: '900000001', name: 'Alex EXAMPLE' }]);
    expect(first.voter_resolution).toEqual({
      scope: 'parliamentary_term',
      term: 9,
      sitting_date: '2025-01-15',
      resolved: 2,
      unresolved: 0,
    });
    changed = true;
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...input,
        offset: 1,
        snapshot: snapshotOf(first),
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('does not infer outcomes or unavailable voters from method and tallies', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: decisionRecord.id,
          decision_method: 'def/ep-decision-methods/VOTE_BY_SHOW_OF_HANDS',
          number_of_votes_favor: 0,
          number_of_votes_against: 10,
          had_voter_favor: ['person/900000001'],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'decision' }),
    );
    expect(data.decision).toEqual({
      decision_id: 'MTG-PL-2025-01-15-DEC-900001',
      method: 'def/ep-decision-methods/VOTE_BY_SHOW_OF_HANDS',
      favor: 0,
      against: 10,
      voter_counts: [{ position: 'favor', count: 1 }],
      document_ids: [],
      recording_document_ids: [],
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-01-15-DEC-900001',
    });
    const voters = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'voters',
        position: 'favor',
      }),
    );
    expect(voters).toMatchObject({ voters: [{ mep_id: '900000001' }], available: true });
  });

  it('caps sitting discovery and preserves upstream past-end emptiness', async () => {
    const fetcher = installToolHttp((url) =>
      url.searchParams.get('offset') === '1000'
        ? envelopeResponse([])
        : Response.json({ data: [{ id: 'eli/dl/event/MTG-PL-2025-01-15' }], meta: { total: 1 } }),
    );
    const first = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, limit: 1000 }),
    );
    expect(first).toMatchObject({
      page: { limit: 100, returned: 1, has_more: false },
      notice: 'Requested limit normalized to the effective maximum of 100.',
    });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
    const past = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, offset: 1000 }),
    );
    expect(past).toMatchObject({
      sittings: [],
      page: { offset: 1000, returned: 0, has_more: false },
      notice: 'No sittings matched this year. Try another year.',
    });
  });

  it.each(['decisions', 'voters'] as const)(
    'caps %s without losing the final item',
    async (mode) => {
      installToolHttp(() =>
        envelopeResponse(
          mode === 'decisions'
            ? Array.from({ length: 101 }, (_, index) => ({ id: `eli/dl/event/EXAMPLE-${index}` }))
            : [
                {
                  ...decisionRecord,
                  had_voter_favor: Array.from(
                    { length: 101 },
                    (_, index) => `person/${900000000 + index}`,
                  ),
                },
              ],
        ),
      );
      const input =
        mode === 'decisions'
          ? { sitting_id: selected.sitting_id, mode }
          : { ...selected, mode, position: 'favor' };
      const first = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...input, limit: 1000 }),
      );
      expect(first[mode]).toHaveLength(100);
      expect(first).toMatchObject({
        totalCount: 101,
        cap: 100,
        page: { limit: 100, next_offset: 100 },
      });
      expect(first.notice).toBe(
        'Requested limit normalized to the effective maximum of 100. Continue with offset 100 and the returned snapshot.',
      );
      const last = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...input,
          offset: 100,
          snapshot: snapshotOf(first),
        }),
      );
      expect(last[mode]).toEqual(
        mode === 'decisions'
          ? [
              {
                decision_id: 'EXAMPLE-100',
                voter_counts: [],
                source_url: 'https://data.europarl.europa.eu/eli/dl/event/EXAMPLE-100',
              },
            ]
          : [{ mep_id: '900000100' }],
      );
    },
  );

  it.each([204, 404])(
    'returns empty decisions for HTTP %i rather than parsing an empty body',
    async (status) => {
      installToolHttp(() => new Response(null, { status }));
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          sitting_id: selected.sitting_id,
          decision_id: '',
          position: '',
          snapshot: '',
          language: '',
        }),
      );
      expect(data).toMatchObject({
        decisions: [],
        totalCount: 0,
        page: { returned: 0, has_more: false },
        notice:
          'No decision data was published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.',
      });
    },
  );

  it.each(['decision', 'voters'] as const)(
    'reports missing decision in %s with exact recovery',
    async (mode) => {
      installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...selected,
          mode,
          ...(mode === 'voters' && { position: 'favor' }),
        }),
        'decision_not_found',
        missingHint,
        JsonRpcErrorCode.NotFound,
      );
    },
  );

  it.each([
    {},
    { mode: 'sittings' },
    { mode: 'sittings', year: 2025, sitting_id: '2025-01-15' },
    { sitting_id: '2025-01-15', year: 2025 },
    { ...selected },
    { ...selected, mode: 'decision', limit: 1 },
    { ...selected, mode: 'decision', snapshot: 'invalid' },
    { ...selected, mode: 'voters' },
    { ...selected, mode: 'voters', position: 'favor', resolve_names: true },
    { ...selected, mode: 'voters', position: 'favor', roster_term: 9 },
    { sitting_id: '2025-01-15', offset: 1 },
    { sitting_id: '2025-01-15', resolve_names: true, roster_term: 9 },
  ] as const)('rejects incompatible mode fields %j before HTTP', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, input),
      'invalid_mode_fields',
      modeHint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ sitting_id: '2025-02-30' }, { sitting_id: '2025-01-15', language: 'xx' }])(
    'rejects unsupported semantic filters %j',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(getPlenaryVotesTool, input),
        'invalid_filter',
        invalidHint,
        JsonRpcErrorCode.ValidationError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sitting_id: 'https://evil.example/2025-01-15' },
    { limit: 1001 },
    { position: 'nonvoter' },
    { roster_term: 11 },
    { unknown: true },
  ])('rejects schema-invalid fields %j', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(getPlenaryVotesTool, {
      sitting_id: selected.sitting_id,
      ...input,
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(contractText(result)).toContain('euparl_get_plenary_votes');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails incomplete repeated name-resolution roster pages', async () => {
    const fetcher = installToolHttp((url) =>
      url.pathname.endsWith('/decisions')
        ? envelopeResponse([decisionRecord])
        : Response.json({ data: [rosterRecords[0]], meta: { total: 2 } }),
    );
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'voters',
        position: 'favor',
        resolve_names: true,
        roster_term: 9,
      }),
      'upstream_paging_stalled',
      stalledHint,
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('shares the operation deadline between decision and roster requests', async () => {
    vi.useFakeTimers();
    const fetcher = installToolHttp((url) => {
      if (url.pathname.endsWith('/decisions')) return envelopeResponse([decisionRecord]);
      vi.setSystemTime(Date.now() + 40_001);
      return envelopeResponse(rosterRecords);
    });
    const result = await runToolContract(getPlenaryVotesTool, {
      ...selected,
      mode: 'voters',
      position: 'favor',
      resolve_names: true,
      roster_term: 9,
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.Timeout } },
    });
    expect(contractText(result)).toContain('40-second deadline');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops name resolution when the caller cancels', async () => {
    const controller = new AbortController();
    const fetcher = installToolHttp((url) => {
      if (url.pathname.endsWith('/decisions')) return envelopeResponse([decisionRecord]);
      controller.abort(new DOMException('Stop voter lookup', 'AbortError'));
      return envelopeResponse(rosterRecords);
    });
    const result = await runToolContract(
      getPlenaryVotesTool,
      { ...selected, mode: 'voters', position: 'favor', resolve_names: true, roster_term: 9 },
      { context: { signal: controller.signal } },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(contractText(result)).toContain('Stop voter lookup');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('renders upstream rejection and rate limiting with declared recovery', async () => {
    installToolHttp(() => new Response(null, { status: 400 }));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: selected.sitting_id }),
      'upstream_rejected',
      rejectedHint,
      JsonRpcErrorCode.InvalidParams,
    );
    const fetcher = installToolHttp(() => new Response(null, { status: 429 }));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: selected.sitting_id }),
      'upstream_rate_limited',
      rateHint,
      JsonRpcErrorCode.RateLimited,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
