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
    [
      { sitting_id: '2025-01-15', document_id: '../unsafe' },
      'document_id "../unsafe" is not a document identifier or citation.',
      'Call euparl_search_documents in search mode for canonical document_id values, then retry; pass a question citation such as E-000003/2025 to euparl_list_questions as question_id.',
    ],
    [
      { ...selected, mode: 'decision', mep_id: 'https://evil.example/person/1' },
      'mep_id "https://evil.example/person/1" is not a person identifier. Accepted forms: a decimal person ID (124867), person/124867, or https://data.europarl.europa.eu/person/124867.',
      "Call euparl_search_meps with name_contains for the member's mep_id, then retry with it as mep_id.",
    ],
  ] as const)(
    'rejects invalid added identifier filters %j before HTTP',
    async (input, message, hint) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      const failure = await runToolContract(getPlenaryVotesTool, input);
      expectErrorTwin(failure, 'invalid_filter', hint);
      expect(contractText(failure)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  /** Live shape of MTG-PL-2019-01-14-DEC-100087: each voter array holds only "person/". */
  const unnamedDecision = {
    id: 'eli/dl/event/MTG-PL-2019-01-14-DEC-100087',
    type: 'Vote',
    activity_date: '2019-01-14',
    activity_id: 'MTG-PL-2019-01-14-DEC-100087',
    activity_label: { fr: 'Ordre du jour du lundi - demande du groupe Verts/ALE' },
    decision_method: 'def/ep-decision-methods/VOTE_ELECTRONIC_ROLLCALL',
    had_voter_abstention: ['person/'],
    had_voter_against: ['person/'],
    had_voter_favor: ['person/'],
    number_of_votes_abstention: 18,
    number_of_votes_against: 153,
    number_of_votes_favor: 143,
    recorded_in_a_realization_of: ['eli/dl/doc/PV-8-2019-01-14-RCV-ITM-001'],
  };
  /** An ordinary roll call on the same sitting, as 2019-03-27 mixes both shapes. */
  const namedDecision = {
    ...decisionRecord,
    id: 'eli/dl/event/MTG-PL-2019-01-14-DEC-100088',
    activity_id: 'MTG-PL-2019-01-14-DEC-100088',
    activity_date: '2019-01-14',
  };
  const unnamedNotice =
    'Parliament publishes voter entries that name no person (person/ with no identifier) on some decisions; they are left out of voters, voter_counts and mep_position, and favor, against and abstention keep the published tallies.';
  it('pages a sitting mixing decisions whose voter entries name no person with ordinary roll calls', async () => {
    installToolHttp(() => envelopeResponse([unnamedDecision, namedDecision]));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { sitting_id: '2019-01-14' }),
    );
    expect(data.decisions).toMatchObject([
      {
        decision_id: 'MTG-PL-2019-01-14-DEC-100087',
        favor: 143,
        against: 153,
        abstention: 18,
        voter_counts: [
          { position: 'favor', count: 0 },
          { position: 'against', count: 0 },
          { position: 'abstention', count: 0 },
        ],
      },
      {
        decision_id: 'MTG-PL-2019-01-14-DEC-100088',
        voter_counts: [
          { position: 'favor', count: 2 },
          { position: 'against', count: 1 },
          { position: 'abstention', count: 0 },
          { position: 'intended_favor', count: 1 },
          { position: 'intended_against', count: 1 },
          { position: 'intended_abstention', count: 1 },
        ],
      },
    ]);
    expect(data.notice).toContain(unnamedNotice);
  });
  it('reads a decision whose voter entries name no person and pages no voter for it', async () => {
    installToolHttp(() => envelopeResponse([unnamedDecision, namedDecision]));
    const decision = { sitting_id: '2019-01-14', decision_id: unnamedDecision.activity_id };
    const record = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...decision, mode: 'decision' }),
    );
    expect(record).toMatchObject({
      decision: { decision_id: 'MTG-PL-2019-01-14-DEC-100087', favor: 143 },
    });
    expect(record.notice).toContain(unnamedNotice);
    const voters = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...decision,
        mode: 'voters',
        position: 'favor',
      }),
    );
    expect(voters).toMatchObject({ voters: [], available: true, totalCount: 0 });
    expect(voters.notice).toContain(unnamedNotice);
    const named = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2019-01-14',
        decision_id: namedDecision.activity_id,
        mode: 'voters',
        position: 'favor',
      }),
    );
    expect(named.voters).toEqual([{ mep_id: '900000001' }, { mep_id: '900000002' }]);
    expect(String(named.notice ?? '')).not.toContain(unnamedNotice);
  });
  it('fails a decision with a malformed relation as a Parliament serialization failure naming no input', async () => {
    installToolHttp(() =>
      envelopeResponse([
        decisionRecord,
        { ...namedDecision, decided_on_a_realization_of: ['eli/dl/doc/A 10'] },
      ]),
    );
    const failure = await runToolContract(getPlenaryVotesTool, { sitting_id: '2025-01-15' });
    const { error } = z
      .object({
        error: z.object({
          code: z.number(),
          message: z.string(),
          data: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(failure.structuredContent);
    expect(failure.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data.reason).toBeUndefined();
    expect(error.message).toBe(
      'Parliament returned a record with a malformed document identifier "eli/dl/doc/A 10".',
    );
    for (const parameter of Object.keys(getPlenaryVotesTool.input.shape))
      expect(error.message).not.toMatch(new RegExp(`\\b${parameter}\\b`));
    expect(contractText(failure)).toContain(error.message);
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
      'Names are published identities in the selected term roster, not proof of spelling or affiliation on the vote date. Some voter identities are unresolved. roster_term must be the term containing the sitting date 2025-01-15; if it is not, retry with that term. For voters still without a name, call euparl_search_meps once with mep_ids set to their mep_ids, mandate_date 2025-01-15 and limit at least their count: it returns each name with the country and political group published that day. An ID it lists in unmatched_mep_ids was not seated that day; read it with euparl_get_mep.',
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

  it('names the sitting date in the unresolved-voter routing when the decision publishes no date', async () => {
    installToolHttp((url) =>
      url.pathname.endsWith('/decisions')
        ? envelopeResponse([
            {
              ...decisionRecord,
              activity_date: undefined,
              had_voter_favor: ['person/999999999'],
            },
          ])
        : envelopeResponse(rosterRecords),
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
    expect(data.voters).toEqual([{ mep_id: '999999999' }]);
    expect(data.voter_resolution).toEqual({
      scope: 'parliamentary_term',
      term: 9,
      resolved: 0,
      unresolved: 1,
    });
    expect(data.notice).toContain(
      'roster_term must be the term containing the sitting date 2025-01-15; if it is not, retry with that term. For voters still without a name, call euparl_search_meps once with mep_ids set to their mep_ids, mandate_date 2025-01-15 and limit at least their count',
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
    [
      { sitting_id: '2025-02-30' },
      'sitting_id "2025-02-30" is not a real calendar date in YYYY-MM-DD form.',
      'Pass an existing calendar day as YYYY-MM-DD.',
    ],
    [
      { sitting_id: 'MTG-PL-2024-04-31' },
      'sitting_id "MTG-PL-2024-04-31" is not a real calendar date in YYYY-MM-DD form.',
      'Pass an existing calendar day as YYYY-MM-DD.',
    ],
    [
      { mode: 'vote_items' as const, sitting_id: 'eli/dl/event/MTG-PL-2023-02-29' },
      'sitting_id "eli/dl/event/MTG-PL-2023-02-29" is not a real calendar date in YYYY-MM-DD form.',
      'Pass an existing calendar day as YYYY-MM-DD.',
    ],
    [
      { sitting_id: '2025-01-15', language: 'xx' },
      'Unsupported language filter "xx".',
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
  ])('rejects unsupported semantic filters %j', async (input, message, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const failure = await runToolContract(getPlenaryVotesTool, input);
    expectErrorTwin(failure, 'invalid_filter', hint, JsonRpcErrorCode.ValidationError);
    expect(contractText(failure)).toContain(message);
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
    [
      'MTG-PL-2025-12-17-VOT-ITM-978508',
      '2025-12-16',
      'vote_item_id "MTG-PL-2025-12-17-VOT-ITM-978508" belongs to the 2025-12-17 sitting, not to sitting_id "2025-12-16"; both must name the same sitting.',
    ],
    [
      'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978508',
      'MTG-PL-2025-12-16',
      'vote_item_id "https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978508" belongs to the 2025-12-17 sitting, not to sitting_id "MTG-PL-2025-12-16"; both must name the same sitting.',
    ],
  ])(
    'rejects vote item %s dated off sitting %s before HTTP, quoting both values',
    async (vote_item_id, sitting_id, message) => {
      const fetcher = installToolHttp(() => envelopeResponse(sitting1217));
      const result = await runToolContract(getPlenaryVotesTool, { sitting_id, vote_item_id });
      expectErrorTwin(
        result,
        'invalid_filter',
        'Retry with sitting_id 2025-12-17, the date in vote_item_id.',
        JsonRpcErrorCode.ValidationError,
      );
      expect(result.structuredContent).toMatchObject({ error: { message } });
      expect(contractText(result)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

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
        `No decision in this sitting publishes a decided-on, part-of or vote-item relation, so a report or vote item cannot select its decisions. Remove ${names} and use label_contains with the report's citation as decision labels write it (a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022), or, when no decision label carries it, with words of the vote item's title from mode vote_items and language set to the title's language. Matching label text does not establish a final vote.`,
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
          "No published decision label matched label_contains within the selected document and vote-item filters. Remove or change label_contains (in decision labels a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022; a label without the report citation can carry words of the vote item's title from mode vote_items instead, matched with language set to the title's language); matching text does not establish a final vote.",
      });
    },
  );
  it('routes a citation no decision label carries to the vote item title words in their language', async () => {
    const fetcher = installToolHttp(() =>
      envelopeResponse([
        {
          id: 'eli/dl/event/MTG-PL-2020-01-29-DEC-112101',
          activity_id: 'MTG-PL-2020-01-29-DEC-112101',
          activity_label: {
            en: 'Agreement on the withdrawal of the United Kingdom 29/01/2020 18:35:28.000',
            fr: 'Accord sur le retrait du Royaume-Uni',
          },
          recorded_in_a_realization_of: 'eli/dl/doc/PV-9-2020-01-29-RCV-ITM-004',
        },
      ]),
    );
    const cited = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2020-01-29',
        label_contains: 'A9-0004/2020',
      }),
    );
    expect(cited).toMatchObject({ decisions: [], totalCount: 0 });
    expect(cited.notice).toBe(
      "No published decision label matched label_contains within the selected document and vote-item filters. Remove or change label_contains (in decision labels a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022; a label without the report citation can carry words of the vote item's title from mode vote_items instead, matched with language set to the title's language); matching text does not establish a final vote.",
    );
    const titled = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        sitting_id: '2020-01-29',
        label_contains: 'retrait du Royaume-Uni',
        language: 'fr',
      }),
    );
    expect(titled).toMatchObject({
      totalCount: 1,
      decisions: [
        {
          decision_id: 'MTG-PL-2020-01-29-DEC-112101',
          label: { value: 'Accord sur le retrait du Royaume-Uni', language: 'fr' },
        },
      ],
    });
    expect(titled).not.toHaveProperty('notice');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
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

const sitting0313 = 'eli/dl/event/MTG-PL-2024-03-13';
const item0313 = (number: number) => `${sitting0313}-VOT-ITM-${number}`;
const decisions0313 = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `${sitting0313}-DEC-${from + index}`);
const plenaryVoteResults = 'def/ep-activities/PLENARY_VOTE_RESULTS';
const published0313 = [941746, 942382, 941852, 941757];
/**
 * Shapes published on 2024-03-13: every vote item embeds its sitting with the complete vote-item
 * list, procedures sit beside it in `inverse_consists_of`, and roll-call requests interleave the
 * items. Relations arrive as arrays, singletons, objects and full URIs; `reverse` reorders each
 * `consists_of` as repeated reads do.
 */
function voteResults0313({
  items = published0313,
  listed = items,
  reverse = false,
}: {
  items?: number[];
  listed?: number[];
  reverse?: boolean;
} = {}) {
  const decisions = (ids: string[]) => (reverse ? ids.toReversed() : ids);
  const sitting = { id: sitting0313, consists_of: listed.map(item0313) };
  const records = new Map<number, Record<string, unknown>>([
    [
      941746,
      {
        id: item0313(941746),
        type: 'Activity',
        activity_id: 'MTG-PL-2024-03-13-VOT-ITM-941746',
        activity_label: {
          fr: 'Orientations pour le budget 2025 – Section III',
          en: 'Guidelines for the 2025 Budget – Section III',
        },
        had_activity_type: plenaryVoteResults,
        based_on_a_realization_of: ['eli/dl/doc/A-9-2024-0068'],
        recorded_in_a_realization_of: ['eli/dl/doc/PV-9-2024-03-13-VOT-ITM-013'],
        consists_of: decisions(decisions0313(166100, 50)),
        inverse_consists_of: [
          sitting,
          { id: 'eli/dl/proc/2023-2220', consists_of: [item0313(941746)] },
        ],
      },
    ],
    [
      942382,
      {
        id: item0313(942382),
        activity_id: 'MTG-PL-2024-03-13-VOT-ITM-942382',
        activity_label: { en: 'Closer ties between the EU and Armenia' },
        had_activity_type: plenaryVoteResults,
        recorded_in_a_realization_of: ['eli/dl/doc/PV-9-2024-03-13-VOT-ITM-022'],
        consists_of: decisions(decisions0313(166200, 17)),
        inverse_consists_of: sitting,
      },
    ],
    [
      941852,
      {
        id: item0313(941852),
        activity_label: { en: 'Reporting requirements in road transport ***I' },
        had_activity_type: plenaryVoteResults,
        based_on_a_realization_of: 'eli/dl/doc/A-9-2024-0033',
        recorded_in_a_realization_of: { id: 'eli/dl/doc/PV-9-2024-03-13-VOT-ITM-005' },
        consists_of: `${sitting0313}-DEC-166300`,
        inverse_consists_of: [sitting, 'https://data.europarl.europa.eu/eli/dl/proc/2023-0361'],
      },
    ],
    [
      941757,
      {
        id: item0313(941757),
        activity_id: 'MTG-PL-2024-03-13-VOT-ITM-941757',
        activity_label: {
          en: 'Artificial Intelligence Act ***I',
          fr: 'Législation sur l’intelligence artificielle ***I',
        },
        had_activity_type: plenaryVoteResults,
        based_on_a_realization_of: ['eli/dl/doc/A-9-2023-0188'],
        recorded_in_a_realization_of: ['eli/dl/doc/PV-9-2024-03-13-VOT-ITM-002'],
        consists_of: [`${sitting0313}-DEC-166051`],
        inverse_consists_of: [
          sitting,
          { id: 'eli/dl/proc/2021-0106', consists_of: [item0313(941757)] },
        ],
      },
    ],
  ]);
  const rollCall = {
    id: `${item0313(941757)}-RCV-1`,
    activity_id: 'MTG-PL-2024-03-13-VOT-ITM-941757-RCV-1',
    activity_label: { en: 'Artificial intelligence: amendments 16, 17, 18' },
    activity_order: '1.0',
    had_activity_type: 'def/ep-activities/REQUEST_VOTE_ROLLCALL',
  };
  const [first, ...rest] = items.flatMap((item) => records.get(item) ?? []);
  return [...(first ? [first] : []), rollCall, ...rest];
}
const source = (id: string) => `https://data.europarl.europa.eu/eli/dl/event/${id}`;
const budgetItem = {
  vote_item_id: 'MTG-PL-2024-03-13-VOT-ITM-941746',
  label: { value: 'Guidelines for the 2025 Budget – Section III', language: 'en' },
  document_ids: ['A-9-2024-0068'],
  procedure_ids: ['2023-2220'],
  recording_document_ids: ['PV-9-2024-03-13-VOT-ITM-013'],
  decision_count: 50,
  source_url: source('MTG-PL-2024-03-13-VOT-ITM-941746'),
};
const armeniaItem = {
  vote_item_id: 'MTG-PL-2024-03-13-VOT-ITM-942382',
  label: { value: 'Closer ties between the EU and Armenia', language: 'en' },
  document_ids: [],
  procedure_ids: [],
  recording_document_ids: ['PV-9-2024-03-13-VOT-ITM-022'],
  decision_count: 17,
  source_url: source('MTG-PL-2024-03-13-VOT-ITM-942382'),
};
const transportItem = {
  vote_item_id: 'MTG-PL-2024-03-13-VOT-ITM-941852',
  label: { value: 'Reporting requirements in road transport ***I', language: 'en' },
  document_ids: ['A-9-2024-0033'],
  procedure_ids: ['2023-0361'],
  recording_document_ids: ['PV-9-2024-03-13-VOT-ITM-005'],
  decision_count: 1,
  source_url: source('MTG-PL-2024-03-13-VOT-ITM-941852'),
};
const aiActItem = {
  vote_item_id: 'MTG-PL-2024-03-13-VOT-ITM-941757',
  label: { value: 'Artificial Intelligence Act ***I', language: 'en' },
  document_ids: ['A-9-2023-0188'],
  procedure_ids: ['2021-0106'],
  recording_document_ids: ['PV-9-2024-03-13-VOT-ITM-002'],
  decision_count: 1,
  source_url: source('MTG-PL-2024-03-13-VOT-ITM-941757'),
};
const voteItems0313 = { mode: 'vote_items', sitting_id: '2024-03-13' } as const;
const noVoteItems =
  'No vote items were published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.';
/** Shapes published on 2019-10-24: French-only titles, reports and procedures, no decision links. */
const voteResults1024 = [834859, 834886].map((number, index) => ({
  id: `eli/dl/event/MTG-PL-2019-10-24-VOT-ITM-${number}`,
  activity_date: '2019-10-24',
  activity_id: `MTG-PL-2019-10-24-VOT-ITM-${number}`,
  activity_label: {
    fr:
      index === 0
        ? 'Situation des personnes LGBTI en Ouganda'
        : 'Aide financière aux États membres',
  },
  based_on_a_realization_of:
    index === 0
      ? ['eli/dl/doc/B-9-2019-0142', 'eli/dl/doc/B-9-2019-0135']
      : ['eli/dl/doc/A-9-2019-0020'],
  had_activity_type: plenaryVoteResults,
  recorded_in_a_realization_of: [`eli/dl/doc/PV-9-2019-10-24-VOT-ITM-00${index + 1}`],
  inverse_consists_of: [
    {
      id: 'eli/dl/event/MTG-PL-2019-10-24',
      consists_of: [
        'eli/dl/event/MTG-PL-2019-10-24-VOT-ITM-834859',
        'eli/dl/event/MTG-PL-2019-10-24-VOT-ITM-834886',
      ],
    },
    {
      id: index === 0 ? 'eli/dl/proc/2019-2879' : 'eli/dl/proc/2019-0183',
      consists_of: [`eli/dl/event/MTG-PL-2019-10-24-VOT-ITM-${number}`],
    },
  ],
}));

describe('euparl_get_plenary_votes vote items', () => {
  it('lists published vote items in order from one unpaged vote-results read', async () => {
    const fetcher = installToolHttp(() => envelopeResponse(voteResults0313()));
    const wire = await runToolContract(getPlenaryVotesTool, {
      ...voteItems0313,
      language: 'EN',
      limit: 100,
    });
    const data = expectSuccessTwin(wire);
    expect(data.vote_items).toEqual([budgetItem, armeniaItem, transportItem, aiActItem]);
    expect(data).toMatchObject({
      mode: 'vote_items',
      sitting_id: 'MTG-PL-2024-03-13',
      totalCount: 4,
      page: { offset: 0, limit: 100, returned: 4, has_more: false },
    });
    expect(data.appliedFilters).toEqual({
      mode: 'vote_items',
      sitting_id: 'MTG-PL-2024-03-13',
      language: 'en',
    });
    for (const absent of ['notice', 'decisions', 'decision', 'voters', 'sittings'])
      expect(data).not.toHaveProperty(absent);
    expect(contractText(wire)).toContain('result.vote_items[3].decision_count: 1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2/meetings/MTG-PL-2024-03-13/vote-results');
    expect(Object.fromEntries(url.searchParams)).toEqual({ format: 'application/ld+json' });
  });

  it.each([
    ['artificial intelligence', [aiActItem]],
    ['  ARTIFICIAL   Intelligence ACT ', [aiActItem]],
    ['2025 budget - section iii', [budgetItem]],
    ['GUIDELINES FOR THE 2025 BUDGET — SECTION', [budgetItem]],
    ['***i', [transportItem, aiActItem]],
  ] as const)(
    'selects vote item titles matching %j with the decisions-mode label folding',
    async (label_contains, expected) => {
      installToolHttp(() => envelopeResponse(voteResults0313()));
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...voteItems0313, label_contains }),
      );
      expect(data.vote_items).toEqual(expected);
      expect(data.totalCount).toBe(expected.length);
      expect(data.appliedFilters).toMatchObject({
        label_contains: label_contains.trim().toLowerCase().replace(/\s+/g, ' ').replace('—', '-'),
      });
    },
  );

  it.each([
    ['en', []],
    [
      'fr',
      [
        {
          ...aiActItem,
          label: { value: 'Législation sur l’intelligence artificielle ***I', language: 'fr' },
        },
      ],
    ],
  ] as const)(
    'matches label_contains against the %s title only, never another published language',
    async (language, expected) => {
      installToolHttp(() => envelopeResponse(voteResults0313()));
      const data = expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...voteItems0313,
          language,
          label_contains: 'intelligence artificielle',
        }),
      );
      expect(data.vote_items).toEqual(expected);
      expect(data.totalCount).toBe(expected.length);
    },
  );

  it('explains a vote-item title filter that matched nothing', async () => {
    installToolHttp(() => envelopeResponse(voteResults0313()));
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...voteItems0313,
        label_contains: 'A9-0188/2023',
      }),
    );
    expect(data).toMatchObject({ vote_items: [], totalCount: 0 });
    expect(data.notice).toBe(
      'No published vote item label matched label_contains. Vote item labels are titles; decision labels carry report citations and amendment numbers, so try mode decisions with the same label_contains or the report citation as decision labels write it (a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022), or remove label_contains to list every vote item.',
    );
  });

  it('omits decision_count on vote items that publish no decision links and routes to decision labels', async () => {
    installToolHttp(() => envelopeResponse(voteResults1024));
    const wire = await runToolContract(getPlenaryVotesTool, {
      mode: 'vote_items',
      sitting_id: 'MTG-PL-2019-10-24',
      language: 'en',
    });
    const data = expectSuccessTwin(wire);
    expect(data.vote_items).toEqual([
      {
        vote_item_id: 'MTG-PL-2019-10-24-VOT-ITM-834859',
        label: { value: 'Situation des personnes LGBTI en Ouganda', language: 'fr' },
        document_ids: ['B-9-2019-0142', 'B-9-2019-0135'],
        procedure_ids: ['2019-2879'],
        recording_document_ids: ['PV-9-2019-10-24-VOT-ITM-001'],
        source_url: source('MTG-PL-2019-10-24-VOT-ITM-834859'),
      },
      {
        vote_item_id: 'MTG-PL-2019-10-24-VOT-ITM-834886',
        label: { value: 'Aide financière aux États membres', language: 'fr' },
        document_ids: ['A-9-2019-0020'],
        procedure_ids: ['2019-0183'],
        recording_document_ids: ['PV-9-2019-10-24-VOT-ITM-002'],
        source_url: source('MTG-PL-2019-10-24-VOT-ITM-834886'),
      },
    ]);
    expect(contractText(wire)).not.toContain('].decision_count:');
    expect(data.notice).toBe(
      "Requested language en unavailable; returned published fr text. 2 of 2 vote items publish no decision links: decision_count is omitted rather than 0, and vote_item_id selects none of their decisions. Call euparl_get_plenary_votes with mode decisions, the same sitting_id and label_contains set to the report citation as decision labels write it (a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022), or, when no decision label carries it, to words of the vote item's title with language set to the title's language; matching label text does not establish a final vote.",
    );
  });

  /** One French-only vote item without decision links, as sittings through 2023 publish them. */
  const unlinkedVoteItem = (date: string) => ({
    id: `eli/dl/event/MTG-PL-${date}-VOT-ITM-1`,
    activity_id: `MTG-PL-${date}-VOT-ITM-1`,
    activity_label: { fr: 'Proposition de résolution' },
    based_on_a_realization_of: ['eli/dl/doc/B-8-2018-0001'],
    had_activity_type: plenaryVoteResults,
    recorded_in_a_realization_of: [`eli/dl/doc/PV-8-${date}-VOT-ITM-001`],
    inverse_consists_of: [
      { id: `eli/dl/event/MTG-PL-${date}`, consists_of: [`eli/dl/event/MTG-PL-${date}-VOT-ITM-1`] },
    ],
  });

  it('says no decision records are published for unlinked vote items before the first decision sitting', async () => {
    installToolHttp(() => envelopeResponse([unlinkedVoteItem('2018-12-13')]));
    const wire = await runToolContract(getPlenaryVotesTool, {
      mode: 'vote_items',
      sitting_id: '2018-12-13',
    });
    const data = expectSuccessTwin(wire);
    expect(data.vote_items).toEqual([
      {
        vote_item_id: 'MTG-PL-2018-12-13-VOT-ITM-1',
        label: { value: 'Proposition de résolution', language: 'fr' },
        document_ids: ['B-8-2018-0001'],
        procedure_ids: [],
        recording_document_ids: ['PV-8-2018-12-13-VOT-ITM-001'],
        source_url: source('MTG-PL-2018-12-13-VOT-ITM-1'),
      },
    ]);
    const notice =
      "Requested language en unavailable; returned published fr text. 1 of 1 vote items publish no decision links: decision_count is omitted rather than 0. Parliament publishes no decision records for sittings before 2019-01-14, so decisions mode has none for this sitting; each vote item's recording_document_ids names the minutes item that records it, readable with euparl_search_documents mode get.";
    expect(data.notice).toBe(notice);
    expect(contractText(wire)).toContain(
      'Parliament publishes no decision records for sittings before 2019-01-14',
    );
    expect(contractText(wire)).not.toContain('mode decisions, the same sitting_id');
  });

  it('routes unlinked vote items from the first decision sitting on to decision labels', async () => {
    installToolHttp(() => envelopeResponse([unlinkedVoteItem('2019-01-14')]));
    const wire = await runToolContract(getPlenaryVotesTool, {
      mode: 'vote_items',
      sitting_id: '2019-01-14',
    });
    const data = expectSuccessTwin(wire);
    expect(data).toMatchObject({
      totalCount: 1,
      vote_items: [{ vote_item_id: 'MTG-PL-2019-01-14-VOT-ITM-1' }],
    });
    const notice =
      "Requested language en unavailable; returned published fr text. 1 of 1 vote items publish no decision links: decision_count is omitted rather than 0, and vote_item_id selects none of their decisions. Call euparl_get_plenary_votes with mode decisions, the same sitting_id and label_contains set to the report citation as decision labels write it (a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022), or, when no decision label carries it, to words of the vote item's title with language set to the title's language; matching label text does not establish a final vote.";
    expect(data.notice).toBe(notice);
    expect(contractText(wire)).toContain('Call euparl_get_plenary_votes with mode decisions');
  });

  it('states how a document_ids entry is cited wherever the definition routes to decision labels', () => {
    const rule =
      'a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022';
    expect(getPlenaryVotesTool.description).toContain(
      `without altering published text or establishing a final vote; in a decision label ${rule}.`,
    );
    const labelContains = z
      .object({
        properties: z.object({ label_contains: z.object({ description: z.string() }) }),
      })
      .parse(z.toJSONSchema(getPlenaryVotesTool.input, { io: 'input' })).properties.label_contains;
    expect(labelContains.description).toContain(
      `combine with document_id and vote_item_id; in a decision label ${rule}. Vote item labels are titles`,
    );
  });

  it.each([
    [204, []],
    [404, []],
    [
      200,
      [{ id: 'eli/dl/event/X-RCV-1', had_activity_type: 'def/ep-activities/REQUEST_VOTE_SPLIT' }],
    ],
  ] as const)('returns an empty vote-item page for HTTP %i with %j', async (status, records) => {
    installToolHttp(() =>
      status === 200 ? envelopeResponse([...records]) : new Response(null, { status }),
    );
    const data = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, {
        mode: 'vote_items',
        sitting_id: '2024-03-16',
        label_contains: 'budget',
      }),
    );
    expect(data).toMatchObject({
      vote_items: [],
      totalCount: 0,
      page: { returned: 0, has_more: false },
      notice: noVoteItems,
    });
  });

  it.each([
    [
      'one vote item its sitting lists',
      voteResults0313({ listed: [...published0313, 941999] }),
      4,
      5,
    ],
    [
      'the 50-row default page of a 54-item sitting',
      Array.from({ length: 50 }, (_, index) => ({
        id: item0313(950000 + index),
        had_activity_type: plenaryVoteResults,
        consists_of: [`${sitting0313}-DEC-${170000 + index}`],
        inverse_consists_of: [
          {
            id: sitting0313,
            consists_of: Array.from({ length: 54 }, (_, item) => item0313(950000 + item)),
          },
        ],
      })),
      50,
      54,
    ],
  ] as const)(
    'fails upstream_paging_stalled when the read omits %s',
    async (_, records, got, listed) => {
      installToolHttp(() => envelopeResponse([...records]));
      const result = await runToolContract(getPlenaryVotesTool, voteItems0313);
      expectErrorTwin(
        result,
        'upstream_paging_stalled',
        stalledHint,
        JsonRpcErrorCode.ServiceUnavailable,
      );
      expect(contractText(result)).toContain(
        `Parliament returned ${got} of the ${listed} vote items this sitting lists.`,
      );
    },
  );

  it('pages with a snapshot that ignores consists_of order and detects item and scope drift', async () => {
    let records = voteResults0313();
    const fetcher = installToolHttp(() => envelopeResponse(records));
    const first = expectSuccessTwin(
      await runToolContract(getPlenaryVotesTool, { ...voteItems0313, limit: 2 }),
    );
    expect(first).toMatchObject({
      vote_items: [budgetItem, armeniaItem],
      totalCount: 4,
      page: { returned: 2, has_more: true, next_offset: 2 },
      notice: 'Continue with offset 2 and the returned snapshot.',
    });
    const snapshot = snapshotOf(first);
    records = voteResults0313({ reverse: true });
    expect(
      snapshotOf(
        expectSuccessTwin(
          await runToolContract(getPlenaryVotesTool, { ...voteItems0313, limit: 2 }),
        ),
      ),
    ).toBe(snapshot);
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...voteItems0313,
          limit: 2,
          offset: 2,
          snapshot,
        }),
      ),
    ).toMatchObject({
      vote_items: [transportItem, aiActItem],
      page: { returned: 2, has_more: false, snapshot },
    });
    expect(
      expectSuccessTwin(
        await runToolContract(getPlenaryVotesTool, { ...voteItems0313, offset: 10, snapshot }),
      ),
    ).toMatchObject({ vote_items: [], totalCount: 4, page: { returned: 0, has_more: false } });
    for (const changed of [{ label_contains: 'act' }, { language: 'fr' }])
      expectErrorTwin(
        await runToolContract(getPlenaryVotesTool, {
          ...voteItems0313,
          ...changed,
          limit: 2,
          offset: 2,
          snapshot,
        }),
        'snapshot_changed',
        snapshotHint,
        JsonRpcErrorCode.Conflict,
      );
    records = voteResults0313({ items: [941746, 941852, 941757] });
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, {
        ...voteItems0313,
        limit: 2,
        offset: 2,
        snapshot,
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it.each([
    [{}, 'Supply sitting_id for the selected mode.'],
    [{ ...voteItems0313, year: 2024 }, 'Remove year, or select a mode that accepts year.'],
    [
      { ...voteItems0313, decision_id: 'MTG-PL-2024-03-13-DEC-166051' },
      'Remove decision_id, or select a mode that accepts decision_id.',
    ],
    [
      { ...voteItems0313, position: 'favor' },
      'Remove position, or select a mode that accepts position.',
    ],
    [
      { ...voteItems0313, document_id: 'A-9-2023-0188' },
      'Remove document_id, or select a mode that accepts document_id.',
    ],
    [
      { ...voteItems0313, vote_item_id: 'MTG-PL-2024-03-13-VOT-ITM-941757' },
      'Remove vote_item_id, or select a mode that accepts vote_item_id.',
    ],
    [
      { ...voteItems0313, mep_id: '197403' },
      'Remove mep_id, or use mode decisions or decision for member positions.',
    ],
    [
      { ...voteItems0313, resolve_names: true },
      'Remove resolve_names and roster_term, or use mode voters with decision_id and position.',
    ],
    [
      { ...voteItems0313, roster_term: 9 },
      'Remove resolve_names and roster_term, or use mode voters with decision_id and position.',
    ],
    [
      { ...voteItems0313, offset: 1 },
      'Pass the previous page.snapshot with the same filters, or restart at offset 0 without snapshot.',
    ],
  ] as const)('rejects vote_items fields %j before HTTP', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse(voteResults0313()));
    expectErrorTwin(
      await runToolContract(getPlenaryVotesTool, { mode: 'vote_items', ...input }),
      'invalid_mode_fields',
      hint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
