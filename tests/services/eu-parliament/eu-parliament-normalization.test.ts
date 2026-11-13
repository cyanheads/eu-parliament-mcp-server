/** @fileoverview Domain normalization, nested links, and stable local continuation. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  canonicalId,
  decisionVoters,
  documentInputIds,
  documentLinks,
  fragmentText,
  localized,
  localPage,
  normalizeAdoptedTextRow,
  normalizeDecision,
  normalizeDecisionSummary,
  normalizeDocument,
  normalizeName,
  normalizeProcedure,
  normalizeQuestion,
  normalizeSpeech,
  originalLanguages,
  pageWindow,
  procedureIds,
  upstreamPage,
} from '../../../src/services/eu-parliament/eu-parliament-normalization.js';
import {
  adoptedTextRowSchema,
  decisionSchema,
  documentSchema,
  procedureSchema,
  questionSchema,
  speechSchema,
} from '../../../src/services/eu-parliament/eu-parliament-schemas.js';
import { expectLinearCpu } from '../../helpers/cpu-growth.js';
import {
  decisionRecord,
  documentRecord,
  questionRecord,
  speechFragments,
} from '../../helpers/eu-parliament-fixtures.js';

describe('Parliament normalization', () => {
  it.each(['5144', 'org/5144', 'https://data.europarl.europa.eu/org/5144', ' 5144 '])(
    'canonicalizes supported organization identity %s',
    (id) => {
      expect(canonicalId(id, 'organization')).toBe('5144');
    },
  );
  it.each([
    ['org/ep-10', 'ep-10'],
    ['org/IMCO', 'IMCO'],
    ['org/S-D', 'S-D'],
    ['CJ40', 'CJ40'],
    ['org/EU_PARLIAMENT', 'EU_PARLIAMENT'],
    ['https://data.europarl.europa.eu/org/GUE-NGL', 'GUE-NGL'],
    [' DLAT ', 'DLAT'],
    ['imco', 'imco'],
    ['org/EP-9', 'EP-9'],
  ])('keeps organization code %s as %s without changing its case', (id, code) => {
    expect(canonicalId(id, 'organization')).toBe(code);
  });
  it.each([
    'https://evil.example/org/5144',
    '5144?x=y',
    'org/../5144',
    'https://data.europarl.europa.eu.evil/org/5144',
    '%35',
    '5144\n1',
    'S&D',
    'GUE/NGL',
    'The Left',
    'org/',
    '-IMCO',
    'org/IMCO/',
  ])('rejects unsupported organization identity %s', (id) => {
    expect(() => canonicalId(id, 'organization')).toThrow();
  });
  it('preserves sparse decision identity without inferring tallies or text', () => {
    const result = normalizeDecision(decisionSchema.parse({ id: 'eli/dl/event/DEC-1' }), 'en', []);
    expect(result).toEqual({
      decision_id: 'DEC-1',
      voter_counts: [],
      document_ids: [],
      recording_document_ids: [],
      partial_document_ids: [],
      vote_item_ids: [],
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/DEC-1',
    });
  });
  it('keeps part-of and vote-item relations apart from decided-on documents, in published order', () => {
    const relations = {
      decided_on_a_part_of_a_realization_of: 'eli/dl/doc/A-10-2025-0195-AM-27',
      inverse_consists_of: [
        'eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978310',
        { id: 'https://data.europarl.europa.eu/eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-978299' },
      ],
    };
    const raw = decisionSchema.parse({ ...decisionRecord, ...relations });
    const expected = {
      document_ids: ['A-10-2025-900001'],
      recording_document_ids: ['PV-10-2025-01-15-RCV-ITM-001'],
      partial_document_ids: ['A-10-2025-0195-AM-27'],
      vote_item_ids: ['MTG-PL-2025-12-17-VOT-ITM-978310', 'MTG-PL-2025-12-17-VOT-ITM-978299'],
    };
    expect(normalizeDecisionSummary(raw)).toMatchObject(expected);
    expect(normalizeDecision(raw, 'en', [])).toMatchObject(expected);
    expect(
      normalizeDecisionSummary(
        decisionSchema.parse({
          id: decisionRecord.id,
          decided_on_a_part_of_a_realization_of: ['eli/dl/doc/B-1', { id: 'eli/dl/doc/A-2' }],
          inverse_consists_of: 'eli/dl/event/MTG-PL-2025-12-17-VOT-ITM-1',
        }),
      ),
    ).toMatchObject({
      document_ids: [],
      partial_document_ids: ['B-1', 'A-2'],
      vote_item_ids: ['MTG-PL-2025-12-17-VOT-ITM-1'],
    });
  });

  it('normalizes a record dated only by the typed literal to the same date as a plain activity_date record', () => {
    const dated = (record: Record<string, unknown>, plain: boolean) => ({
      ...record,
      ...(plain
        ? { activity_date: '2019-07-18' }
        : {
            'eli-dl:activity_date': { '@value': '2019-07-18T00:00:00+02:00', type: 'xsd:dateTime' },
          }),
    });
    const [plainDecision, typedDecision] = [true, false].map((plain) =>
      normalizeDecisionSummary(decisionSchema.parse(dated({ id: 'eli/dl/event/DEC-1' }, plain))),
    );
    expect(typedDecision).toEqual(plainDecision);
    expect(typedDecision).toMatchObject({ date: '2019-07-18' });
    const [plainSpeech, typedSpeech] = [true, false].map((plain) =>
      normalizeSpeech(speechSchema.parse(dated({ id: 'eli/dl/event/S-1' }, plain)), 'en', []),
    );
    expect(typedSpeech).toEqual(plainSpeech);
    expect(typedSpeech).toMatchObject({ date: '2019-07-18' });
    const [plainProcedure, typedProcedure] = [true, false].map((plain) =>
      normalizeProcedure(
        procedureSchema.parse({
          id: 'eli/dl/proc/2019-0001',
          consists_of: [dated({ id: 'eli/dl/event/EV-1' }, plain)],
          had_participation: dated({ id: 'eli/dl/participation/P-1' }, plain),
        }),
        'en',
        [],
      ),
    );
    expect(typedProcedure).toEqual(plainProcedure);
    expect(typedProcedure).toMatchObject({
      events: [{ id: 'EV-1', date: '2019-07-18' }],
      participants: [{ id: 'eli/dl/participation/P-1', date: '2019-07-18' }],
    });
  });

  it('keeps sparse documents free of inferred procedure links, titles and files', () => {
    const document = normalizeDocument(documentSchema.parse({ id: 'eli/dl/doc/TA-1' }), 'en', []);
    expect(document).toMatchObject({
      document_id: 'TA-1',
      procedure_ids: [],
      parent_document_ids: [],
      links: [],
    });
    expect(document).not.toHaveProperty('title');
    expect(document).not.toHaveProperty('public_register_ref');
  });
  it('takes only procedure entries of a relation, canonical and in published order', () => {
    expect(
      procedureIds([
        'eli/dl/event/MTG-PL-2024-03-13-PVCRE-ITM-8-2',
        { id: 'eli/dl/proc/2021-0106' },
        'https://data.europarl.europa.eu/eli/dl/proc/2016-0224B',
        'org/IMCO',
        'eli/dl/doc/A-9-2023-0188',
      ]),
    ).toEqual(['2021-0106', '2016-0224B']);
    expect(procedureIds('eli/dl/proc/2024-2716')).toEqual(['2024-2716']);
    expect(procedureIds(undefined)).toEqual([]);
  });
  it('lists family procedure relations after generic ones without repeating any', () => {
    const document = normalizeDocument(
      documentSchema.parse({
        id: 'eli/dl/doc/TA-1',
        refers_to: ['eli/dl/proc/2020-0001', 'eli/dl/proc/2020-0001'],
        is_about: { id: 'https://data.europarl.europa.eu/eli/dl/proc/2020-0002' },
      }),
      'en',
      [],
      ['2020-0003', '2020-0001', '2019-0005', '2020-0003'],
    );
    expect(document.procedure_ids).toEqual(['2020-0001', '2020-0002', '2020-0003', '2019-0005']);
  });
  it('canonicalizes document relation shapes in published order without implying procedure links', () => {
    const document = normalizeDocument(
      documentSchema.parse({
        ...documentRecord,
        adopts: ['A-1', { id: 'eli/dl/doc/A-2' }, 'https://data.europarl.europa.eu/eli/dl/doc/A-3'],
        based_on: { id: 'RULES-9-2023-05-08-ITM-A58' },
        notation_publicRegister: 'P9_A(2023)0188',
      }),
      'fr',
      [],
    );
    expect(document).toMatchObject({
      adopted_document_ids: ['A-1', 'A-2', 'A-3'],
      based_on_document_ids: ['RULES-9-2023-05-08-ITM-A58'],
      public_register_ref: 'P9_A(2023)0188',
      procedure_ids: [],
      title: { value: 'Avis exemple', language: 'fr' },
    });
  });
  it.each([
    '2025/1234(COD)',
    '2025-1234',
    'eli/dl/proc/2025-1234',
    'https://data.europarl.europa.eu/eli/dl/proc/2025-1234',
  ])('canonicalizes procedure alias %s', (input) => {
    expect(canonicalId(input, 'procedure')).toBe('2025-1234');
  });
  it.each(['https://evil.example/person/1', 'person/../meps', '1?text=x', '%2e%2e'])(
    'rejects noncanonical person identifier %s',
    (input) => {
      expect(() => canonicalId(input, 'person')).toThrow();
    },
  );
  /** The thrown error, for message, code and data assertions. */
  function thrown(run: () => unknown): { code?: number; message: string; data?: unknown } {
    try {
      run();
    } catch (caught) {
      return caught as { code?: number; message: string; data?: unknown };
    }
    throw new Error('expected a rejection');
  }
  it.each([
    [
      'person',
      'abc',
      'person_id',
      'person_id "abc" is not a person identifier. Accepted forms: a decimal person ID (124867), person/124867, or https://data.europarl.europa.eu/person/124867.',
    ],
    [
      'organization',
      's&d',
      'organization_ids entry 3',
      'organization_ids entry 3 "s&d" is not an organization identifier. Accepted forms: a decimal ID (5144) or a case-sensitive code of letters, digits, hyphens and underscores (IMCO, S-D, ep-9, EU_PARLIAMENT), bare, after org/, or in the exact https://data.europarl.europa.eu/org/ URI; labels such as S&D are not identifiers.',
    ],
    [
      'procedure',
      ' 2021-106 ',
      'related_process_id',
      'related_process_id " 2021-106 " is not a procedure identifier. Accepted forms: YYYY-NNNN or YYYY/NNNN with an optional letter suffix and (TYPE), such as 2021-0106 or 2021/0106(COD), bare, after eli/dl/proc/, or in the exact https://data.europarl.europa.eu/eli/dl/proc/ URI.',
    ],
    [
      'activity',
      'speech 1',
      'speech_id',
      'speech_id "speech 1" is not an activity identifier. Accepted forms: a canonical identifier of letters, digits, hyphens and underscores, bare, after eli/dl/event/, or in the exact https://data.europarl.europa.eu/eli/dl/event/ URI.',
    ],
  ] as const)(
    'rejects caller %s input %j naming the parameter, the value and the accepted forms',
    (noun, value, parameter, message) => {
      const hint = `Call the discovery tool for ${parameter}.`;
      const error = thrown(() => canonicalId(value, noun, { parameter, hint }));
      expect(error.message).toBe(message);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({ reason: 'invalid_filter', recovery: { hint } });
    },
  );
  it.each([
    ['person', 'person/x'],
    ['document', 'eli/dl/doc/bad id'],
    ['procedure', 'eli/dl/proc/2024-27'],
    ['activity', 'eli/dl/event/'],
    ['organization', 'org/'],
  ] as const)(
    'classifies a malformed %s identifier %j from Parliament as a serialization failure',
    (noun, value) => {
      const error = thrown(() => canonicalId(value, noun));
      expect(error.message).toBe(
        `Parliament returned a record with a malformed ${noun} identifier ${JSON.stringify(value)}.`,
      );
      expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
      expect(error.data).toEqual({ retryable: false });
    },
  );
  it('classifies a malformed relation procedure entry from Parliament as a serialization failure', () => {
    const error = thrown(() => procedureIds(['eli/dl/proc/2021-0106', 'eli/dl/proc/2024-27']));
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.message).toBe(
      'Parliament returned a record with a malformed procedure identifier "eli/dl/proc/2024-27".',
    );
  });
  /** Live shape of MTG-PL-2019-01-14-DEC-100087 (2026-11-13): voter arrays hold only "person/". */
  const placeholderDecision = decisionSchema.parse({
    id: 'eli/dl/event/MTG-PL-2019-01-14-DEC-100087',
    activity_id: 'MTG-PL-2019-01-14-DEC-100087',
    activity_date: '2019-01-14',
    had_voter_abstention: ['person/'],
    had_voter_against: ['person/'],
    had_voter_favor: ['person/'],
    number_of_votes_abstention: 18,
    number_of_votes_against: 153,
    number_of_votes_favor: 143,
    recorded_in_a_realization_of: ['eli/dl/doc/PV-8-2019-01-14-RCV-ITM-001'],
  });
  const placeholderNotice =
    'Parliament publishes voter entries that name no person (person/ with no identifier) on some decisions; they are left out of voters, voter_counts and mep_position, and favor, against and abstention keep the published tallies.';
  it('leaves voter entries naming no person out of every voter list, keeping the published tallies', () => {
    expect(decisionVoters(placeholderDecision, 'favor')).toEqual([]);
    expect(decisionVoters(placeholderDecision, 'against')).toEqual([]);
    expect(decisionVoters(placeholderDecision, 'abstention')).toEqual([]);
    expect(decisionVoters(placeholderDecision, 'intended_favor')).toBeUndefined();
    expect(
      decisionVoters(
        decisionSchema.parse({
          id: placeholderDecision.id,
          had_voter_favor: [
            'person/',
            'https://data.europarl.europa.eu/person/',
            'person/124867',
            'https://data.europarl.europa.eu/person/197394',
          ],
        }),
        'favor',
      ),
    ).toEqual(['124867', '197394']);
    const notices: string[] = [];
    expect(normalizeDecisionSummary(placeholderDecision, 'en', notices, '124867')).toMatchObject({
      decision_id: 'MTG-PL-2019-01-14-DEC-100087',
      favor: 143,
      against: 153,
      abstention: 18,
      voter_counts: [
        { position: 'favor', count: 0 },
        { position: 'against', count: 0 },
        { position: 'abstention', count: 0 },
      ],
      mep_position: {
        recorded: { positions: [], unavailable_positions: [], availability: 'published' },
      },
    });
    expect(notices).toEqual([placeholderNotice]);
    const clean: string[] = [];
    normalizeDecisionSummary(decisionSchema.parse(decisionRecord), 'en', clean);
    expect(clean).toEqual([]);
  });
  it('selects source language deterministically and reports every fallback', () => {
    const notices: string[] = [];
    expect(localized({ fr: 'Français', en: 'English' }, 'fr', notices)).toEqual({
      value: 'Français',
      language: 'fr',
    });
    expect(localized({ fr: 'Français', en: 'English' }, 'pl', notices)).toEqual({
      value: 'English',
      language: 'en',
    });
    expect(localized({ fr: 'Français', de: 'Deutsch' }, 'pl', notices)).toEqual({
      value: 'Deutsch',
      language: 'de',
    });
    expect(notices).toHaveLength(2);
    expect(localized(undefined, 'en', notices)).toBeUndefined();
  });
  it('preserves every selected-language nested file and falls back independently', () => {
    const notices: string[] = [];
    const raw = documentSchema.parse(documentRecord);
    expect(documentLinks(raw, 'fr', notices)).toEqual([
      {
        url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.pdf',
        language: 'fr',
        media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
      },
      {
        url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.html',
        language: 'fr',
        media_type: 'https://www.iana.org/assignments/media-types/text/html',
      },
    ]);
    expect(documentLinks(raw, 'pl', notices)).toEqual([
      {
        url: 'https://data.europarl.europa.eu/distribution/example/opinion_en.pdf',
        language: 'en',
      },
    ]);
    expect(notices).toHaveLength(1);
    const result = normalizeDocument(raw, 'fr', []);
    expect(result.title).toEqual({ value: 'Avis exemple', language: 'fr' });
    expect(result).not.toHaveProperty('text');
  });
  it('retains nested answer metadata and all selected-language answer links', () => {
    const result = normalizeQuestion(questionSchema.parse(questionRecord), 'fr', []);
    expect(result.answers).toEqual([
      {
        document_id: 'E-10-2025-900001-ASW',
        date: '2025-02-15',
        links: [
          {
            url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.pdf',
            language: 'fr',
            media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
          },
          {
            url: 'https://data.europarl.europa.eu/distribution/example/opinion_fr.html',
            language: 'fr',
            media_type: 'https://www.iana.org/assignments/media-types/text/html',
          },
        ],
      },
    ]);
  });
  it('collects procedure documents beyond the first event and deduplicates shared relations', () => {
    const result = normalizeProcedure(
      procedureSchema.parse({
        id: 'eli/dl/proc/2025-1234',
        consists_of: [
          {
            id: 'eli/dl/event/EXAMPLE-1',
            decided_on_a_realization_of: ['eli/dl/doc/A-10-2025-900001'],
          },
          {
            id: 'eli/dl/event/EXAMPLE-2',
            based_on_a_realization_of: ['eli/dl/doc/A-10-2025-900001'],
            recorded_in_a_realization_of: ['eli/dl/doc/PV-10-2025-01-15'],
          },
        ],
      }),
      'en',
      [],
    );
    expect(result.documents.map((item) => item.document_id)).toEqual([
      'A-10-2025-900001',
      'PV-10-2025-01-15',
    ]);
    expect(result.events[1]?.document_ids).toEqual(['A-10-2025-900001', 'PV-10-2025-01-15']);
  });
  it('orders procedure sections and nested identifier arrays identically for every upstream order', () => {
    const reorder = <T>(items: T[], reverse: boolean) => (reverse ? items.toReversed() : items);
    const normalize = (reverse: boolean) =>
      normalizeProcedure(
        procedureSchema.parse({
          id: 'eli/dl/proc/2025-1234',
          created_a_realization_of: reorder(['eli/dl/doc/DOC-9', 'eli/dl/doc/DOC-0'], reverse),
          consists_of: reorder(
            [
              { id: 'eli/dl/event/EV-UNDATED-B' },
              {
                id: 'eli/dl/event/EV-LATE',
                activity_date: '2025-03-01',
                decided_on_a_realization_of: ['eli/dl/doc/DOC-2'],
                based_on_a_realization_of: reorder(
                  ['eli/dl/doc/DOC-3', 'eli/dl/doc/DOC-2', 'eli/dl/doc/DOC-1'],
                  reverse,
                ),
                was_scheduled_in: reorder(['eli/dl/event/MTG-2', 'eli/dl/event/MTG-1'], reverse),
              },
              { id: 'eli/dl/event/EV-UNDATED-A' },
              { id: 'eli/dl/event/EV-EARLY-B', activity_date: '2024-12-01' },
              { id: 'eli/dl/event/EV-EARLY-A', activity_date: '2024-12-01' },
            ],
            reverse,
          ),
          had_participation: reorder(
            [
              {
                id: 'eli/dl/participation/P-TIE',
                activity_date: '2024-05-01',
                participation_role: 'def/ep-roles/B',
              },
              {
                id: 'eli/dl/participation/P-UNDATED',
                had_participant_person: reorder(['person/3', 'person/1', 'person/2'], reverse),
                had_participant_organization: reorder(['org/B', 'org/A'], reverse),
              },
              {
                id: 'eli/dl/participation/P-TIE',
                activity_date: '2024-05-01',
                participation_role: 'def/ep-roles/A',
              },
              { id: 'eli/dl/participation/P-EARLY', activity_date: '2023-01-01' },
            ],
            reverse,
          ),
        }),
        'en',
        [],
      );
    const result = normalize(false);
    expect(normalize(true)).toEqual(result);
    expect(result.events).toEqual([
      { id: 'EV-EARLY-A', date: '2024-12-01', document_ids: [], sitting_ids: [] },
      { id: 'EV-EARLY-B', date: '2024-12-01', document_ids: [], sitting_ids: [] },
      {
        id: 'EV-LATE',
        date: '2025-03-01',
        document_ids: ['DOC-1', 'DOC-2', 'DOC-3'],
        sitting_ids: ['MTG-1', 'MTG-2'],
      },
      { id: 'EV-UNDATED-A', document_ids: [], sitting_ids: [] },
      { id: 'EV-UNDATED-B', document_ids: [], sitting_ids: [] },
    ]);
    expect(result.participants).toEqual([
      {
        id: 'eli/dl/participation/P-EARLY',
        date: '2023-01-01',
        person_ids: [],
        organization_ids: [],
      },
      {
        id: 'eli/dl/participation/P-TIE',
        date: '2024-05-01',
        role: 'def/ep-roles/A',
        person_ids: [],
        organization_ids: [],
      },
      {
        id: 'eli/dl/participation/P-TIE',
        date: '2024-05-01',
        role: 'def/ep-roles/B',
        person_ids: [],
        organization_ids: [],
      },
      {
        id: 'eli/dl/participation/P-UNDATED',
        person_ids: ['1', '2', '3'],
        organization_ids: ['org/A', 'org/B'],
      },
    ]);
    expect(result.documents.map((item) => item.document_id)).toEqual([
      'DOC-0',
      'DOC-1',
      'DOC-2',
      'DOC-3',
      'DOC-9',
    ]);
  });
  it('separates all recorded/intended voter arrays and unavailable versus published empty', () => {
    const raw = decisionSchema.parse(decisionRecord);
    expect(decisionVoters(raw, 'favor')).toEqual(['900000001', '900000002']);
    expect(decisionVoters(raw, 'against')).toEqual(['900000003']);
    expect(decisionVoters(raw, 'abstention')).toEqual([]);
    expect(decisionVoters(raw, 'intended_favor')).toEqual(['900000004']);
    expect(decisionVoters(raw, 'intended_against')).toEqual(['900000005']);
    expect(decisionVoters(raw, 'intended_abstention')).toEqual(['900000006']);
    expect(decisionVoters(decisionSchema.parse({ id: raw.id }), 'favor')).toBeUndefined();
    expect(normalizeDecisionSummary(raw)).toMatchObject({ favor: 2, against: 1, abstention: 0 });
    expect(normalizeDecisionSummary(raw)).not.toHaveProperty('attendees');
    expect(normalizeDecision(raw, 'fr', [])).toMatchObject({
      label: { value: 'Amendement exemple', language: 'fr' },
      reference_text: { value: 'Recital 1', language: 'en' },
      recording_document_ids: ['PV-10-2025-01-15-RCV-ITM-001'],
    });
  });
  it('hashes full normalized contents and scope before whole-item slicing', () => {
    const items = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    const first = localPage(items, { offset: 0, limit: 1 }, { term: 10 });
    expect(first.items).toEqual([{ id: 'first' }]);
    expect(first.page).toMatchObject({ next_offset: 1, has_more: true, returned: 1 });
    const snapshot = first.page.snapshot!;
    expect(snapshot).toMatch(/^[a-f0-9]{64}$/);
    const second = localPage(items, { offset: 1, limit: 1, snapshot }, { term: 10 });
    expect(second.items).toEqual([{ id: 'second' }]);
    // Whether continuation requires a snapshot is the caller's contract, checked before acquisition.
    const unchecked = localPage(items, { offset: 1, limit: 20 }, { term: 10 });
    expect(unchecked.items).toEqual([{ id: 'second' }, { id: 'third' }]);
    expect(unchecked.page.snapshot).toBe(snapshot);
    expect(() =>
      localPage(
        [...items.slice(0, 2), { id: 'changed unseen third' }],
        { offset: 0, limit: 20, snapshot },
        { term: 10 },
      ),
    ).toThrow();
    expect(() => localPage(items, { offset: 0, limit: 20, snapshot }, { term: 9 })).toThrow();
    expect(localPage(items, { offset: 20, limit: 20, snapshot }, { term: 10 })).toMatchObject({
      items: [],
      total: 3,
      page: { returned: 0, has_more: false },
    });
  });
  it.each([
    ['procedures', 1000],
    ['questions', 1000],
    ['documents', 1000],
    ['speeches', 5000],
    ['meps', 5000],
    ['memberships', 5000],
    ['procedure_sections', 5000],
    ['voters', 5000],
    ['sittings', 1000],
    ['decisions', 5000],
    ['reference', 1000],
    ['organizations', 20],
  ] as const)('caps a %s page at %i whole items', (collection, cap) => {
    expect(pageWindow({ limit: 5000 }, collection)).toEqual({ offset: 0, limit: cap });
    expect(pageWindow({ offset: 7, limit: cap }, collection)).toEqual({ offset: 7, limit: cap });
    expect(pageWindow({}, collection)).toEqual({ offset: 0, limit: 20 });
  });
  it.each([
    [{ offset: 9900, limit: 1000 }, 100, 1000],
    [{ offset: 9950, limit: 1000 }, 50, 1000],
    [{ offset: 9990, limit: 20 }, 10, 20],
    [{ offset: 9700, limit: 1000 }, 300, 1000],
    [{ offset: 9000, limit: 250 }, 250, 250],
    [{ offset: 10000, limit: 1000 }, 1000, 1000],
  ])('narrows %j to %i inside a 10000-result window and %i without one', (input, inside, open) => {
    expect(pageWindow(input, 'procedures', 10_000)).toEqual({
      offset: input.offset,
      limit: inside,
    });
    expect(pageWindow(input, 'procedures')).toEqual({ offset: input.offset, limit: open });
  });
  it('pages a local collection at the effective window and does not invent upstream totals', () => {
    expect(
      localPage(
        Array.from({ length: 1001 }, (_, id) => ({ id })),
        { offset: 0, limit: 1000 },
        {},
      ).page,
    ).toMatchObject({ limit: 1000, returned: 1000, next_offset: 1000 });
    expect(upstreamPage(20, { offset: 0, limit: 20 })).toEqual({
      offset: 0,
      limit: 20,
      returned: 20,
      has_more: true,
      next_offset: 20,
    });
    expect(upstreamPage(2, { offset: 20, limit: 20 }, 22)).toEqual({
      offset: 20,
      limit: 20,
      returned: 2,
      has_more: false,
    });
  });
  it('returns all requested whole items regardless of rendered size', () => {
    const items = Array.from({ length: 150 }, (_, id) => ({ id, text: 'x'.repeat(1000) }));
    const result = localPage(items, { offset: 0, limit: 150 }, {});
    expect(result.items).toEqual(items);
    expect(result.page).toMatchObject({ limit: 150, returned: 150, has_more: false });
  });
  it('keeps the window limit on a final short page', () => {
    const items = Array.from({ length: 5 }, (_, id) => ({ id }));
    const { snapshot } = localPage(items, { offset: 0, limit: 3 }, {}).page;
    expect(localPage(items, { offset: 3, limit: 3, ...(snapshot && { snapshot }) }, {})).toEqual({
      items: [{ id: 3 }, { id: 4 }],
      total: 5,
      page: { offset: 3, limit: 3, returned: 2, has_more: false, snapshot },
    });
  });
  it('normalizes non-ASCII name tokens without dropping word boundaries', () => {
    expect(normalizeName('Élodie DEMO')).toBe('elodie demo');
    expect(normalizeName('Alex-Example')).toBe('alex example');
  });
});

describe('document input identifiers', () => {
  it.each([
    ['A9-0188/2023', ['A-9-2023-0188']],
    ['P9_A(2023)0188', ['A-9-2023-0188']],
    ['T9-0138/2024', ['TA-9-2024-0138']],
    ['P9_TA(2024)0138', ['TA-9-2024-0138']],
    ['RC-B9-0163/2024', ['RC-9-2024-0163']],
    ['P9_OJQ(2024)03-13', ['OJQ-9-2024-03-13']],
    ['B9-0163/2024', ['B-9-2024-0163', 'QOB-9-2024-0163']],
    ['B10-0104/2024', ['B-10-2024-0104', 'QOB-10-2024-0104']],
    ['ta-9-2024-0138', ['TA-9-2024-0138']],
    ['t9-0138/2024', ['TA-9-2024-0138']],
    ['p9_ta(2024)0138', ['TA-9-2024-0138']],
    ['rc-b9-0163/2024', ['RC-9-2024-0163']],
    [' A9-0188/2023 ', ['A-9-2023-0188']],
    ['https://data.europarl.europa.eu/eli/dl/doc/ta-9-2024-0138', ['TA-9-2024-0138']],
    ['eli/dl/doc/A-9-2023-0188', ['A-9-2023-0188']],
    ['TA-9-2019-10-23-ANN01', ['TA-9-2019-10-23-ANN01']],
    ['EXAMPLE_1', ['EXAMPLE_1']],
    ['MTG-PL-2024-03-13-VOT-ITM-941749-SPLIT-1-2', ['MTG-PL-2024-03-13-VOT-ITM-941749-SPLIT-1-2']],
    ['DCI-101039-2026-05-20-559365', ['DCI-101039-2026-05-20-559365']],
  ])('reads document_id %j as %j', (input, expected) => {
    expect(documentInputIds(input)).toEqual(expected);
  });
  it.each([
    'A9-188/2023',
    'AD-PE786.674',
    'E-000003/2025',
    'C10-0119/2024',
    'P9_TA(2024)138',
    'T9-0138/24',
    '../unsafe',
    'eli/dl/doc/',
    'https://evil.example/eli/dl/doc/A-9-2023-0188',
  ])('rejects document_id %j naming the parameter, the value and the accepted forms', (input) => {
    let rejection: unknown;
    try {
      documentInputIds(input);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      message: `document_id ${JSON.stringify(input)} is not a document identifier or citation. Pass a canonical identifier such as TA-9-2024-0138, in any letter case, bare, after eli/dl/doc/ or in the exact https://data.europarl.europa.eu/eli/dl/doc/ URI, or a citation: T9-0138/2024 or P9_TA(2024)0138 (adopted text), A9-0188/2023 or P9_A(2023)0188 (report), B9-0163/2024 (motion or question motion), RC-B9-0163/2024 (joint motion), P9_OJQ(2024)03-13 (agenda).`,
    });
    expect((rejection as { data: unknown }).data).toEqual({
      reason: 'invalid_filter',
      recovery: {
        hint: 'Call euparl_search_documents in search mode for canonical document_id values, then retry; pass a question citation such as E-000003/2025 to euparl_list_questions as question_id.',
      },
    });
  });
  it('folds only caller input: identifiers read from records keep their published case', () => {
    expect(canonicalId('eli/dl/doc/Mixed-Case_1', 'document')).toBe('Mixed-Case_1');
    expect(
      normalizeDocument(documentSchema.parse({ id: 'eli/dl/doc/Mixed-Case_1' }), 'en', []),
    ).toMatchObject({ document_id: 'Mixed-Case_1' });
  });
});

describe('adopted-text search rows', () => {
  it.each(['adopted_documents', 'keyword_documents'] as const)(
    'caps a %s page at 100 whole items',
    (collection) => {
      expect(pageWindow({ limit: 1000 }, collection)).toEqual({ offset: 0, limit: 100 });
      expect(pageWindow({ offset: 9950, limit: 1000 }, collection, 10_000)).toEqual({
        offset: 9950,
        limit: 50,
      });
      expect(pageWindow({}, collection)).toEqual({ offset: 0, limit: 20 });
    },
  );
  it('keeps only the requested-language title, the date and the procedures of the family relation', () => {
    const row = (extra: Record<string, unknown>) =>
      adoptedTextRowSchema.parse({ id: 'eli/dl/doc/TA-10-2025-0257', ...extra });
    expect(
      normalizeAdoptedTextRow(
        row({
          identifier: 'TA-10-2025-0257',
          label: 'T10-0257/2025',
          title_dcterms: { hr: 'Naslov', en: 'Title' },
          document_date: '2025-10-23',
          inverse_created_a_realization_of: [
            'eli/dl/event/MTG-PL-2025-10-23-PVCRE-ITM-9-1',
            'eli/dl/proc/2025-0900',
            { id: 'https://data.europarl.europa.eu/eli/dl/proc/2025-2195' },
          ],
        }),
        'hr',
      ),
    ).toEqual({
      document_id: 'TA-10-2025-0257',
      identifier: 'TA-10-2025-0257',
      label: 'T10-0257/2025',
      source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-10-2025-0257',
      title: { value: 'Naslov', language: 'hr' },
      date: '2025-10-23',
      procedure_ids: ['2025-0900', '2025-2195'],
    });
    // No fallback: the list publishes only the requested language, so an English-only row has none.
    expect(normalizeAdoptedTextRow(row({ title_dcterms: { en: 'Title' } }), 'hr')).toEqual({
      document_id: 'TA-10-2025-0257',
      source_url: 'https://data.europarl.europa.eu/eli/dl/doc/TA-10-2025-0257',
      procedure_ids: [],
    });
  });
});

/** Live speech fragments (2026-11), long paragraphs trimmed; element and attribute shapes kept. */
const fragments = {
  ...speechFragments,
  reintke:
    '<oralStatements><speech endTime="2026-04-28T09:48:17.542" startTime="2026-04-28T09:46:02.166" xml:lang="en"><from xml:lang="en" xml:space="preserve"><person refersTo="epdata:person/103381">Terry Reintke</person>, <role refersTo="">on behalf of the <organization refersTo="epdata:org/7028">Verts/ALE</organization> Group</role>.</from><!--en - 0--><blockContainer xml:lang="en"><p xml:space="preserve"><recordedTime time="2026-04-28T09:46:02.216+02:00" type="startEvent"/>Mr President, dear disciples, Member States come up over and over again with new tasks for Europe.<recordedTime time="2026-04-28T09:46:26.626+02:00" type="endEvent"/></p></blockContainer><!--de - 1--><blockContainer xml:lang="de-t-en-mtec"><p xml:space="preserve"><recordedTime time="2026-04-28T09:47:17.85+02:00" type="startEvent"/><inline name="verba-comment">Dear colleagues</inline>The German Chancellor is putting the crown on this game of national blinders.<recordedTime time="2026-04-28T09:47:46.62+02:00" type="endEvent"/></p></blockContainer></speech></oralStatements>',
  perWordTimes:
    '<oralStatements><speech endTime="2026-04-28T09:16:44.105" startTime="2026-04-28T09:15:25.098" xml:lang="de"><from xml:lang="de" xml:space="preserve"><person refersTo="epdata:person/256926">Marie-Agnes Strack-Zimmermann</person>, <role refersTo="">Verfasserin der Stellungnahme des <organization refersTo="epdata:org/7911">SEDE</organization>-Ausschusses</role>.</from><blockContainer><p xml:space="preserve"><recordedTime time="2026-04-28T09:15:28.188+02:00" type="startEvent"/><time time="2026-04-28T09:15:28.188+02:00">Herr</time> <time time="2026-04-28T09:15:28.428+02:00">Präsident,</time> <time time="2026-04-28T09:15:29.088+02:00">liebe</time> <time time="2026-04-28T09:15:29.268+02:00">Kolleginnen</time> <time time="2026-04-28T09:15:29.708+02:00">und</time> <time time="2026-04-28T09:15:29.798+02:00">Kollegen!</time></p></blockContainer></speech></oralStatements>',
  written:
    '<writtenStatements><speech xml:lang="hu-t-en-mtec"><from xml:lang="hu-t-en-mtec" xml:space="preserve"><person refersTo="epdata:person/256861">Kinga Kollár</person> (<organization refersTo="epdata:org/7018">PPE</organization>), <process refersTo="">in writing</process></from><blockContainer><p xml:space="preserve">Europe needs a bigger common budget because our challenges have become bigger. </p><p>We cannot choose between investing in the future, Europe\'s security or socio-economic cohesion.</p><p/><p xml:space="preserve">The question of how to finance the next budget is equally important. </p></blockContainer></speech></writtenStatements>',
  blueCard:
    '<oralStatements><question endTime="2025-03-11T10:12:44.746000000" startTime="2025-03-11T10:12:13.895000000"><from xml:lang="lt-t-en-mtec" xml:space="preserve"><person refersTo="epdata:person/256808">Petras Gražulis</person> (<organization refersTo="epdata:org/7151">ESN</organization>), <process refersTo="">blue card raised question</process>.</from><blockContainer><p xml:space="preserve">Honourable rapporteur, a lot of loud words. Why is Ukraine not accepted into the European Union?</p></blockContainer></question></oralStatements>',
  summary:
    '<oralStatements><speech endTime="2025-03-11T10:11:55" startTime="2025-03-11T10:09:34"><from xml:lang="en" xml:space="preserve"><person refersTo="epdata:person/197818">Billy Kelleher</person> (<organization refersTo="epdata:org/7035">Renew</organization>).</from><blockContainer><p xml:space="preserve">I will say it again, if it is worth building, it is worth defending.</p></blockContainer></speech><communication><summary xml:lang="en">(The speaker agreed to take a blue-card question)</summary></communication></oralStatements>',
  narrative:
    '<communication><narrative xml:lang="en-t-fi-mtec"><inline name="i">(Istunto avattiin klo 10.05.)</inline></narrative></communication>',
  heading:
    '<writtenStatements><heading xmlns:ep="http://europarl.europa.eu/xml4ep/3.0" ep:ref="eu.europa.europarl.verba:item/id=2017098747138" xml:lang="it-t-en-mtec">Written declarations (Rule 178)</heading></writtenStatements>',
};

describe('speech fragment text', () => {
  it.each([
    [
      'benifei',
      {
        text: 'Mr President, Commissioner Breton, ladies and gentlemen, after two intense years of work, we have finally come to pass the world\'s first binding law on artificial intelligence.\n\nEnough of the indiscriminate use of deep fake that will be made recognizable through the so-called "watermarking", an invisible labeling.',
        language_tags: ['en'],
        speaker: 'Brando Benifei, Rapporteur.',
      },
    ],
    [
      'reintke',
      {
        text: 'Mr President, dear disciples, Member States come up over and over again with new tasks for Europe.\n\nDear colleaguesThe German Chancellor is putting the crown on this game of national blinders.',
        language_tags: ['en', 'de-t-en-mtec'],
        speaker: 'Terry Reintke, on behalf of the Verts/ALE Group.',
      },
    ],
    [
      'perWordTimes',
      {
        text: 'Herr Präsident, liebe Kolleginnen und Kollegen!',
        language_tags: ['de'],
        speaker:
          'Marie-Agnes Strack-Zimmermann, Verfasserin der Stellungnahme des SEDE-Ausschusses.',
      },
    ],
    ['chair', { text: 'IN THE CHAIR: ROBERTA METSOLA\n\nPresident', language_tags: ['en'] }],
    [
      'written',
      {
        text: "Europe needs a bigger common budget because our challenges have become bigger.\n\nWe cannot choose between investing in the future, Europe's security or socio-economic cohesion.\n\nThe question of how to finance the next budget is equally important.",
        language_tags: ['hu-t-en-mtec'],
        speaker: 'Kinga Kollár (PPE), in writing',
      },
    ],
    [
      'irish',
      {
        text: 'Dearbhaím gur atosaíodh an seisiún de Pharlaimint na hEorpa a cuireadh ar atráth Déardaoin, an 24 Meitheamh 2021.',
        language_tags: ['ga'],
        speaker: 'Presidente. –',
      },
    ],
    [
      'blueCard',
      {
        text: 'Honourable rapporteur, a lot of loud words. Why is Ukraine not accepted into the European Union?',
        language_tags: ['lt-t-en-mtec'],
        speaker: 'Petras Gražulis (ESN), blue card raised question.',
      },
    ],
    [
      'summary',
      {
        text: 'I will say it again, if it is worth building, it is worth defending.\n\n(The speaker agreed to take a blue-card question)',
        language_tags: ['en'],
        speaker: 'Billy Kelleher (Renew).',
      },
    ],
    ['narrative', { text: '(Istunto avattiin klo 10.05.)', language_tags: ['en-t-fi-mtec'] }],
    ['heading', { text: 'Written declarations (Rule 178)', language_tags: ['it-t-en-mtec'] }],
  ] as const)('reads the published %s fragment', (name, expected) => {
    expect(fragmentText(fragments[name])).toEqual(expected);
  });

  it('decodes entities in one pass and keeps unknown or out-of-range references literal', () => {
    expect(
      fragmentText(
        '<p>R&amp;D &lt;b&gt; &quot;q&quot; &apos;a&apos; &#233;&#xE9;&#x1F600; &amp;lt; &#0; &#x110000; &#xD800; &#X41; &nbsp; &unknown; & alone &#; &amp</p>',
      ).text,
    ).toBe(
      'R&D <b> "q" \'a\' éé😀 &lt; &#0; &#x110000; &#xD800; &#X41; &nbsp; &unknown; & alone &#; &amp',
    );
    expect(fragmentText('<p xml:lang="de&#45;t&#45;en&#45;mtec">x</p>').language_tags).toEqual([
      'de-t-en-mtec',
    ]);
  });

  it('keeps the text of elements it does not know, and of text outside any paragraph', () => {
    expect(
      fragmentText(
        '<oralStatements>Loose opening<speech><annex><row>Cell A</row></annex><blockContainer><p>Alpha <sup>2</sup> <newThing attr="x>y" other=\'q"\'>beta</newThing></p>Trailing words</blockContainer></speech></oralStatements>',
      ),
    ).toEqual({
      text: 'Loose opening\n\nCell A\n\nAlpha 2 beta\n\nTrailing words',
      language_tags: [],
    });
  });

  it('drops comments, processing instructions and declarations, and keeps CDATA verbatim', () => {
    expect(
      fragmentText(
        '<?xml version="1.0"?><!DOCTYPE oralStatements><oralStatements><p>one<!-- a <p>note</p> -->two</p><p><![CDATA[a < b & c &amp; d]]></p></oralStatements>',
      ).text,
    ).toBe('onetwo\n\na < b & c &amp; d');
  });

  it('reads a second speaker line as text and leaves an empty speaker absent', () => {
    expect(
      fragmentText(
        '<oralStatements><question><from>Asker (S&amp;D).</from><p>Why?</p></question><answer><from>Commissioner.</from><p>Because.</p></answer></oralStatements>',
      ),
    ).toEqual({
      text: 'Why?\n\nCommissioner.\n\nBecause.',
      language_tags: [],
      speaker: 'Asker (S&D).',
    });
    expect(fragmentText('<speech><from> </from><p>x</p></speech>')).toEqual({
      text: 'x',
      language_tags: [],
    });
    expect(fragmentText('<speech><from/><blockContainer><p/></blockContainer></speech>')).toEqual({
      text: '',
      language_tags: [],
    });
  });

  it.each([
    ['<p>text<a', 'text<a'],
    ['<p>text<a b="unterminated</p>', 'text<a b="unterminated</p>'],
    ['<p>a<!-- never closed</p>', 'a<!-- never closed</p>'],
    ['<p>a<![CDATA[open', 'aopen'],
    ['<p>1 < 2 and 3 <> 4</p>', '1 < 2 and 3 <> 4'],
    ['<p>a</q>b</p>c', 'ab\n\nc'],
    ['<p>a<b>b</p>c</b>d', 'ab\n\ncd'],
    ['<summary><p>inner</summary>after', 'inner\n\nafter'],
    ['no markup at all', 'no markup at all'],
  ])('keeps the text of malformed fragment %j', (xml, text) => {
    expect(fragmentText(xml).text).toBe(text);
  });

  it.each([
    ['repeated opener with no closer', (n: number) => '<a'.repeat(n / 2)],
    ['nested openers', (n: number) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
    [
      'open elements closed by other names',
      (n: number) => `${'<p>'.repeat(n / 8)}${'</q>'.repeat(n / 8)}${'</p>'.repeat(n / 8)}`,
    ],
    ['overlapping markup prefixes', (n: number) => '<!-<![CDATA<?&#&am'.repeat(n / 16)],
    ['unterminated comment', (n: number) => `<!--${'-'.repeat(n)}`],
    ['unterminated attribute value', (n: number) => `<p a="${'x'.repeat(n)}`],
    ['attribute names without values', (n: number) => `<p ${'a '.repeat(n / 2)}>x</p>`],
    ['one long line ending in a break', (n: number) => `<p>${'x '.repeat(n / 2)}\ny</p>`],
    ['breaks throughout', (n: number) => `<p>${'  \r\n'.repeat(n / 4)}</p>`],
    ['references throughout', (n: number) => `<p>${'&#x41;&amp &'.repeat(n / 16)}</p>`],
    ['per-word time markup', (n: number) => `<p>${'<time time="t">w</time> '.repeat(n / 32)}</p>`],
  ])('reading a fragment of %s stays linear', { timeout: 0 }, (_, shape) => {
    expectLinearCpu(fragmentText, shape);
  });
});

describe('original languages', () => {
  const authority = 'http://publications.europa.eu/resource/authority/language/';
  it('maps the 24 EU language authority codes to ISO 639-1 and passes others through verbatim', () => {
    const codes = {
      BUL: 'bg',
      CES: 'cs',
      DAN: 'da',
      DEU: 'de',
      ELL: 'el',
      ENG: 'en',
      EST: 'et',
      FIN: 'fi',
      FRA: 'fr',
      GLE: 'ga',
      HRV: 'hr',
      HUN: 'hu',
      ITA: 'it',
      LAV: 'lv',
      LIT: 'lt',
      MLT: 'mt',
      NLD: 'nl',
      POL: 'pl',
      POR: 'pt',
      RON: 'ro',
      SLK: 'sk',
      SLV: 'sl',
      SPA: 'es',
      SWE: 'sv',
    };
    expect(originalLanguages(Object.keys(codes).map((code) => `${authority}${code}`))).toEqual(
      Object.values(codes),
    );
    expect(
      originalLanguages([
        `${authority}MUL`,
        `${authority}ita`,
        'ITA',
        `https://publications.europa.eu/resource/authority/language/ITA`,
        `${authority}__proto__`,
      ]),
    ).toEqual([
      `${authority}MUL`,
      `${authority}ita`,
      'ITA',
      'https://publications.europa.eu/resource/authority/language/ITA',
      `${authority}__proto__`,
    ]);
    expect(originalLanguages(`${authority}POL`)).toEqual(['pl']);
    expect(originalLanguages(undefined)).toEqual([]);
  });

  it('adds original languages to every speech, and text with a language-only title on request', () => {
    const raw = speechSchema.parse({
      id: 'eli/dl/event/MTG-PL-2021-07-05-OTH-10040000',
      activity_label: { en: 'Resumption of the session' },
      recorded_in_a_realization_of: [
        {
          id: 'eli/dl/doc/CRE-9-2021-07-05-OTH-10040000',
          originalLanguage: [`${authority}ITA`],
          'api:xmlFragment': { ga: fragments.irish },
        },
      ],
    });
    const notices: string[] = [];
    const metadata = normalizeSpeech(raw, 'ga', notices);
    expect(metadata).toMatchObject({
      title: { language: 'en', value: 'Resumption of the session' },
      original_languages: ['it'],
      document_ids: ['CRE-9-2021-07-05-OTH-10040000'],
    });
    expect(metadata).not.toHaveProperty('text');
    expect(notices).toHaveLength(1);
    const spoken = normalizeSpeech(raw, 'ga', [], { text: true });
    expect(spoken).not.toHaveProperty('title');
    expect(spoken).toMatchObject({
      original_languages: ['it'],
      speaker: 'Presidente. –',
      language_tags: ['ga'],
      text: {
        language: 'ga',
        value:
          'Dearbhaím gur atosaíodh an seisiún de Pharlaimint na hEorpa a cuireadh ar atráth Déardaoin, an 24 Meitheamh 2021.',
      },
    });
    const english = normalizeSpeech(raw, 'en', [], { text: true });
    expect(english).toMatchObject({
      title: { language: 'en', value: 'Resumption of the session' },
    });
    expect(english).not.toHaveProperty('text');
    expect(english).not.toHaveProperty('language_tags');
    expect(
      normalizeSpeech(speechSchema.parse({ id: 'eli/dl/event/S-1' }), 'en', [], { text: true }),
    ).toEqual({
      speech_id: 'S-1',
      participants: [],
      document_ids: [],
      original_languages: [],
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/S-1',
    });
  });
});
