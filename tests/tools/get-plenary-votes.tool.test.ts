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
  it.each([
    { sitting_id: '2025-01-15', document_id: '../unsafe' },
    { ...selected, mode: 'decision', mep_id: 'https://evil.example/person/1' },
  ] as const)('rejects invalid added identifier filters %j before HTTP', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, input),
      'invalid_filter',
      invalidHint,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['900000001', 'person/900000001', 'https://data.europarl.europa.eu/person/900000001'])(
    'returns independent recorded and intended membership for %s without a roster request',
    async (mep_id) => {
      const fetcher = installToolHttp(() =>
        envelopeResponse([
          {
            ...decisionRecord,
            had_voter_against: ['person/900000001'],
            had_voter_intended_favor: undefined,
            had_voter_intended_against: [],
            had_voter_intended_abstention: ['person/900000001'],
          },
        ]),
      );
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'decision', mep_id }),
      );
      expect(data).toMatchObject({
        appliedFilters: { mep_id: '900000001' },
        decision: {
          mep_position: {
            recorded: {
              positions: ['favor', 'against'],
              unavailable_positions: [],
              availability: 'published',
            },
            intended: {
              positions: ['abstention'],
              unavailable_positions: ['favor'],
              availability: 'partial',
            },
          },
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves unpublished member positions and published empty arrays', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: decisionRecord.id,
          had_voter_favor: [],
          had_voter_against: [],
          had_voter_abstention: [],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...selected,
        mode: 'decision',
        mep_id: '999999999',
      }),
    );
    expect(data).toMatchObject({
      decision: {
        mep_position: {
          recorded: { positions: [], unavailable_positions: [], availability: 'published' },
          intended: {
            positions: [],
            unavailable_positions: ['favor', 'against', 'abstention'],
            availability: 'unavailable',
          },
        },
      },
    });
    installToolHttp(() => envelopeResponse([{ id: decisionRecord.id }]));
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...selected,
          mode: 'decision',
          mep_id: '999999999',
        }),
      ),
    ).toMatchObject({
      decision: {
        mep_position: {
          recorded: {
            positions: [],
            unavailable_positions: ['favor', 'against', 'abstention'],
            availability: 'unavailable',
          },
        },
      },
    });
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...selected, mode: 'decision', mep_id: ' ' }),
      ).decision,
    ).not.toHaveProperty('mep_position');
    installToolHttp(() => envelopeResponse([decisionRecord]));
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...selected,
          mode: 'decision',
          mep_id: '999999999',
        }),
      ),
    ).toMatchObject({
      decision: {
        mep_position: {
          recorded: { positions: [], availability: 'published' },
          intended: { positions: [], availability: 'published' },
        },
      },
    });
  });
  it('filters the complete sitting by exact or hyphen-boundary document relations before paging', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        { ...decisionRecord, decided_on_a_realization_of: 'eli/dl/doc/OTHER' },
        {
          ...decisionRecord,
          id: 'eli/dl/event/DEC-2',
          activity_id: 'DEC-2',
          decided_on_a_realization_of: { id: 'eli/dl/doc/A-9-2023-0188-AM-808' },
        },
        {
          ...decisionRecord,
          id: 'eli/dl/event/DEC-3',
          activity_id: 'DEC-3',
          decided_on_a_realization_of: [],
          recorded_in_a_realization_of: ['eli/dl/doc/A-9-2023-0188'],
        },
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: selected.sitting_id,
        document_id: 'https://data.europarl.europa.eu/eli/dl/doc/A-9-2023-0188',
        limit: 1,
        language: 'pl',
      }),
    );
    expect(first).toMatchObject({
      totalCount: 2,
      appliedFilters: { document_id: 'A-9-2023-0188' },
      decisions: [
        {
          decision_id: 'DEC-2',
          label: { language: 'en', value: 'Example amendment' },
          document_ids: ['A-9-2023-0188-AM-808'],
          recording_document_ids: ['PV-10-2025-01-15-RCV-ITM-001'],
        },
      ],
      page: { returned: 1, next_offset: 1 },
    });
    expect(first.notice).toContain('Requested language pl unavailable');
    const snapshot = snapshotOf(first);
    const second = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: selected.sitting_id,
        document_id: 'A-9-2023-0188',
        language: 'pl',
        offset: 1,
        limit: 1,
        snapshot,
      }),
    );
    expect(second).toMatchObject({
      decisions: [
        { decision_id: 'DEC-3', document_ids: [], recording_document_ids: ['A-9-2023-0188'] },
      ],
      page: { has_more: false },
    });
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          sitting_id: selected.sitting_id,
          document_id: 'A-9-2023-0188',
          language: 'pl',
          offset: 20,
          snapshot,
        }),
      ),
    ).toMatchObject({ decisions: [], totalCount: 2, page: { has_more: false } });
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: selected.sitting_id,
        document_id: 'A-9-2023-018',
        language: 'pl',
        snapshot,
      }),
      'snapshot_changed',
      snapshotHint,
    );
    const empty = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: selected.sitting_id,
        document_id: 'A-9-2023-018',
      }),
    );
    expect(empty).toMatchObject({ decisions: [], totalCount: 0 });
    expect(empty.notice).toBe(
      'No decisions matched document_id in the complete sitting. Remove document_id to inspect all published decisions.',
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
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
  it('dates sittings published only under the typed-literal key with their written calendar day', async () => {
    // 2014–2019 meeting rows: xsd:dateTime at local midnight, +01:00 in winter and +02:00 in summer.
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'eli/dl/event/MTG-PL-2019-01-14',
          'eli-dl:activity_date': { '@value': '2019-01-14T00:00:00+01:00', type: 'xsd:dateTime' },
        },
        {
          id: 'eli/dl/event/MTG-PL-2019-07-02',
          'eli-dl:activity_date': { '@value': '2019-07-02T00:00:00+02:00', type: 'xsd:dateTime' },
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2019 }),
    );
    expect(data.sittings).toEqual([
      {
        sitting_id: 'MTG-PL-2019-01-14',
        date: '2019-01-14',
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2019-01-14',
      },
      {
        sitting_id: 'MTG-PL-2019-07-02',
        date: '2019-07-02',
        source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2019-07-02',
      },
    ]);
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
        label: { value: 'Example amendment', language: 'en' },
        document_ids: ['A-10-2025-900001'],
        recording_document_ids: ['PV-10-2025-01-15-RCV-ITM-001'],
        partial_document_ids: [],
        vote_item_ids: [],
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
      notice: 'This voter position array was not published in the response.',
    });
    expect(missing).not.toHaveProperty('totalCount');
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
      partial_document_ids: [],
      vote_item_ids: [],
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
      'Names are published identities in the selected term roster, not proof of spelling or affiliation on the vote date. Some voter identities are unresolved. roster_term must be the term containing the sitting date (voter_resolution.sitting_date); if it is not, retry with that term. Call euparl_get_mep with any mep_id still unresolved.',
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
                document_ids: [],
                recording_document_ids: [],
                partial_document_ids: [],
                vote_item_ids: [],
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
    expect(first.notice).toBe(
      'Names are published identities in the selected term roster, not proof of spelling or affiliation on the vote date. Continue with offset 1 and the returned snapshot.',
    );
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
      partial_document_ids: [],
      vote_item_ids: [],
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
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, limit: 1001 }),
    );
    expect(first).toMatchObject({
      page: { limit: 1000, returned: 1, has_more: false },
      notice: 'Requested limit normalized to the effective maximum of 1000 sittings.',
    });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('1000');
    const past = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, offset: 1000 }),
    );
    expect(past).toMatchObject({
      sittings: [],
      page: { offset: 1000, returned: 0, has_more: false },
      notice:
        'The page at offset 1000 returned no sittings. Restart at offset 0 or return to the previous page.',
    });
  });
  it('keeps the no-sittings guidance for an empty year at offset 0', async () => {
    installToolHttp(() => new Response(null, { status: 204 }));
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2009 }),
      ),
    ).toMatchObject({
      sittings: [],
      page: { offset: 0, returned: 0, has_more: false },
      notice: 'No sittings matched this year. Try another year.',
    });
  });

  it.each([
    ['decisions', 100],
    ['voters', 1000],
  ] as const)('pages %s at %i without losing the final item', async (mode, cap) => {
    installToolHttp(() =>
      envelopeResponse(
        mode === 'decisions'
          ? Array.from({ length: cap + 1 }, (_, index) => ({
              id: `eli/dl/event/EXAMPLE-${index}`,
            }))
          : [
              {
                ...decisionRecord,
                had_voter_favor: Array.from(
                  { length: cap + 1 },
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
      await runToolContract(getPlenaryVotesTool, { ...input, limit: cap }),
    );
    expect(first[mode]).toHaveLength(cap);
    expect(first).toMatchObject({
      totalCount: cap + 1,
      cap,
      page: { limit: cap, next_offset: cap },
    });
    expect(first.notice).toBe(`Continue with offset ${cap} and the returned snapshot.`);
    const last = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...input,
        offset: cap,
        snapshot: snapshotOf(first),
      }),
    );
    expect(last[mode]).toEqual(
      mode === 'decisions'
        ? [
            {
              decision_id: 'EXAMPLE-100',
              document_ids: [],
              recording_document_ids: [],
              partial_document_ids: [],
              vote_item_ids: [],
              voter_counts: [],
              source_url: 'https://data.europarl.europa.eu/eli/dl/event/EXAMPLE-100',
            },
          ]
        : [{ mep_id: '900001000' }],
    );
  });

  it('returns a 618-voter position in one call without continuation', async () => {
    const decision_id = 'MTG-PL-2024-03-13-DEC-166086';
    const favor = Array.from({ length: 618 }, (_, index) => `person/${910000000 + index}`);
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        {
          ...decisionRecord,
          id: `eli/dl/event/${decision_id}`,
          activity_id: decision_id,
          activity_date: '2024-03-13',
          had_voter_favor: favor,
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2024-03-13',
        decision_id,
        mode: 'voters',
        position: 'favor',
        limit: 1000,
      }),
    );
    expect(data.voters).toHaveLength(618);
    expect(data).toMatchObject({
      totalCount: 618,
      page: { offset: 0, limit: 1000, returned: 618, has_more: false },
      voters: expect.arrayContaining([{ mep_id: '910000617' }]),
    });
    expect(data.page).not.toHaveProperty('next_offset');
    expect(data).not.toHaveProperty('notice');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

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
    [{}, 'Supply sitting_id for the selected mode.'],
    [{ mode: 'sittings' }, 'Supply a four-digit year for mode sittings.'],
    [
      { mode: 'sittings', year: 2025, document_id: 'A-1' },
      'Remove document_id, or select a mode that accepts document_id.',
    ],
    [
      { mode: 'sittings', year: 2025, mep_id: '1' },
      'Remove mep_id, or use mode decisions or decision for member positions.',
    ],
    [
      { ...selected, mode: 'voters', position: 'favor', mep_id: '1' },
      'Remove mep_id, or use mode decisions or decision for member positions.',
    ],
    [
      { ...selected, mode: 'decision', document_id: 'A-1' },
      'Remove document_id, or select a mode that accepts document_id.',
    ],
    [
      { ...selected, mode: 'voters', position: 'favor', document_id: 'A-1' },
      'Remove document_id, or select a mode that accepts document_id.',
    ],
    [
      { mode: 'sittings', year: 2025, sitting_id: '2025-01-15' },
      'Remove sitting_id, or select a mode that accepts sitting_id.',
    ],
    [{ sitting_id: '2025-01-15', year: 2025 }, 'Remove year, or select a mode that accepts year.'],
    [{ ...selected }, 'Remove decision_id, or select a mode that accepts decision_id.'],
    [
      { ...selected, mode: 'decision', limit: 1 },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [
      { ...selected, mode: 'decision', snapshot: 'invalid' },
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    ],
    [
      { ...selected, mode: 'voters' },
      'Supply position: favor, against, abstention, intended_favor, intended_against, or intended_abstention.',
    ],
    [
      { ...selected, mode: 'voters', position: 'favor', resolve_names: true },
      'Supply roster_term for the sitting date when resolve_names is true.',
    ],
    [
      { ...selected, mode: 'voters', position: 'favor', roster_term: 9 },
      'Remove roster_term, or set resolve_names true in voters mode.',
    ],
    [
      { sitting_id: '2025-01-15', offset: 1 },
      'Pass the previous page.snapshot with the same filters, or restart at offset 0 without snapshot.',
    ],
    [
      { sitting_id: '2025-01-15', resolve_names: true, roster_term: 9 },
      'Remove resolve_names and roster_term, or use mode voters with decision_id and position.',
    ],
  ] as const)('rejects incompatible mode fields %j before HTTP', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, input),
      'invalid_mode_fields',
      hint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ sitting_id: '2025-02-30' }, 'Pass an existing calendar day as YYYY-MM-DD.'],
    [{ sitting_id: '2025-01-15', language: 'xx' }, invalidHint],
  ])('rejects unsupported semantic filters %j', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, input),
      'invalid_filter',
      hint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { sitting_id: 'https://evil.example/2025-01-15' },
    { limit: 2.5 },
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

const decisionPage = z.object({
  decisions: z.array(z.object({ decision_id: z.string() })),
  page: z.object({
    offset: z.number(),
    limit: z.number(),
    returned: z.number(),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
    snapshot: z.string(),
  }),
  notice: z.string().optional(),
});
type DecisionPage = z.infer<typeof decisionPage>;

/** Follow page.next_offset and the snapshot from the first page until has_more is false. */
async function walkDecisions(input: Record<string, unknown>) {
  const pages: { data: DecisionPage; structured: Record<string, unknown>; text: string }[] = [];
  let next = input;
  while (pages.length < 20) {
    const result = await runToolContract(getPlenaryVotesTool, next);
    const structured = expectSuccessTwin(result);
    const data = decisionPage.parse(structured);
    pages.push({ data, structured, text: contractText(result) });
    if (!data.page.has_more) return pages;
    expect(data.page.next_offset).toBeDefined();
    next = { ...input, offset: data.page.next_offset, snapshot: data.page.snapshot };
  }
  throw new Error('Decision walk did not end within 20 pages.');
}
/** Decisions with large relation arrays must remain whole on both surfaces. */
const sizedDecision = (index: number, documents: number) => ({
  id: `eli/dl/event/MTG-PL-2024-03-13-DEC-${index}`,
  activity_id: `MTG-PL-2024-03-13-DEC-${index}`,
  decided_on_a_realization_of: Array.from(
    { length: documents },
    (_, item) => `eli/dl/doc/A-9-2024-0001-AM-${String(item).padStart(4, '0')}`,
  ),
  decided_on_a_part_of_a_realization_of: Array.from(
    { length: 250 },
    (_, item) => `eli/dl/doc/A-9-2024-0002-AM-${item}`,
  ),
  inverse_consists_of: Array.from({ length: 250 }, (_, item) => `eli/dl/event/VOTE-${item}`),
});

describe('euparl_get_plenary_votes caller-sized decisions', () => {
  it('walks changing page sizes past the former character budget without gaps or lost relations', async () => {
    const sitting = Array.from({ length: 107 }, (_, i) =>
      i < 2 ? sizedDecision(i, 420) : { id: `eli/dl/event/MTG-PL-2024-03-13-DEC-${i}` },
    );
    installToolHttp(() => envelopeResponse(sitting));
    const firstResult = await runToolContract(getPlenaryVotesTool, {
      sitting_id: '2024-03-13',
      limit: 103,
    });
    const first = expectSuccessTwin(firstResult);
    expect(first.decisions).toHaveLength(103);
    expect(first.page).toMatchObject({ limit: 103, returned: 103, next_offset: 103 });
    expect(contractText(firstResult).length).toBeGreaterThan(100_000);
    expect(contractText(firstResult)).toContain('result.decisions[1].document_ids[419]');
    expect(contractText(firstResult)).toContain('result.decisions[1].partial_document_ids[249]');
    expect(contractText(firstResult)).toContain('result.decisions[1].vote_item_ids[249]');
    const last = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2024-03-13',
        limit: 7,
        offset: 103,
        snapshot: snapshotOf(first),
      }),
    );
    expect(last.decisions).toHaveLength(4);
    expect(last.page).toMatchObject({ limit: 7, returned: 4, has_more: false });
    expect(last).not.toHaveProperty('notice');
    const walked = await walkDecisions({ sitting_id: '2024-03-13', limit: 1000 });
    expect(walked).toHaveLength(1);
    expect(walked[0]?.data.decisions.map(({ decision_id }) => decision_id)).toEqual(
      Array.from({ length: 107 }, (_, i) => `MTG-PL-2024-03-13-DEC-${i}`),
    );
  });
});

const voteItem = (number: number) => `eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-${number}`;
const decision1217 = (number: number, relations: Record<string, unknown>) => ({
  id: `eli/dl/event/MTG-PL-2025-12-17-DEC-${number}`,
  activity_id: `MTG-PL-2025-12-17-DEC-${number}`,
  activity_date: '2025-12-17',
  ...relations,
});
/** Shapes published on 2025-12-17: decided-on, part-of and recording relations under vote items. */
const sitting1217 = [
  decision1217(182634, {
    activity_label: { en: 'A10-0244/2025 – Andrzej Buła – Am 1' },
    decided_on_a_realization_of: 'eli/dl/doc/A-10-2025-0244-AM-001',
    inverse_consists_of: [voteItem(978508)],
  }),
  decision1217(182635, {
    activity_label: { en: 'A10-0244/2025 – Andrzej Buła – Am 2' },
    decided_on_a_realization_of: 'eli/dl/doc/A-10-2025-0244-AM-002',
    inverse_consists_of: [voteItem(978508)],
  }),
  decision1217(182797, {
    activity_label: {
      en: 'A10-0244/2025 – Andrzej Buła – Motion for a resolution (as a whole)',
    },
    recorded_in_a_realization_of: 'eli/dl/doc/PV-10-2025-12-17-RCV-ITM-021',
    inverse_consists_of: [voteItem(978508)],
  }),
  decision1217(182800, {
    decided_on_a_realization_of: 'eli/dl/doc/A-10-2025-0195-AM-001',
    inverse_consists_of: [voteItem(978310)],
  }),
  decision1217(182811, {
    activity_label: { en: 'Text as a whole' },
    decided_on_a_part_of_a_realization_of: 'eli/dl/doc/A-10-2025-0195-AM-27',
    inverse_consists_of: [voteItem(978310)],
  }),
  decision1217(182840, {
    activity_label: { en: 'Recital 17' },
    decided_on_a_part_of_a_realization_of: 'eli/dl/doc/A-10-2025-0195-AM-27',
    inverse_consists_of: [voteItem(978310)],
  }),
  decision1217(182855, { inverse_consists_of: [voteItem(978310)] }),
];
const ids = (data: Record<string, unknown>) =>
  decisionPage.parse(data).decisions.map(({ decision_id }) => decision_id.slice(-6));
const steering = (items: string) =>
  `document_id left out other decisions of the vote items it matched: ${items}. Pass a vote item as vote_item_id without document_id to read all of its decisions.`;

describe('euparl_get_plenary_votes part-of and vote-item relations', () => {
  it('matches document_id through part-of relations and names the vote items it left decisions out of', async () => {
    installToolHttp(() => envelopeResponse(sitting1217));
    const report = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2025-12-17',
        document_id: 'A-10-2025-0195',
        limit: 100,
      }),
    );
    expect(ids(report)).toEqual(['182800', '182811', '182840']);
    expect(report.totalCount).toBe(3);
    expect(report.notice).toBe(steering('MTG-PL-2025-12-17-VOT-ITM-978310 (1 of 4 left out)'));
    expect(z.array(z.unknown()).parse(report.decisions)[1]).toEqual({
      decision_id: 'MTG-PL-2025-12-17-DEC-182811',
      label: { value: 'Text as a whole', language: 'en' },
      document_ids: [],
      recording_document_ids: [],
      partial_document_ids: ['A-10-2025-0195-AM-27'],
      vote_item_ids: ['MTG-PL-2025-12-17-VOT-ITM-978310'],
      date: '2025-12-17',
      voter_counts: [],
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-DEC-182811',
    });
    const amendments = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2025-12-17',
        document_id: 'A-10-2025-0244',
      }),
    );
    expect(ids(amendments)).toEqual(['182634', '182635']);
    expect(amendments.notice).toBe(steering('MTG-PL-2025-12-17-VOT-ITM-978508 (1 of 3 left out)'));
    const rich = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2025-12-17',
        mode: 'decision',
        decision_id: 'MTG-PL-2025-12-17-DEC-182840',
      }),
    );
    expect(rich.decision).toMatchObject({
      document_ids: [],
      partial_document_ids: ['A-10-2025-0195-AM-27'],
      vote_item_ids: ['MTG-PL-2025-12-17-VOT-ITM-978310'],
    });
  });

  it.each([
    'MTG-PL-2025-12-17-VOT-ITM-978508',
    'eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978508',
    'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978508',
  ])('selects every decision of vote item %s', async (vote_item_id) => {
    const fetcher = installToolHttp(() => envelopeResponse(sitting1217));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-12-17', vote_item_id }),
    );
    expect(ids(data)).toEqual(['182634', '182635', '182797']);
    expect(data).toMatchObject({
      totalCount: 3,
      appliedFilters: { vote_item_id: 'MTG-PL-2025-12-17-VOT-ITM-978508' },
    });
    expect(data).not.toHaveProperty('notice');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('intersects vote_item_id with document_id and keeps it in the snapshot scope', async () => {
    installToolHttp(() => envelopeResponse(sitting1217));
    const input = {
      sitting_id: '2025-12-17',
      vote_item_id: 'MTG-PL-2025-12-17-VOT-ITM-978310',
      document_id: 'A-10-2025-0195-AM-27',
      limit: 1,
    };
    const first = expectSuccessTwin(await runToolContract(getPlenaryVotesTool, input));
    expect(ids(first)).toEqual(['182811']);
    expect(first).toMatchObject({
      totalCount: 2,
      appliedFilters: {
        document_id: 'A-10-2025-0195-AM-27',
        vote_item_id: 'MTG-PL-2025-12-17-VOT-ITM-978310',
      },
      notice: 'Continue with offset 1 and the returned snapshot.',
    });
    const snapshot = snapshotOf(first);
    expect(
      ids(
        expectSuccessTwin(
          await runToolContract(getPlenaryVotesTool, { ...input, offset: 1, snapshot }),
        ),
      ),
    ).toEqual(['182840']);
    const { vote_item_id: _dropped, ...withoutVoteItem } = input;
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { ...withoutVoteItem, offset: 1, snapshot }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('caps the steering notice at five named vote items and counts the rest', async () => {
    installToolHttp(() =>
      envelopeResponse(
        Array.from({ length: 14 }, (_, index) =>
          decision1217(190000 + index, {
            ...(index % 2 === 0 && {
              decided_on_a_realization_of: `eli/dl/doc/A-10-2025-0300-AM-${index}`,
            }),
            inverse_consists_of: [voteItem(979000 + Math.floor(index / 2))],
          }),
        ),
      ),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2025-12-17',
        document_id: 'A-10-2025-0300',
      }),
    );
    expect(data.notice).toBe(
      steering(
        `${[0, 1, 2, 3, 4].map((item) => `MTG-PL-2025-12-17-VOT-ITM-97900${item} (1 of 2 left out)`).join(', ')}, and 2 more vote items (2 decisions left out; each decision row lists its vote_item_ids)`,
      ),
    );
  });

  it.each([
    { mode: 'sittings', year: 2025 },
    { ...selected, mode: 'decision' },
    { ...selected, mode: 'voters', position: 'favor' },
  ] as const)('rejects vote_item_id outside decisions mode %j before HTTP', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...input,
        vote_item_id: 'MTG-PL-2025-01-15-VOT-ITM-1',
      }),
      'invalid_mode_fields',
      'Remove vote_item_id, or select a mode that accepts vote_item_id.',
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'MTG-PL-2025-12-17-VOT-ITM-978508',
    'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978508',
  ])('rejects vote item %s dated off the sitting before HTTP', async (vote_item_id) => {
    const fetcher = installToolHttp(() => envelopeResponse(sitting1217));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-12-16', vote_item_id }),
      'invalid_filter',
      'Retry with sitting_id 2025-12-17, the date in vote_item_id.',
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a vote item outside the public event namespace at the schema', async () => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(getPlenaryVotesTool, {
      sitting_id: '2025-12-17',
      vote_item_id: 'https://evil.example/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-1',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ document_id: 'A-9-2023-0188' }, 'document_id'],
    [{ vote_item_id: 'MTG-PL-2023-06-14-VOT-ITM-939243' }, 'vote_item_id'],
    [
      { document_id: 'A-9-2023-0188', vote_item_id: 'MTG-PL-2023-06-14-VOT-ITM-939243' },
      'document_id and vote_item_id',
    ],
  ] as const)(
    'points %j to decision labels on a sitting without report or vote-item relations',
    async (filters, names) => {
      installToolHttp(() =>
        envelopeResponse([
          {
            id: 'eli/dl/event/MTG-PL-2023-06-14-DEC-1',
            activity_id: 'MTG-PL-2023-06-14-DEC-1',
            activity_label: { en: 'A9-0188/2023 – Example Rapporteur – Am 808' },
            recorded_in_a_realization_of: 'eli/dl/doc/PV-9-2023-06-14-RCV-ITM-001',
          },
        ]),
      );
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { sitting_id: '2023-06-14', ...filters }),
      );
      expect(data).toMatchObject({ decisions: [], totalCount: 0 });
      expect(data.notice).toBe(
        `No decision in this sitting publishes a decided-on, part-of or vote-item relation, so a report or vote item cannot select its decisions. Remove ${names} and use label_contains with the report's citation (its document label, such as A9-0188/2023). Matching label text does not establish a final vote.`,
      );
    },
  );

  it.each([
    [
      { document_id: 'A-10-2025-0999' },
      "No decisions matched document_id in the complete sitting. A vote can decide on no document: pass the procedure's PLENARY_VOTE_RESULTS event id as vote_item_id, or remove document_id to inspect all published decisions.",
    ],
    [
      { vote_item_id: 'MTG-PL-2025-12-17-VOT-ITM-970000' },
      'No decision in this sitting belongs to vote_item_id. Remove vote_item_id to inspect all published decisions.',
    ],
    [
      { vote_item_id: 'MTG-PL-2025-12-17-VOT-ITM-978508', document_id: 'A-10-2025-0195' },
      "No decision of vote_item_id matched document_id. Remove document_id to read the vote item's 3 decisions.",
    ],
  ] as const)('names the filter that matched nothing in %j', async (filters, notice) => {
    installToolHttp(() => envelopeResponse(sitting1217));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-12-17', ...filters }),
    );
    expect(data).toMatchObject({ decisions: [], totalCount: 0, notice });
  });

  it.each([
    [404, { document_id: 'A-8-2018-0400' }],
    [404, { vote_item_id: 'MTG-PL-2018-12-12-VOT-ITM-000001' }],
    [204, { vote_item_id: 'MTG-PL-2018-12-12-VOT-ITM-000001', document_id: 'A-8-2018-0400' }],
  ] as const)(
    'routes a filtered HTTP %i sitting %j to sitting discovery',
    async (status, filters) => {
      installToolHttp(() => new Response(null, { status }));
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { sitting_id: '2018-12-12', ...filters }),
      );
      expect(data).toMatchObject({
        decisions: [],
        totalCount: 0,
        notice:
          'No decision data was published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.',
      });
    },
  );
  it('characterizes omitted member projection and intact relations', async () => {
    installToolHttp(() => envelopeResponse([decisionRecord]));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-01-15' }),
    );
    expect(data.decisions).toEqual([
      expect.objectContaining({ decision_id: 'MTG-PL-2025-01-15-DEC-900001' }),
    ]);
    expect(data.decisions).toEqual([
      expect.not.objectContaining({ mep_position: expect.anything() }),
    ]);
  });
  it('projects members and selects literal normalized labels before paging', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        { ...decisionRecord, activity_label: { en: 'Report A9–0179/2022 (text   AS A WHOLE)' } },
        { ...decisionRecord, activity_id: 'OTHER', activity_label: { en: 'Other' } },
      ]),
    );
    const wire = await runToolContract(getPlenaryVotesTool, {
      sitting_id: '2025-01-15',
      mep_id: 'person/900000001',
      label_contains: ' A9-0179/2022   (TEXT as a whole) ',
      limit: 1,
    });
    const data = expectSuccessTwin(wire);
    expect(data).toMatchObject({
      totalCount: 1,
      appliedFilters: { mep_id: '900000001', label_contains: 'a9-0179/2022 (text as a whole)' },
      decisions: [
        {
          label: { value: 'Report A9–0179/2022 (text   AS A WHOLE)' },
          mep_position: { recorded: { positions: ['favor'], availability: 'published' } },
        },
      ],
      page: { has_more: false },
    });
    expect(contractText(wire)).toContain('mep_position.recorded');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { document_id: 'A-1' },
    { vote_item_id: 'MTG-PL-2025-01-15-VOT-ITM-1' },
    { document_id: 'A-1', vote_item_id: 'MTG-PL-2025-01-15-VOT-ITM-1' },
  ])(
    'names the label filter when relations matched but the label excluded them %j',
    async (filters) => {
      installToolHttp(() =>
        envelopeResponse([
          {
            ...decisionRecord,
            activity_label: { en: 'Report' },
            decided_on_a_realization_of: 'eli/dl/doc/A-1',
            inverse_consists_of: 'eli/dl/event/MTG-PL-2025-01-15-VOT-ITM-1',
          },
        ]),
      );
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          sitting_id: '2025-01-15',
          ...filters,
          label_contains: 'different',
        }),
      );
      expect(data).toMatchObject({
        decisions: [],
        totalCount: 0,
        notice:
          'No published decision label matched label_contains within the selected document and vote-item filters. Remove or change label_contains; matching text does not establish a final vote.',
      });
    },
  );
  it.each([
    [
      {},
      {
        positions: [],
        unavailable_positions: ['favor', 'against', 'abstention'],
        availability: 'unavailable',
      },
    ],
    [
      { had_voter_favor: [] },
      { positions: [], unavailable_positions: ['against', 'abstention'], availability: 'partial' },
    ],
    [
      { had_voter_favor: [], had_voter_against: [], had_voter_abstention: [] },
      { positions: [], unavailable_positions: [], availability: 'published' },
    ],
    [
      { had_voter_favor: ['person/1'], had_voter_against: ['person/1'], had_voter_abstention: [] },
      { positions: ['favor', 'against'], unavailable_positions: [], availability: 'published' },
    ],
  ])('preserves member availability and conflicts %j', async (voters, recorded) => {
    installToolHttp(() =>
      envelopeResponse([
        { id: decisionRecord.id, ...voters, had_voter_intended_abstention: ['person/1'] },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-01-15', mep_id: '1' }),
    );
    expect(data.decisions).toEqual([
      expect.objectContaining({
        mep_position: {
          recorded,
          intended: {
            positions: ['abstention'],
            unavailable_positions: ['favor', 'against'],
            availability: 'partial',
          },
        },
      }),
    ]);
  });
  it.each([
    ['a9−0179/2022', { en: 'A9—0179/2022' }, 1],
    ['as   A whole', { en: '(text as a whole)' }, 1],
    ['[.*]', { en: 'literal [.*] label' }, 1],
    ['[.*]', { en: 'other text' }, 0],
    ['report', undefined, 0],
    ['rapport', { fr: 'Rapport' }, 1],
    ['  ', undefined, 1],
  ] as const)(
    'matches label %s literally with source language preserved',
    async (label_contains, activity_label, totalCount) => {
      installToolHttp(() => envelopeResponse([{ id: decisionRecord.id, activity_label }]));
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-01-15', label_contains }),
      );
      expect(data.totalCount).toBe(totalCount);
      expect(data.decisions).toHaveLength(totalCount);
      if (label_contains.trim() === '')
        expect(data.appliedFilters).not.toHaveProperty('label_contains');
      if (activity_label && 'fr' in activity_label)
        expect(data).toMatchObject({
          decisions: [{ label: { language: 'fr', value: 'Rapport' } }],
        });
    },
  );
  it('combines filters before paging, scopes normalized selectors and handles an offset past the end', async () => {
    installToolHttp(() =>
      envelopeResponse(
        Array.from({ length: 3 }, (_, index) => ({
          ...decisionRecord,
          activity_id: `DEC-${index}`,
          activity_label: { en: index === 0 ? 'other' : 'Report – final' },
          inverse_consists_of: 'eli/dl/event/MTG-PL-2025-01-15-VOT-ITM-1',
          decided_on_a_realization_of: 'eli/dl/doc/A-1',
        })),
      ),
    );
    const filters = {
      sitting_id: '2025-01-15',
      document_id: 'A-1',
      vote_item_id: 'MTG-PL-2025-01-15-VOT-ITM-1',
      mep_id: '1',
      label_contains: ' report - FINAL ',
      limit: 1,
    };
    const first = expectSuccessTwin(await runToolContract(getPlenaryVotesTool, filters));
    expect(first).toMatchObject({
      totalCount: 2,
      decisions: [{ decision_id: 'DEC-1' }],
      page: { next_offset: 1 },
    });
    const snapshot = (first.page as { snapshot: string }).snapshot;
    const second = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...filters,
        label_contains: 'REPORT — final',
        mep_id: 'person/1',
        snapshot,
        offset: 1,
      }),
    );
    expect(second).toMatchObject({
      decisions: [{ decision_id: 'DEC-2' }],
      page: { has_more: false, snapshot },
    });
    const past = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...filters, snapshot, offset: 10 }),
    );
    expect(past).toMatchObject({
      decisions: [],
      totalCount: 2,
      page: { returned: 0, has_more: false },
    });
    for (const changed of [{ mep_id: '2' }, { label_contains: 'report' }]) {
      expectErrorTwin(
        await runToolContract(getPlenaryVotesTool, { ...filters, ...changed, snapshot, offset: 1 }),
        'snapshot_changed',
        'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.',
      );
    }
  });
  it.each([
    { mode: 'sittings', year: 2025 },
    { mode: 'decision', sitting_id: '2025-01-15', decision_id: 'DEC-1' },
    { mode: 'voters', sitting_id: '2025-01-15', decision_id: 'DEC-1', position: 'favor' },
  ] as const)(
    'rejects meaningful label selection outside decisions before HTTP %j',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(getPlenaryVotesTool, { ...input, label_contains: 'report' }),
        'invalid_mode_fields',
        'Remove label_contains, or select a mode that accepts label_contains.',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
