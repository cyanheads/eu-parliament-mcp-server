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
  upstreamPage,
} from '../../../src/services/eu-parliament/eu-parliament-normalization.js';
import {
  decisionSchema,
  documentSchema,
  procedureSchema,
  questionSchema,
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
    'org/ep-10',
    'https://evil.example/org/5144',
    '5144?x=y',
    'org/../5144',
    'https://data.europarl.europa.eu.evil/org/5144',
    '%35',
    '5144\n1',
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
      source_url: 'https://data.europarl.europa.eu/eli/dl/event/DEC-1',
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
    const first = localPage(items, { limit: 1 }, { term: 10 });
    expect(first.items).toEqual([{ id: 'first' }]);
    expect(first.page).toMatchObject({ next_offset: 1, has_more: true, returned: 1 });
    const snapshot = first.page.snapshot!;
    expect(snapshot).toMatch(/^[a-f0-9]{64}$/);
    const second = localPage(items, { offset: 1, limit: 1, snapshot }, { term: 10 });
    expect(second.items).toEqual([{ id: 'second' }]);
    expect(() => localPage(items, { offset: 1 }, { term: 10 })).toThrow();
    expect(() =>
      localPage([...items.slice(0, 2), { id: 'changed unseen third' }], { snapshot }, { term: 10 }),
    ).toThrow();
    expect(() => localPage(items, { snapshot }, { term: 9 })).toThrow();
    expect(localPage(items, { offset: 20, snapshot }, { term: 10 })).toMatchObject({
      items: [],
      total: 3,
      page: { returned: 0, has_more: false },
    });
  });
  it('caps whole-item limits and does not invent upstream totals', () => {
    expect(
      localPage(
        Array.from({ length: 101 }, (_, id) => ({ id })),
        { limit: 1000 },
        {},
      ).page,
    ).toMatchObject({ limit: 100, returned: 100, next_offset: 100 });
    expect(upstreamPage(20, {})).toEqual({
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
  it('normalizes non-ASCII name tokens without dropping word boundaries', () => {
    expect(normalizeName('Élodie DEMO')).toBe('elodie demo');
    expect(normalizeName('Alex-Example')).toBe('alex example');
  });
});
