/** @fileoverview Minimal synthetic JSON-LD records retaining published Parliament shapes. */

/** Synthetic person records deliberately omit contact and birth data. */
export const rosterRecords = [
  {
    id: 'person/900000001',
    type: 'Person',
    identifier: '900000001',
    label: 'Alex EXAMPLE',
    givenName: 'Alex',
    familyName: 'Example',
    'api:country-of-representation': 'FR',
    'api:political-group': 'PPE',
  },
  {
    id: 'person/900000002',
    type: 'Person',
    identifier: '900000002',
    label: 'Élodie DEMO',
    givenName: 'Élodie',
    familyName: 'Demo',
  },
];

/** Embedded expressions contain multiple manifestations of each selected language. */
export const documentRecord = {
  id: 'eli/dl/doc/AFCO-AD-900001',
  type: 'Work',
  identifier: 'AFCO-AD-900001',
  work_type: 'def/ep-document-types/OPINION_PARLIAMENTARY_COMMITTEE',
  document_date: '2025-01-15',
  parliamentary_term: 'org/ep-10',
  title_dcterms: { fr: 'Avis exemple', en: 'Example opinion' },
  is_realized_by: [
    {
      id: 'eli/dl/doc/AFCO-AD-900001/fr',
      type: 'Expression',
      language: 'http://publications.europa.eu/resource/authority/language/FRA',
      title: { fr: 'Avis exemple' },
      is_embodied_by: [
        {
          id: 'eli/dl/doc/AFCO-AD-900001/fr/pdf',
          type: 'Manifestation',
          is_exemplified_by: 'distribution/example/opinion_fr.pdf',
          format: 'http://publications.europa.eu/resource/authority/file-type/PDF',
          media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
        },
        {
          id: 'eli/dl/doc/AFCO-AD-900001/fr/html',
          type: 'Manifestation',
          is_exemplified_by: 'distribution/example/opinion_fr.html',
          format: 'http://publications.europa.eu/resource/authority/file-type/HTML',
          media_type: 'https://www.iana.org/assignments/media-types/text/html',
        },
      ],
    },
    {
      id: 'eli/dl/doc/AFCO-AD-900001/en',
      type: 'Expression',
      language: 'http://publications.europa.eu/resource/authority/language/ENG',
      title: { en: 'Example opinion' },
      is_embodied_by: [
        {
          id: 'eli/dl/doc/AFCO-AD-900001/en/pdf',
          type: 'Manifestation',
          is_exemplified_by: 'distribution/example/opinion_en.pdf',
          format: 'http://publications.europa.eu/resource/authority/file-type/PDF',
        },
      ],
    },
  ],
};

/** A question can embed an answer work with its own nested expression links. */
export const questionRecord = {
  ...documentRecord,
  id: 'eli/dl/doc/E-10-2025-900001',
  identifier: 'E-10-2025-900001',
  work_type: 'def/ep-document-types/QUESTION_WRITTEN',
  creator: ['person/900000001'],
  inverse_answers_to: [
    {
      ...documentRecord,
      id: 'eli/dl/doc/E-10-2025-900001-ASW',
      identifier: 'E-10-2025-900001-ASW',
      document_date: '2025-02-15',
    },
  ],
};

/** Minimal camelCase membership shape from the person detail endpoint. */
export const mepRecord = {
  ...rosterRecords[0],
  hasMembership: [
    {
      id: 'membership/900000001-m-1',
      type: 'Membership',
      identifier: '900000001-m-1',
      memberDuring: { id: 'time-period/20240716', type: 'PeriodOfTime', startDate: '2024-07-16' },
      organization: 'org/ep-10',
      role: 'def/ep-roles/MEMBER_PARLIAMENT',
      represents: ['http://publications.europa.eu/resource/authority/country/FRA'],
    },
  ],
};

/** All published recorded/intended positions stay distinct; zero is real evidence. */
export const decisionRecord = {
  id: 'eli/dl/event/MTG-PL-2025-01-15-DEC-900001',
  type: 'Vote',
  activity_id: 'MTG-PL-2025-01-15-DEC-900001',
  activity_date: '2025-01-15',
  activity_label: { en: 'Example amendment', fr: 'Amendement exemple' },
  activity_order: '1.0',
  decision_method: 'def/ep-decision-methods/VOTE_ELECTRONIC_ROLLCALL',
  decision_outcome: 'def/ep-statuses/ADOPTED',
  number_of_votes_favor: 2,
  number_of_votes_against: 1,
  number_of_votes_abstention: 0,
  had_voter_favor: ['person/900000001', 'person/900000002'],
  had_voter_against: ['person/900000003'],
  had_voter_abstention: [],
  had_voter_intended_favor: ['person/900000004'],
  had_voter_intended_against: ['person/900000005'],
  had_voter_intended_abstention: ['person/900000006'],
  decided_on_a_realization_of: ['eli/dl/doc/A-10-2025-900001'],
  recorded_in_a_realization_of: ['eli/dl/doc/PV-10-2025-01-15-RCV-ITM-001'],
  referenceText: { en: 'Recital 1' },
  comment: { en: 'RCV' },
};

/** Return an HTTP response rather than bypassing transport parsing. */
export function envelopeResponse(data: unknown[], status = 200): Response {
  return new Response(
    JSON.stringify({
      data,
      '@context': [{ data: '@graph', '@base': 'https://data.europarl.europa.eu/' }],
    }),
    { status, headers: { 'content-type': 'application/ld+json' } },
  );
}
