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

/** Live capture from 2026-11-01: meps/show-current?mandate-date=2024-03-13&country-of-representation=MT. */
export const maltaOn20240313 = [
  {
    id: 'person/118859',
    type: 'Person',
    identifier: '118859',
    label: 'Roberta METSOLA',
    familyName: 'Metsola',
    givenName: 'Roberta',
    sortLabel: 'METSOLA',
    'api:country-of-representation': 'MT',
    'api:political-group': 'PPE',
  },
  {
    id: 'person/124781',
    type: 'Person',
    identifier: '124781',
    label: 'Alfred SANT',
    familyName: 'Sant',
    givenName: 'Alfred',
    sortLabel: 'SANT',
    'api:country-of-representation': 'MT',
    'api:political-group': 'S&D',
  },
  {
    id: 'person/197394',
    type: 'Person',
    identifier: '197394',
    label: 'Josianne CUTAJAR',
    familyName: 'Cutajar',
    givenName: 'Josianne',
    sortLabel: 'CUTAJAR',
    'api:country-of-representation': 'MT',
    'api:political-group': 'S&D',
  },
  {
    id: 'person/197403',
    type: 'Person',
    identifier: '197403',
    label: 'Alex AGIUS SALIBA',
    familyName: 'Agius Saliba',
    givenName: 'Alex',
    sortLabel: 'AGIUSSALIBA',
    'api:country-of-representation': 'MT',
    'api:political-group': 'S&D',
  },
  {
    id: 'person/209091',
    type: 'Person',
    identifier: '209091',
    label: 'Cyrus ENGERER',
    familyName: 'Engerer',
    givenName: 'Cyrus',
    sortLabel: 'ENGERER',
    'api:country-of-representation': 'MT',
    'api:political-group': 'S&D',
  },
  {
    id: 'person/28122',
    type: 'Person',
    identifier: '28122',
    label: 'David CASA',
    familyName: 'Casa',
    givenName: 'David',
    sortLabel: 'CASA',
    'api:country-of-representation': 'MT',
    'api:political-group': 'PPE',
  },
];

/**
 * Live row from meps/show-current?mandate-date=2020-01-29 (captured 2026-11-25), which publishes
 * this member's group as JSON null; the 2020-02-12 roster repeats it.
 */
export const nullGroupOn20200129 = {
  id: 'person/185974',
  type: 'Person',
  identifier: '185974',
  label: 'Jordi SOLÉ',
  familyName: 'Solé',
  givenName: 'Jordi',
  sortLabel: 'SOLE',
  'api:country-of-representation': 'ES',
  'api:political-group': null,
};

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

/**
 * Live TA-9-2023-0276 (2026-11-25), trimmed to its en and lt expressions. A manifestation with two
 * files publishes two issue dates and, unless both sizes are equal, two sizes, each array ordered by
 * value rather than by file.
 */
export const multiValuedFilesRecord = {
  id: 'eli/dl/doc/TA-9-2023-0276',
  type: 'Work',
  identifier: 'TA-9-2023-0276',
  work_type: 'def/ep-document-types/TEXT_ADOPTED',
  title_dcterms: {
    en: 'Exchange of information and cooperation concerning terrorist offences: alignment with Union rules on the protection of personal data',
    lt: 'Keitimasis informacija ir bendradarbiavimas teroristinių nusikaltimų srityje: suderinimas su Sąjungos asmens duomenų apsaugos taisyklėmis',
  },
  is_realized_by: [
    {
      id: 'eli/dl/doc/TA-9-2023-0276/lt',
      type: 'Expression',
      is_embodied_by: [
        {
          id: 'eli/dl/doc/TA-9-2023-0276/lt/pdf',
          is_exemplified_by: 'distribution/reds_iPlTa_Itm/TA-9-2023-0276/TA-9-2023-0276-FNL_lt.pdf',
          media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
          issued: '2023-11-15T13:05:52+01:00',
          byteSize: '44793',
        },
        {
          id: 'eli/dl/doc/TA-9-2023-0276/lt/docx',
          is_exemplified_by: [
            'distribution/reds_iPlTa_Itm/TA-9-2023-0276/TA-9-2023-0276-FNL_lt.docx',
            'distribution/doc/TA-9-2023-0276_lt.docx',
          ],
          issued: ['2024-04-16T12:53:46.063+02:00', '2023-11-15T13:05:52+01:00'],
          byteSize: ['44793', '44848'],
        },
        {
          id: 'eli/dl/doc/TA-9-2023-0276/lt/xml',
          is_exemplified_by: 'distribution/reds_iPlTa_Itm/TA-9-2023-0276/TA-9-2023-0276-FNL_lt.xml',
          issued: '2023-12-20T15:53:41+01:00',
          byteSize: '3230',
        },
      ],
    },
    {
      id: 'eli/dl/doc/TA-9-2023-0276/en',
      type: 'Expression',
      is_embodied_by: [
        {
          id: 'eli/dl/doc/TA-9-2023-0276/en/xml',
          is_exemplified_by: [
            'distribution/reds_iPlTa_Itm/TA-9-2023-0276/TA-9-2023-0276-FNL_en.xml',
            'distribution/doc/TA-9-2023-0276_en.xml',
          ],
          media_type: 'https://www.iana.org/assignments/media-types/application/xml',
          issued: ['2024-05-14T17:12:06+02:00', '2023-12-20T15:52:28+01:00'],
          byteSize: '3225',
        },
      ],
    },
  ],
};

/**
 * Live A-9-2022-0014 (2026-11-25), trimmed to its de and en titles: one language publishes two
 * titles on the work and, in another order, on its expression.
 */
export const multiValuedTitleRecord = {
  id: 'eli/dl/doc/A-9-2022-0014',
  type: 'Work',
  identifier: 'A-9-2022-0014',
  title_dcterms: {
    de: [
      'Bericht über den Antrag auf Aufhebung der Immunität von Elena Yoncheva',
      'BERICHT über den Antrag auf Aufhebung der Immunität von Elena Yoncheva',
    ],
    en: 'REPORT on the request for waiver of the immunity of Elena Yoncheva',
  },
  is_realized_by: [
    {
      id: 'eli/dl/doc/A-9-2022-0014/de',
      type: 'Expression',
      title: {
        de: [
          'BERICHT über den Antrag auf Aufhebung der Immunität von Elena Yoncheva',
          'Bericht über den Antrag auf Aufhebung der Immunität von Elena Yoncheva',
        ],
      },
      title_alternative: {
        de: 'BERICHT<br/>über den Antrag auf Aufhebung der Immunität von Elena Yoncheva<br/>(2019/2155(IMM))<br/>Rechtsausschuss<br/>Berichterstatter: Gilles Lebreton',
      },
    },
  ],
};

/**
 * Live `/meps-declarations?related-process-id=2021-0106&language=en` row (2026-11-25), its
 * alternative titles trimmed: the member filed in Polish, so the expression is a bare ID.
 */
export const declarationRow = {
  id: 'eli/dl/doc/DCI-124884-2023-11-17-324583',
  type: 'Work',
  parliamentary_term: 'org/ep-9',
  document_date: '2023-11-17',
  is_realized_by: ['eli/dl/doc/DCI-124884-2023-11-17-324583/pl'],
  refers_to: ['eli/dl/proc/2021-0106'],
  work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
  identifier: 'DCI-124884-2023-11-17-324583',
  publisher: 'org/EU_PARLIAMENT',
  title_dcterms: {
    en: 'Declaration on awareness of conflicts of interest - Kosma ZŁOTOWSKI - Shadow rapporteur for report - Committee on the Internal Market and Consumer Protection - 2021/0106(COD) - 17-11-2023',
  },
  label: 'DCI-124884-2023-11-17-324583',
  notation_providerId: '324583',
  awarenessOfConflict: false,
  identifierYear: '2023',
  workHadParticipation: [
    {
      id: 'eli/dl/participation/DCI-124884-2023-11-17-324583-AUTHOR',
      type: 'Participation',
      activity_date: '2023-11-17',
      had_participant_person: ['person/124884'],
      parliamentary_term: 'org/ep-9',
      participation_role: 'def/ep-roles/AUTHOR',
      inCapacityOf: {
        id: 'eli/dl/capacity/DCI-124884-2023-11-17-324583-AUTHOR',
        type: 'ForeseenCapacity',
        activity_date: '2023-11-17',
        parliamentary_term: 'org/ep-9',
        capacityActivity: 'eli/dl/proc/2021-0106',
        capacityActivityLabel: '2021/0106(COD)  Artificial Intelligence Act',
        capacityOrganization: 'org/IMCO',
        capacityPerson: 'person/124884',
        capacityRole: 'def/ep-roles/RAPPORTEUR_SHADOW_REPORT',
        politicalGroup: 'org/ECR',
      },
      politicalGroup: 'org/ECR',
    },
  ],
};

/**
 * Live `person-id=124867&language=en` rows (2026-11-25): an official-delegation declaration naming
 * no procedure, superseded by a later one; the pair links both ways.
 */
const delegationDeclaration = (id: string, date: string) => ({
  id: `eli/dl/doc/${id}`,
  type: 'Work',
  parliamentary_term: 'org/ep-10',
  document_date: date,
  is_realized_by: [`eli/dl/doc/${id}/it`],
  work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
  identifier: id,
  title_dcterms: {
    en: `Declaration on awareness of conflicts of interest - Brando BENIFEI - Member participating in an official delegation - Committee on Legal Affairs - - ${date.split('-').toReversed().join('-')}`,
  },
  label: id,
  notation_dossierId: 'JURI/10/05135',
  awarenessOfConflict: false,
  workHadParticipation: [
    {
      id: `eli/dl/participation/${id}-AUTHOR`,
      type: 'Participation',
      activity_date: date,
      had_participant_person: ['person/124867'],
      participation_role: 'def/ep-roles/AUTHOR',
      inCapacityOf: {
        id: `eli/dl/capacity/${id}-AUTHOR`,
        type: 'ForeseenCapacity',
        capacityOrganization: 'org/JURI',
        capacityPerson: 'person/124867',
        capacityRole: 'def/ep-roles/MEMBER_DELEGATION_OFFICIAL',
        politicalGroup: 'org/S-D',
      },
      politicalGroup: 'org/S-D',
    },
  ],
});
export const supersededDeclarationRows = [
  {
    ...delegationDeclaration('DCI-124867-2026-02-27-538194', '2026-02-27'),
    inverse_previousVersion: ['eli/dl/doc/DCI-124867-2026-03-12-540997'],
  },
  {
    ...delegationDeclaration('DCI-124867-2026-03-12-540997', '2026-03-12'),
    previousVersion: ['eli/dl/doc/DCI-124867-2026-02-27-538194'],
  },
];

const awareDeclarationId = 'DCI-124760-2024-12-17-425114';
/** Live `/documents/DCI-124760-2024-12-17-425114` (2026-11-25), trimmed to en and fr titles. */
export const awareDeclarationRecord = {
  id: `eli/dl/doc/${awareDeclarationId}`,
  type: 'Work',
  parliamentary_term: 'org/ep-10',
  document_date: '2024-12-17',
  refers_to: ['eli/dl/proc/2021-0387'],
  work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
  identifier: awareDeclarationId,
  label: awareDeclarationId,
  title_dcterms: {
    en: 'Declaration on awareness of conflicts of interest - Nicolas BAY - Rapporteur - Committee on Civil Liberties, Justice and Home Affairs - 2021/0387(COD) - 17-12-2024',
    fr: 'Déclaration de connaissance de conflits d’intérêts - Nicolas BAY - Rapporteur - Commission des libertés civiles, de la justice et des affaires intérieures - 2021/0387(COD) - 17-12-2024',
  },
  is_realized_by: [
    {
      id: `eli/dl/doc/${awareDeclarationId}/fr`,
      type: 'Expression',
      is_embodied_by: [
        {
          id: `eli/dl/doc/${awareDeclarationId}/fr/pdf`,
          type: 'Manifestation',
          is_exemplified_by: `distribution/doc/${awareDeclarationId}_fr.pdf`,
          media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
          issued: '2025-11-01T23:51:36+01:00',
          byteSize: '85211',
        },
      ],
      language: 'http://publications.europa.eu/resource/authority/language/FRA',
    },
  ],
  awarenessOfConflict: true,
  conflictDescription:
    "J'ai été désigné par le Conseil régional de Normandie pour siéger, en tant qu'élu régional, au conseil d'administration de l'aéroport de Deauville. Je n'ai à titre personnel aucune participation financière dans l'aéroport.",
  // The generic route publishes the participation as a bare ID and no version links.
  workHadParticipation: [`eli/dl/participation/${awareDeclarationId}-AUTHOR`],
};
/** Live `/meps-declarations/DCI-124760-2024-12-17-425114` (2026-11-25), trimmed as the generic record. */
export const awareDeclarationFamilyRecord = {
  ...awareDeclarationRecord,
  workHadParticipation: [
    {
      id: `eli/dl/participation/${awareDeclarationId}-AUTHOR`,
      type: 'Participation',
      activity_date: '2024-12-17',
      had_participant_person: ['person/124760'],
      parliamentary_term: 'org/ep-10',
      participation_role: 'def/ep-roles/AUTHOR',
      inCapacityOf: {
        id: `eli/dl/capacity/${awareDeclarationId}-AUTHOR`,
        type: 'ForeseenCapacity',
        activity_date: '2024-12-17',
        parliamentary_term: 'org/ep-10',
        capacityActivity: 'eli/dl/proc/2021-0387',
        capacityActivityLabel:
          'Proposal for a regulation on measures against transport operators that facilitate or engage in trafficking in persons or smuggling of migrants in relation to illegal entry into the territory of the European Union (2021/0387(COD))',
        capacityOrganization: 'org/LIBE',
        capacityPerson: 'person/124760',
        capacityRole: 'def/ep-roles/RAPPORTEUR',
        politicalGroup: 'org/ECR',
      },
      politicalGroup: 'org/ECR',
    },
  ],
};

const malformedProcedureDeclarationId = 'DCI-197467-2024-03-21-357272';
/**
 * Live `/meps-declarations/DCI-197467-2024-03-21-357272` (2026-11-25), titles trimmed to en and nl
 * and alternative titles dropped. `refers_to` and the capacity's `capacityActivity` publish
 * `eli/dl/proc/2023-02735`, whose five-digit number is no procedure identifier; the title cites
 * 2023/02735(NLE), and 2023-2735 is a different procedure.
 */
export const malformedProcedureDeclaration = {
  id: `eli/dl/doc/${malformedProcedureDeclarationId}`,
  type: 'Work',
  parliamentary_term: 'org/ep-9',
  document_date: '2024-03-21',
  is_realized_by: [
    {
      id: `eli/dl/doc/${malformedProcedureDeclarationId}/nl`,
      type: 'Expression',
      is_embodied_by: [
        {
          id: `eli/dl/doc/${malformedProcedureDeclarationId}/nl/pdf`,
          type: 'Manifestation',
          is_exemplified_by: `distribution/doc/${malformedProcedureDeclarationId}_nl.pdf`,
          media_type: 'https://www.iana.org/assignments/media-types/application/pdf',
          format: 'http://publications.europa.eu/resource/authority/file-type/PDF',
          issued: '2025-11-01T17:52:38+01:00',
          byteSize: '84093',
        },
      ],
      language: 'http://publications.europa.eu/resource/authority/language/NLD',
      title: {
        nl: 'Verklaring over kennis van belangenconflicten - Geert BOURGEOIS - Schaduwrapporteur voor het verslag - Commissie internationale handel - 2023/02735(NLE) - 21-03-2024',
      },
    },
  ],
  refers_to: ['eli/dl/proc/2023-02735'],
  work_type: 'def/ep-document-types/MEMBER_DECLARATION_INTEREST_CONFLICT',
  identifier: malformedProcedureDeclarationId,
  publisher: 'org/EU_PARLIAMENT',
  title_dcterms: {
    en: 'Declaration on awareness of conflicts of interest - Geert BOURGEOIS - Shadow rapporteur for report - Committee on International Trade - 2023/02735(NLE) - 21-03-2024',
    nl: 'Verklaring over kennis van belangenconflicten - Geert BOURGEOIS - Schaduwrapporteur voor het verslag - Commissie internationale handel - 2023/02735(NLE) - 21-03-2024',
  },
  label: malformedProcedureDeclarationId,
  notation_providerId: '357272',
  awarenessOfConflict: false,
  identifierYear: '2024',
  workHadParticipation: [
    {
      id: `eli/dl/participation/${malformedProcedureDeclarationId}-AUTHOR`,
      type: 'Participation',
      activity_date: '2024-03-21',
      had_participant_person: ['person/197467'],
      parliamentary_term: 'org/ep-9',
      participation_role: 'def/ep-roles/AUTHOR',
      inCapacityOf: {
        id: `eli/dl/capacity/${malformedProcedureDeclarationId}-AUTHOR`,
        type: 'ForeseenCapacity',
        activity_date: '2024-03-21',
        parliamentary_term: 'org/ep-9',
        capacityActivity: 'eli/dl/proc/2023-02735',
        capacityActivityLabel:
          'Terugtrekking van de Unie uit het Verdrag inzake het energiehandvest 2023/02735(NLE)',
        capacityOrganization: 'org/INTA',
        capacityPerson: 'person/197467',
        capacityRole: 'def/ep-roles/RAPPORTEUR_SHADOW_REPORT',
        politicalGroup: 'org/ECR',
      },
      politicalGroup: 'org/ECR',
    },
  ],
};
/** The same declaration as `/documents/{id}` serves it: the participation as a bare ID. */
export const malformedProcedureDeclarationRecord = {
  ...malformedProcedureDeclaration,
  workHadParticipation: [`eli/dl/participation/${malformedProcedureDeclarationId}-AUTHOR`],
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

/** Live speech fragments (2026-11), long paragraphs trimmed; element and attribute shapes kept. */
export const speechFragments = {
  benifei:
    '<oralStatements><speech endTime="2024-03-12T14:57:22.000" startTime="2024-03-12T14:52:53.869"><from xml:lang="en" xml:space="preserve"><person refersTo="epdata:person/124867">Brando Benifei</person>, <role>Rapporteur</role>.</from><blockContainer><p xml:space="preserve">Mr President, Commissioner Breton, ladies and gentlemen, after two intense years of work, we have finally come to pass the world\'s first binding law on artificial intelligence.</p><p xml:space="preserve">Enough of the indiscriminate use of <inline name="i">deep fake</inline> that will be made recognizable through the so-called "<inline name="i">watermarking</inline>", an invisible labeling.</p></blockContainer></speech></oralStatements>',
  chair:
    '<communication xml:lang="en"><heading xml:space="preserve">IN THE CHAIR: <person refersTo="epdata:person/118859">ROBERTA METSOLA</person></heading><subheading><role refersTo="epdata:def/ep-roles/PRESIDENT">President</role></subheading></communication>',
  irish:
    '<oralStatements><speech endTime="2021-07-05T17:04:29.000" startTime="2021-07-05T17:04:19.001"><from xml:lang="ga" xml:space="preserve"><person refersTo="epdata:person/96864">Presidente</person>. –</from><blockContainer><p xml:space="preserve">Dearbhaím gur atosaíodh an seisiún de Pharlaimint na hEorpa a cuireadh ar atráth Déardaoin, an 24 Meitheamh 2021.</p></blockContainer></speech></oralStatements>',
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
