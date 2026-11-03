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
      await runToolContract(getPlenaryVotesTool, { mode: 'sittings', year: 2025, limit: 1000 }),
    );
    expect(first).toMatchObject({
      page: { limit: 100, returned: 1, has_more: false },
      notice: 'Requested limit normalized to the effective maximum of 100 sittings.',
    });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('limit')).toBe('100');
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
  ] as const)('caps %s at %i without losing the final item', async (mode, cap) => {
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
      await runToolContract(getPlenaryVotesTool, { ...input, limit: 5000 }),
    );
    expect(first[mode]).toHaveLength(cap);
    expect(first).toMatchObject({
      totalCount: cap + 1,
      cap,
      page: { limit: cap, next_offset: cap },
    });
    expect(first.notice).toBe(
      `Requested limit normalized to the effective maximum of ${cap} ${mode}. Continue with offset ${cap} and the returned snapshot.`,
    );
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
    {},
    { mode: 'sittings' },
    { mode: 'sittings', year: 2025, document_id: 'A-1' },
    { mode: 'sittings', year: 2025, mep_id: '1' },
    { sitting_id: '2025-01-15', mep_id: '1' },
    { ...selected, mode: 'voters', position: 'favor', mep_id: '1' },
    { ...selected, mode: 'decision', document_id: 'A-1' },
    { ...selected, mode: 'voters', position: 'favor', document_id: 'A-1' },
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
/** Characters the rendered rows spend: each `result.decisions[i].` paragraph plus its separator. */
function rowChars(text: string): number {
  return text
    .split('\n\n')
    .filter((paragraph) => paragraph.startsWith('result.decisions['))
    .reduce((sum, paragraph) => sum + paragraph.length + 2, 0);
}
/** A decision whose decided-on array sets its rendered size, about 68 characters per document. */
const sizedDecision = (index: number, documents: number) => ({
  id: `eli/dl/event/MTG-PL-2024-03-13-DEC-${index}`,
  activity_id: `MTG-PL-2024-03-13-DEC-${index}`,
  decided_on_a_realization_of: Array.from(
    { length: documents },
    (_, item) => `eli/dl/doc/A-9-2024-0001-AM-${String(item).padStart(4, '0')}`,
  ),
});
const sizedSitting = [420, 420, 420, 700, 120, 1400, 50].map((documents, index) =>
  sizedDecision(index, documents),
);
const budgetNotice = (returned: number) =>
  `The 92000-character budget for decision rows ended this page after ${returned} whole decision${returned === 1 ? '' : 's'}.`;

describe('euparl_get_plenary_votes decisions row budget', () => {
  it('ends pages at whole decisions within 92000 row characters and resumes without repeats or gaps', async () => {
    installToolHttp(() => envelopeResponse(sizedSitting));
    const pages = await walkDecisions({ sitting_id: '2024-03-13', limit: 100 });
    expect(pages.map(({ data }) => data.decisions.map(({ decision_id }) => decision_id))).toEqual(
      [[0, 1, 2], [3, 4], [5], [6]].map((ids) => ids.map((id) => `MTG-PL-2024-03-13-DEC-${id}`)),
    );
    const snapshot = pages[0]?.data.page.snapshot;
    expect(pages.map(({ data }) => data.page)).toEqual([
      { offset: 0, limit: 100, returned: 3, has_more: true, next_offset: 3, snapshot },
      { offset: 3, limit: 100, returned: 2, has_more: true, next_offset: 5, snapshot },
      { offset: 5, limit: 100, returned: 1, has_more: true, next_offset: 6, snapshot },
      { offset: 6, limit: 100, returned: 1, has_more: false, snapshot },
    ]);
    pages.forEach(({ data, structured, text }, index) => {
      expect(text.length).toBeLessThanOrEqual(100_000);
      expect(text).toContain('result.page.limit: 100');
      expect(structured.totalCount).toBe(7);
      if (data.page.has_more) {
        expect(text).toContain(`result.page.next_offset: ${data.page.next_offset}`);
        expect(data.notice).toBe(
          `${budgetNotice(data.page.returned)} Continue with offset ${data.page.next_offset} and the returned snapshot.`,
        );
        expect(structured).toMatchObject({ truncated: true, shown: data.page.returned, cap: 100 });
      } else expect(structured).not.toHaveProperty('notice');
      if (data.page.returned > 1) expect(rowChars(text)).toBeLessThanOrEqual(92_000);
      expect(index).toBeLessThan(4);
    });
    const oversized = pages[2]!.text;
    expect(rowChars(oversized)).toBeGreaterThan(92_000);
    expect(oversized).toContain(
      'result.decisions[0].document_ids[1399]: ` "A-9-2024-0001-AM-1399" `',
    );
  });

  it('lets the count end a page whose rows fit, with no budget notice', async () => {
    installToolHttp(() => envelopeResponse(sizedSitting));
    const first = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2024-03-13', limit: 2 }),
    );
    expect(first).toMatchObject({
      page: { limit: 2, returned: 2, next_offset: 2 },
      notice: 'Continue with offset 2 and the returned snapshot.',
    });
  });

  it('keeps a full budgeted page with every notice inside 100000 characters of content[]', async () => {
    const typical = (index: number) => {
      const report = 100 + Math.floor(index / 8);
      return {
        ...decisionRecord,
        id: `eli/dl/event/MTG-PL-2024-03-13-DEC-${166000 + index}`,
        activity_id: `MTG-PL-2024-03-13-DEC-${166000 + index}`,
        activity_date: '2024-03-13',
        activity_label: {
          en: `A9-0${report}/2024 – Example Rapporteur – Amendment ${index} to the motion for a resolution on an example file`,
        },
        decided_on_a_realization_of:
          index % 8 === 7 ? [] : [`eli/dl/doc/A-9-2024-0${report}-AM-${index}`],
        recorded_in_a_realization_of: [`eli/dl/doc/PV-9-2024-03-13-RCV-ITM-${index}`],
        inverse_consists_of: [`eli/dl/event/MTG-PL-2024-03-13-VOT-ITM-${940000 + report}`],
      };
    };
    installToolHttp(() =>
      envelopeResponse(Array.from({ length: 160 }, (_, index) => typical(index))),
    );
    const result = await runToolContract(getPlenaryVotesTool, {
      sitting_id: '2024-03-13',
      document_id: 'A-9-2024',
      language: 'pl',
      limit: 500,
    });
    const structured = expectSuccessTwin(result);
    const { decisions, page, notice } = decisionPage.parse(structured);
    const text = contractText(result);
    expect(structured.totalCount).toBe(140);
    expect(page).toMatchObject({ limit: 100, has_more: true, next_offset: decisions.length });
    expect(decisions.length).toBeGreaterThan(50);
    expect(decisions.length).toBeLessThan(100);
    for (const part of [
      'Requested limit normalized to the effective maximum of 100 decisions.',
      'Requested language pl unavailable; returned published en text.',
      'document_id left out other decisions of the vote items it matched: MTG-PL-2024-03-13-VOT-ITM-940100 (1 of 8 left out),',
      'and 15 more vote items (15 decisions left out; each decision row lists its vote_item_ids).',
      budgetNotice(decisions.length),
      `Continue with offset ${decisions.length} and the returned snapshot.`,
    ])
      expect(notice).toContain(part);
    expect(rowChars(text)).toBeLessThanOrEqual(92_000);
    expect(text.length - rowChars(text)).toBeLessThanOrEqual(8_000);
    expect(text.length).toBeLessThanOrEqual(100_000);
  });

  it('charges part-of and vote-item rows their exact rendered size: rows at 92000 stay, one character more cuts', async () => {
    /** Size comes from the part-of and vote-item arrays; the label pads a row by exactly `pad` characters. */
    const related = (index: number, pad: number) => ({
      id: `eli/dl/event/MTG-PL-2024-03-13-DEC-${index}`,
      activity_id: `MTG-PL-2024-03-13-DEC-${index}`,
      activity_label: { en: `L${'x'.repeat(pad)}` },
      decided_on_a_part_of_a_realization_of: Array.from(
        { length: 250 },
        (_, item) => `eli/dl/doc/A-9-2024-0001-AM-${String(item).padStart(4, '0')}`,
      ),
      inverse_consists_of: Array.from(
        { length: 250 },
        (_, item) => `eli/dl/event/MTG-PL-2024-03-13-VOT-ITM-${900000 + item}`,
      ),
    });
    /** Rendered characters of row `index`: its paragraphs plus the blank line before each. */
    const rowText = (text: string, index: number) =>
      text
        .split('\n\n')
        .filter((paragraph) => paragraph.startsWith(`result.decisions[${index}].`))
        .reduce((sum, paragraph) => sum + paragraph.length + 2, 0);
    const firstPage = async (sitting: unknown[]) => {
      installToolHttp(() => envelopeResponse(sitting));
      const result = await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2024-03-13',
        limit: 100,
      });
      return { data: decisionPage.parse(expectSuccessTwin(result)), text: contractText(result) };
    };
    // The rendered content[] is the oracle: measure two unpadded rows on a page the budget leaves whole.
    const measured = await firstPage([related(0, 0), related(1, 0)]);
    expect(measured.data.page).toMatchObject({ returned: 2, has_more: false });
    expect(measured.text).toContain(
      'result.decisions[1].vote_item_ids[249]: ` "MTG-PL-2024-03-13-VOT-ITM-900249" `',
    );
    const pad = 92_000 - rowText(measured.text, 0) - rowText(measured.text, 1);
    expect(pad).toBeGreaterThan(0);
    const exact = await firstPage([related(0, 0), related(1, pad), related(2, 0)]);
    expect(rowText(exact.text, 0) + rowText(exact.text, 1)).toBe(92_000);
    expect(exact.data.page).toMatchObject({ returned: 2, has_more: true, next_offset: 2 });
    const over = await firstPage([related(0, 0), related(1, pad + 1), related(2, 0)]);
    expect(over.data.page).toMatchObject({ returned: 1, has_more: true, next_offset: 1 });
    expect(over.data.notice).toBe(
      `${budgetNotice(1)} Continue with offset 1 and the returned snapshot.`,
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
      modeHint,
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
        `No decision in this sitting publishes a decided-on, part-of or vote-item relation, so a report or vote item cannot select its decisions. Remove ${names} and find the report's citation (its document label, such as A9-0188/2023) in decision labels.`,
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
});
