/** @fileoverview Domain normalization, nested links, and stable local continuation. */
import { describe, expect, it } from 'vitest';
import {
  canonicalId,
  decisionVoters,
  documentLinks,
  localized,
  localPage,
  normalizeDecision,
  normalizeDecisionSummary,
  normalizeDocument,
  normalizeName,
  normalizeProcedure,
  normalizeQuestion,
  normalizeSpeech,
  type Page,
  type PageWindow,
  pageWindow,
  procedureIds,
  upstreamPage,
} from '../../../src/services/eu-parliament/eu-parliament-normalization.js';
import {
  decisionSchema,
  documentSchema,
  procedureSchema,
  questionSchema,
  speechSchema,
} from '../../../src/services/eu-parliament/eu-parliament-schemas.js';
import {
  decisionRecord,
  documentRecord,
  questionRecord,
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
    ['procedures', 300],
    ['questions', 300],
    ['documents', 225],
    ['speeches', 80],
    ['meps', 300],
    ['memberships', 225],
    ['procedure_sections', 125],
    ['voters', 1000],
    ['sittings', 100],
    ['decisions', 100],
    ['reference', 350],
    ['organizations', 20],
  ] as const)('caps a %s page at %i whole items', (collection, cap) => {
    expect(pageWindow({ limit: 5000 }, collection)).toEqual({ offset: 0, limit: cap });
    expect(pageWindow({ offset: 7, limit: cap }, collection)).toEqual({ offset: 7, limit: cap });
    expect(pageWindow({}, collection)).toEqual({ offset: 0, limit: 20 });
  });
  it.each([
    [{ offset: 9900, limit: 1000 }, 100, 300],
    [{ offset: 9950, limit: 1000 }, 50, 300],
    [{ offset: 9990, limit: 20 }, 10, 20],
    [{ offset: 9700, limit: 1000 }, 300, 300],
    [{ offset: 9000, limit: 250 }, 250, 250],
    [{ offset: 10000, limit: 1000 }, 300, 300],
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
  it('stops a budgeted page at whole items once rendered rows pass 92000 characters', () => {
    const sizes = [40_000, 52_000, 1, 91_999, 2, 92_001, 5];
    const items = sizes.map((size, id) => ({ id, size }));
    const calls: [id: number, index: number][] = [];
    const chars = (item: { id: number; size: number }, index: number) => {
      calls.push([item.id, index]);
      return item.size;
    };
    const pages: { ids: number[]; calls: typeof calls; page: Page }[] = [];
    let window: PageWindow = { offset: 0, limit: 100 };
    for (;;) {
      calls.length = 0;
      const result = localPage(items, window, { scope: 1 }, chars);
      pages.push({ ids: result.items.map(({ id }) => id), calls: [...calls], page: result.page });
      if (!result.page.has_more) break;
      window = {
        offset: result.page.next_offset!,
        limit: 100,
        snapshot: result.page.snapshot!,
      };
    }
    expect(pages.map(({ ids }) => ids)).toEqual([[0, 1], [2, 3], [4], [5], [6]]);
    expect(pages[1]?.calls).toEqual([
      [2, 0],
      [3, 1],
      [4, 2],
    ]);
    expect(pages.map(({ page }) => page)).toEqual(
      [0, 2, 4, 5, 6].map((offset, index) => ({
        offset,
        limit: 100,
        returned: [2, 2, 1, 1, 1][index],
        has_more: index < 4,
        ...(index < 4 && { next_offset: [2, 4, 5, 6][index] }),
        snapshot: pages[0]?.page.snapshot,
      })),
    );
    expect(localPage(items, { offset: 0, limit: 1 }, { scope: 1 }, chars).page).toMatchObject({
      limit: 1,
      returned: 1,
      next_offset: 1,
    });
    expect(
      localPage(
        items,
        { offset: 7, limit: 100, snapshot: pages[0]!.page.snapshot! },
        { scope: 1 },
        chars,
      ),
    ).toMatchObject({ items: [], page: { returned: 0, has_more: false } });
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
