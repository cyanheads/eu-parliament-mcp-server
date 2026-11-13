/**
 * @fileoverview Supported Parliament query codes and offline reference records.
 * @module services/eu-parliament/eu-parliament-reference
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { type LocalizedText, pageCaps, searchResultWindow } from './eu-parliament-normalization.js';

/** A version's `temporal` period: start date and, unless still open, end date (both inclusive). */
type Period = readonly [start: string, end?: string];
/**
 * Parliament's EU_POLITICAL_GROUP code records (`/corporate-bodies?body-classification=`
 * `EU_POLITICAL_GROUP`), each with its published label and the `temporal` periods of the version
 * records that are `isVersionOf` it, merged where one version ends the day before the next begins.
 * The roster routes match each code exactly in upper case. PATRIOTS is left out: it publishes no
 * version and no roster route matches it. Captured 2026-11-13.
 */
const politicalGroups: readonly {
  code: string;
  label: string;
  periods: readonly [Period, ...Period[]];
}[] = [
  { code: 'ALDE', label: 'ALDE', periods: [['2004-07-20', '2019-07-01']] },
  { code: 'ARC', label: 'ARC', periods: [['1984-07-24', '1994-07-18']] },
  { code: 'ARE', label: 'ARE', periods: [['1994-07-19', '1999-07-19']] },
  { code: 'AUCUN', label: 'Aucun', periods: [['1952-02-01', '1954-01-01']] },
  { code: 'C', label: 'C', periods: [['1973-01-16', '1979-07-16']] },
  { code: 'CD', label: 'CD', periods: [['1953-06-23', '1979-07-16']] },
  { code: 'CDI', label: 'CDI', periods: [['1979-07-17', '1984-07-23']] },
  { code: 'CG', label: 'CG', periods: [['1989-07-20', '1994-07-18']] },
  { code: 'COM', label: 'COM', periods: [['1973-10-16', '1989-07-24']] },
  { code: 'CTDI', label: 'CTDI', periods: [['1987-09-17', '1987-11-17']] },
  { code: 'DE', label: 'DE', periods: [['1965-01-20', '1973-07-01']] },
  { code: 'DEP', label: 'DEP', periods: [['1973-07-02', '1984-07-23']] },
  { code: 'DR', label: 'DR', periods: [['1984-07-24', '1994-07-18']] },
  { code: 'ECR', label: 'ECR', periods: [['2009-07-14']] },
  { code: 'ED', label: 'ED', periods: [['1979-07-17', '1992-04-30']] },
  { code: 'EDD', label: 'EDD', periods: [['1999-07-20', '2004-07-19']] },
  { code: 'EDN', label: 'EDN', periods: [['1994-07-19', '1996-11-10']] },
  { code: 'EFD', label: 'EFD', periods: [['2009-07-14', '2014-06-30']] },
  {
    code: 'EFDD',
    label: 'EFDD',
    periods: [
      ['2014-07-01', '2014-10-15'],
      ['2014-10-20', '2019-07-01'],
    ],
  },
  { code: 'ELDR', label: 'ELDR', periods: [['1994-07-19', '2004-07-19']] },
  { code: 'ENF', label: 'ENF', periods: [['2015-06-15', '2019-07-01']] },
  { code: 'ESN', label: 'ESN', periods: [['2024-07-16']] },
  { code: 'FE', label: 'FE', periods: [['1994-07-19', '1995-07-04']] },
  {
    code: 'GUE',
    label: 'GUE',
    periods: [
      ['1989-07-20', '1993-01-11'],
      ['1994-07-19', '1995-01-05'],
    ],
  },
  { code: 'GUE-NGL', label: 'GUE/NGL', periods: [['1995-01-06', '2020-12-17']] },
  { code: 'I-EDN', label: 'I-EDN', periods: [['1997-01-13', '1999-07-19']] },
  { code: 'ID', label: 'ID', periods: [['2019-07-02', '2024-07-15']] },
  { code: 'IND-DEM', label: 'IND/DEM', periods: [['2004-07-20', '2009-07-13']] },
  { code: 'ITS', label: 'ITS', periods: [['2007-01-15', '2007-11-13']] },
  { code: 'L', label: 'L', periods: [['1953-06-20', '1985-12-12']] },
  { code: 'LDR', label: 'LDR', periods: [['1985-12-13', '1994-07-18']] },
  { code: 'NI', label: 'NI', periods: [['1953-06-23']] },
  { code: 'PFE', label: 'PfE', periods: [['2024-07-16']] },
  {
    code: 'PPE',
    label: 'PPE',
    periods: [['1979-07-17', '1999-07-19'], ['2009-07-14']],
  },
  { code: 'PPE-DE', label: 'PPE-DE', periods: [['1999-07-20', '2009-07-13']] },
  { code: 'PSE', label: 'PSE', periods: [['1993-04-21', '2009-07-13']] },
  { code: 'RDE', label: 'RDE', periods: [['1984-07-23', '1995-07-04']] },
  { code: 'RENEW', label: 'Renew', periods: [['2019-07-02']] },
  { code: 'S', label: 'S', periods: [['1953-06-23', '1993-04-20']] },
  { code: 'S-D', label: 'S&D', periods: [['2009-07-14']] },
  { code: 'TDI', label: 'TDI', periods: [['1999-07-20', '2001-10-02']] },
  { code: 'THE-LEFT', label: 'The Left', periods: [['2020-12-18']] },
  { code: 'UEN', label: 'UEN', periods: [['1999-07-20', '2009-07-13']] },
  { code: 'UPE', label: 'UPE', periods: [['1995-07-05', '1999-07-19']] },
  { code: 'V', label: 'V', periods: [['1989-07-19', '1999-07-19']] },
  { code: 'VERTS-ALE', label: 'Verts/ALE', periods: [['1999-07-20']] },
];
/**
 * Canonical input codes copied from the public OpenAPI, plus the published group codes. Country
 * lists GB, not the OpenAPI enum's UK: rosters publish and match United Kingdom members only as GB.
 */
const codes = {
  language: [
    'bg',
    'es',
    'cs',
    'da',
    'de',
    'et',
    'el',
    'en',
    'fr',
    'ga',
    'hr',
    'it',
    'lv',
    'lt',
    'hu',
    'mt',
    'nl',
    'pl',
    'pt',
    'ro',
    'sk',
    'sl',
    'fi',
    'sv',
  ],
  process_type: [
    'ACI',
    'APP',
    'AVC',
    'BUD',
    'CNS',
    'COD',
    'DEC',
    'NLE',
    'SYN',
    'BUI',
    'COS',
    'DEA',
    'DCE',
    'IMM',
    'INI',
    'INL',
    'INS',
    'REG',
    'RPS',
    'RSO',
    'RSP',
    'GBD',
  ],
  country: [
    'BE',
    'BG',
    'CZ',
    'DK',
    'DE',
    'EE',
    'IE',
    'GR',
    'ES',
    'FR',
    'HR',
    'IT',
    'CY',
    'LV',
    'LT',
    'LU',
    'HU',
    'MT',
    'NL',
    'AT',
    'PL',
    'PT',
    'RO',
    'SI',
    'SK',
    'FI',
    'SE',
    'GB',
  ],
  political_group: politicalGroups.map(({ code }) => code),
  gender: ['FEMALE', 'MALE', 'NAP', 'NKN', 'NST'],
  adopted_texts: ['TEXT_ADOPTED', 'AMENDMENT_BUDGET_EU_DRAFT', 'BUDGET_EP_DRAFT'],
  committee: [
    'OPINION_PARLIAMENTARY_COMMITTEE_DRAFT',
    'OPINION_PARLIAMENTARY_COMMITTEE',
    'OPINION_LETTER_PARLIAMENTARY_COMMITTEE',
    'REPORT_PARLIAMENTARY_COMMITTEE_DRAFT',
    'AGREEMENT_PROVISIONAL',
  ],
  plenary: [
    'REPORT_PLENARY',
    'RESOLUTION_MOTION',
    'RESOLUTION_MOTION_JOINT',
    'QUESTION_RESOLUTION_MOTION',
  ],
  question: [
    'QUESTION_WRITTEN_PRIORITY',
    'QUESTION_WRITTEN',
    'QUESTION_ORAL',
    'INTERPELLATION_MAJOR',
    'INTERPELLATION_MINOR',
    'QUESTION_TIME',
  ],
  activity_type: [
    'MEETING_NAME_CHAIR',
    'PROCEEDING_ACTIVITY',
    'PLENARY_DEBATE_SPEECH',
    'PLENARY_DEBATE_WRITTEN_STATEMENT',
    'VOTE_EXPLANATION_ORAL',
  ],
} as const;
/** "a, b and c". */
export const listed = (values: readonly string[]) =>
  new Intl.ListFormat('en', { type: 'conjunction' }).format(values);
/** "1979-07-17 to 1999-07-19 and from 2009-07-14". */
const periodsText = (periods: readonly Period[]) =>
  listed(
    periods.map(([start, end]) => (end === undefined ? `from ${start}` : `${start} to ${end}`)),
  );
function politicalGroup(code: string) {
  const group = politicalGroups.find((candidate) => candidate.code === code);
  if (group === undefined) throw new Error(`No political group record ${code}`);
  return group;
}
/**
 * GUE/NGL is the label of GUE-NGL and ends the published name of THE-LEFT ("The Left group in the
 * European Parliament - GUE/NGL"), so it names two codes. It selects GUE-NGL on terms 0–8 (term 8
 * ended before The Left's first version began) and on dates through the dated roster's last
 * GUE-NGL day, THE-LEFT on the current roster, later dates and term 9 onward; term 9 spans the
 * change.
 */
const sharedLabel = 'GUE/NGL';
const gueNgl = politicalGroup('GUE-NGL');
const theLeft = politicalGroup('THE-LEFT');
/**
 * Last mandate_date the dated roster matches GUE-NGL. Measured 2026-11-13 on
 * `/meps/show-current?mandate-date=`: GUE-NGL returns members on 2020-12-18 and 204 on 2020-12-19,
 * THE-LEFT 204 on 2020-12-18 and members from 2020-12-19. The published version periods (GUE-NGL
 * to 2020-12-17, THE-LEFT from 2020-12-18) put the change a day earlier.
 */
const lastGueNglRosterDay = '2020-12-18';
const firstTheLeftRosterDay = new Date(Date.parse(lastGueNglRosterDay) + 86_400_000)
  .toISOString()
  .slice(0, 10);
/**
 * First mandate_date the dated roster matches GUE-NGL, also a day after its published version
 * start. Measured 2026-11-13: 1995-01-06 returns 204, 1995-01-07 returns 29 members.
 */
const firstGueNglRosterDay = '1995-01-07';
const lastGueNglTerm = 8;
/**
 * The term whose roster holds both codes (measured 2026-11-13: GUE-NGL 42 members, THE-LEFT 46).
 * Term 10 returns no GUE-NGL member and terms 0 and 1 no THE-LEFT member.
 */
const bothCodesTerm = lastGueNglTerm + 1;
const rosterSwitch = `the dated roster switches from ${gueNgl.code} to ${theLeft.code} after ${lastGueNglRosterDay}, a day later than the published versions`;
const twoCodes = `${sharedLabel} names two group codes: ${gueNgl.code} (label ${gueNgl.label}, ${periodsText(gueNgl.periods)}) and ${theLeft.code} (${theLeft.label}, ${periodsText(theLeft.periods)}, whose published name ends in ${sharedLabel}).`;
/** Common names beside the published labels. */
const nameAliases = [
  ['EPP', 'PPE'],
  ['Greens/EFA', 'VERTS-ALE'],
  ['Patriots', 'PFE'],
] as const;
/** Upper-cased query spellings: each label that is not its code in upper case, then the common names. */
const aliases = new Map<string, string>(
  [
    ...politicalGroups.flatMap(({ code, label }) =>
      label.toUpperCase() === code || label === sharedLabel ? [] : [[label, code] as const],
    ),
    ...nameAliases,
  ].map(([spelling, code]) => [spelling.toUpperCase(), code]),
);
/** The roster a political_group code is sent to; only GUE/NGL resolves differently by roster. */
interface GroupRoster {
  mandate_date?: string | undefined;
  term?: number | undefined;
}
function groupCode(upper: string, { term, mandate_date }: GroupRoster): string {
  if (upper !== sharedLabel) return aliases.get(upper) ?? upper;
  const early =
    term !== undefined
      ? term <= lastGueNglTerm
      : mandate_date !== undefined && mandate_date <= lastGueNglRosterDay;
  return early ? gueNgl.code : theLeft.code;
}
const relabelled = politicalGroups.flatMap(({ code, label }) => (label === code ? [] : [label]));
const groupRejection = `Published labels (${relabelled.join(', ')}) and the aliases ${listed(nameAliases.map(([alias]) => alias))} are accepted too, in any case.`;
type CodeFamily = keyof typeof codes;
/** The reference topic listing each family's accepted codes. */
const codeTopics = {
  language: 'identifiers',
  process_type: 'procedure_types',
  country: 'mep_filters',
  political_group: 'mep_filters',
  gender: 'mep_filters',
  adopted_texts: 'document_types',
  committee: 'document_types',
  plenary: 'document_types',
  question: 'question_types',
  activity_type: 'activity_types',
} as const satisfies Record<CodeFamily, ReferenceTopic>;
/**
 * The rejection of `value` (canonical form `canonical`) in `family`, naming the parameter the
 * caller wrote: `work_type` for the four work-type tables, the family name otherwise. A work type
 * another table lists names the source or tool that takes it.
 */
function unsupportedCode(
  value: string,
  canonical: string,
  family: Exclude<CodeFamily, 'political_group'>,
) {
  const workTypes = [...documentFamilies, 'question'] as const;
  const workType = (workTypes as readonly CodeFamily[]).includes(family);
  const parameter = workType ? 'work_type' : family;
  const source = workType && family !== 'question' ? ` for source ${family}` : '';
  const other = workType
    ? workTypes.find(
        (candidate) =>
          candidate !== family && (codes[candidate] as readonly string[]).includes(canonical),
      )
    : undefined;
  const rejected = `Unsupported ${parameter} filter ${JSON.stringify(value)}${source}. Accepted codes: ${codes[family].join(', ')}.`;
  const rejection = (message: string, hint: string) =>
    validationError(message, { reason: 'invalid_filter', field: family, recovery: { hint } });
  if (other === undefined)
    return rejection(
      rejected,
      `Call euparl_list_reference with topic ${codeTopics[family]} for every accepted code, then retry ${parameter} with one of them.`,
    );
  if (other === 'question')
    return rejection(
      `${rejected} ${canonical} is a question work type accepted by euparl_list_questions.`,
      `Call euparl_list_questions with work_type ${canonical}, or call euparl_list_reference with topic document_types for each document work type and its source.`,
    );
  if (family === 'question')
    return rejection(
      `${rejected} ${canonical} is a document work type accepted by euparl_search_documents with source "${other}".`,
      `Call euparl_search_documents with source "${other}" and work_type ${canonical}, or call euparl_list_reference with topic question_types for each question work type.`,
    );
  return rejection(
    `${rejected} ${canonical} is a document work type accepted with source "${other}".`,
    `Retry with source "${other}" and work_type ${canonical}, or call euparl_list_reference with topic document_types for each work type and its source.`,
  );
}
/**
 * Validates only input codes; source output remains unmodified. `roster` is the roster a
 * political_group code is sent to; omitted, it is the current roster.
 */
export function normalizeCode(
  value: string | undefined,
  family: keyof typeof codes,
  roster: GroupRoster = {},
): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let canonical = family === 'language' ? value.trim().toLowerCase() : value.trim().toUpperCase();
  if (family === 'political_group') canonical = groupCode(canonical, roster);
  if (family === 'country' && canonical === 'UK') canonical = 'GB';
  if (!(codes[family] as readonly string[]).includes(canonical)) {
    if (family === 'political_group')
      throw validationError(
        `Unsupported political_group filter ${JSON.stringify(value.trim())}. Accepted codes: ${codes.political_group.join(', ')}. ${groupRejection}`,
        {
          reason: 'invalid_filter',
          field: family,
          recovery: {
            hint: 'Call euparl_list_reference with topic mep_filters for each group code with its label and periods, then retry with one of them.',
          },
        },
      );
    throw unsupportedCode(value.trim(), canonical, family);
  }
  return canonical;
}
/**
 * The notice every GUE/NGL selection carries: the code sent and a route to the other code the
 * label names, worded to hold on an empty result. Only term 9's roster matches both codes; other
 * rosters route the other code to term 9 or to the days the dated roster matches it, and a dated
 * or current roster, which matches only the code in force that day, says it matches no member.
 */
export function politicalGroupNotice(
  value: string | undefined,
  code: string | undefined,
  roster: GroupRoster = {},
): string | undefined {
  if (code === undefined || value?.trim().toUpperCase() !== sharedLabel) return undefined;
  const other = code === gueNgl.code ? theLeft.code : gueNgl.code;
  if (roster.term === bothCodesTerm)
    return `${twoCodes} This call sent ${code}; to select the other group, pass political_group ${other}.`;
  const days = `${other === gueNgl.code ? `from ${firstGueNglRosterDay} through ${lastGueNglRosterDay}` : `from ${firstTheLeftRosterDay}`} (the dated roster runs a day later than the published versions)`;
  return roster.term !== undefined
    ? `${twoCodes} This call sent ${code}; to select the other group, pass political_group ${other} with term ${bothCodesTerm}, whose roster holds both codes, or with a mandate_date ${days}.`
    : `${twoCodes} This call sent ${code}. A mandate_date or current roster matches only the code in force that day, so ${other} matches no member here; to select it, pass political_group ${other} with a mandate_date ${days} or with term ${bothCodesTerm}.`;
}
const documentFamilies = ['adopted_texts', 'committee', 'plenary'] as const;
/**
 * The document family whose work-type table lists a published work type, matched on its last path
 * segment (`def/ep-document-types/TEXT_ADOPTED`); undefined outside the three families.
 */
export function documentFamily(workType: string | undefined) {
  const code = workType?.slice(workType.lastIndexOf('/') + 1) ?? '';
  return documentFamilies.find((family) => (codes[family] as readonly string[]).includes(code));
}
/** Reference topics supported by the nine-tool surface. */
export const referenceTopics = [
  'committees',
  'political_groups',
  'organizations',
  'procedure_types',
  'document_types',
  'question_types',
  'activity_types',
  'mep_filters',
  'identifiers',
  'coverage',
] as const;
export type ReferenceTopic = (typeof referenceTopics)[number];
/** Flat reference record; live bodies add their published identity/classification. */
export interface ReferenceEntry {
  classification?: string;
  code: string;
  description?: string;
  end_date?: string;
  found?: boolean;
  id?: string;
  label?: LocalizedText;
  name?: LocalizedText;
  organization_id?: string;
  source_url?: string;
  start_date?: string;
}
const pageCapList = Object.values(pageCaps)
  .filter(({ maximum }) => maximum < Number.MAX_SAFE_INTEGER)
  .map(({ maximum, noun }) => `${maximum} ${noun}`)
  .join(', ');
/**
 * First sitting with published decision records, as YYYY-MM-DD. Measured on
 * `/meetings/{id}/decisions` (2026-11): every 2018 sitting probed (07-04, 11-14, 12-10 to 12-13)
 * and older ones (2014-11-26, 2017-12-13) return 404; 2019-01-14 returns one decision. Later
 * early-2019 sittings are sparse (2019-01-15 to 01-31, 02-12, 02-13, 03-13 and 03-26 return 404).
 */
export const firstDecisionSitting = '2019-01-14';
/**
 * How a decision label writes a document identifier, for `label_contains`. Measured 2026-11-13 on
 * the 2022-05-04 and 2022-05-05 decisions: every A-, B- and C- vote-item document that labels cite
 * appears as prefix and term joined, then number/year (A-9-2022-0116 as A9-0116/2022, matching only
 * DEC-141985; B-9-2022-0228 as B9-0228/2022; C-9-2022-0054 as C9-0054/2022), and the joint motion
 * RC-9-2022-0257 as RC-B9-0257/2022. The RC- record publishes no label, so the rule, not a document
 * get, is the route for that family.
 */
export const labelCitation =
  'a document_ids entry is cited with its prefix and term joined and the year after the number, so A-9-2022-0116 is A9-0116/2022 and the joint motion RC-9-2022-0257 is RC-B9-0257/2022';
/** Static tables have no upstream totals or snapshot requirement. */
export function referenceEntries(
  topic: Exclude<ReferenceTopic, 'committees' | 'political_groups' | 'organizations'>,
): ReferenceEntry[] {
  const rows = (values: readonly string[], description: string) =>
    values.map((code) => ({ code, description }));
  switch (topic) {
    case 'procedure_types':
      return rows(codes.process_type, 'Procedure type; case-insensitive input.');
    case 'document_types':
      return [
        ...rows(codes.adopted_texts, 'adopted_texts family; case-insensitive input.'),
        ...rows(codes.committee, 'committee family; case-insensitive input.'),
        ...rows(codes.plenary, 'plenary family; case-insensitive input.'),
      ];
    case 'question_types':
      return rows(codes.question, 'Question work type; case-insensitive input.');
    case 'activity_types':
      return rows(
        codes.activity_type,
        'Speech activity type; case-insensitive input; search supports terms 9 and 10 without guaranteeing every activity type is published in both.',
      );
    case 'mep_filters':
      return [
        ...rows(
          codes.country,
          'country; ISO alpha-2; case-insensitive input; UK→GB, the code Parliament publishes and matches for United Kingdom members, on historical rosters only.',
        ),
        ...politicalGroups.map(({ code, label, periods }) => {
          const spellings = [
            ...(label === code || label === sharedLabel ? [] : [label]),
            ...nameAliases.flatMap(([alias, target]) => (target === code ? [alias] : [])),
          ];
          const shared =
            code === gueNgl.code
              ? `; ${sharedLabel} selects it on terms 0–${lastGueNglTerm} and dates through ${lastGueNglRosterDay}; ${rosterSwitch}`
              : code === theLeft.code
                ? `; ${sharedLabel} selects it on term ${bothCodesTerm} and later, the current roster and dates after ${lastGueNglRosterDay}; ${rosterSwitch}`
                : '';
          return {
            code,
            label: { value: label, language: 'mul' },
            description: `political_group; versions ${periodsText(periods)}; case-insensitive code${spellings.length ? `, also ${listed(spellings)}` : ''}${shared}. On mandate_date rosters a code matches only members published under it on that date, and on the current roster only members holding it today; on a term roster it matches each member of the term holding a membership in it that had not ended when the term began, later memberships included. Query aliases never rewrite historical organization identities.`,
          };
        }),
        ...rows(codes.gender, 'gender; case-insensitive input.'),
      ];
    case 'identifiers':
      return [
        {
          code: 'procedure',
          description:
            'YYYY-NNNN[A-Z] or YYYY/NNNN[A-Z], optional (TYPE); exact https://data.europarl.europa.eu/eli/dl/proc/ URI.',
        },
        {
          code: 'document',
          description:
            'Canonical document identifier (TA-9-2024-0138), eli/dl/doc/ prefix, or exact public document URI, in any letter case; or a citation the tools return, term t, year y, four-digit number n: T{t}-{n}/{y} or P{t}_TA({y}){n} (adopted text TA-{t}-{y}-{n}), A{t}-{n}/{y} or P{t}_A({y}){n} (report A-), RC-B{t}-{n}/{y} (joint motion RC-), B{t}-{n}/{y} (motion B-; document get reads the QOB- question motion when no B- record exists, the plenary-vote filter reads B- only), P{t}_OJQ({y}){mm-dd} (agenda OJQ-{t}-{y}-{mm-dd}). Committee labels such as AD-PE786.674 are not identifiers; question citations go to euparl_list_questions.',
        },
        {
          code: 'person',
          description: 'Decimal person ID, person/ prefix, or exact public person URI.',
        },
        {
          code: 'organization',
          description:
            'Decimal ID or case-sensitive code (IMCO, S-D, ep-9, EU_PARLIAMENT): letters, digits, hyphens and underscores, bare, after org/, or in the exact https://data.europarl.europa.eu/org/ URI. Resolve organizations from memberships, procedure participants, document creators and terms with topic organizations and organization_ids; labels such as S&D are not identifiers. EU authority URIs (http://publications.europa.eu/resource/authority/corporate-body/…) are not accepted, and question addressee_ids do not resolve here: COM is the Communist and Allies Group, and EU_COMMISSION, EU_COUNCIL and HRVP return no name. A question alternative_title names its addressee in words.',
        },
        {
          code: 'activity',
          description:
            'Canonical activity ID, eli/dl/event/ prefix, or exact public event URI; sitting accepts YYYY-MM-DD.',
        },
        {
          code: 'question',
          description:
            'E-term-year-six-digit-sequence, known document prefix/public URI, or E-sequence/year citation; E, P, O, G and K prefixes are case-insensitive and one-to-six-digit sequences are padded to six. Omitted term verifies canonical candidates for all overlapping terms, including both adjacent terms in election years.',
        },
        ...rows(
          codes.language,
          'language; supported EU ISO-639-1; case-insensitive input; default en.',
        ),
      ];
    case 'coverage':
      return [
        {
          code: 'source',
          description:
            'European Parliament Open Data; https://data.europarl.europa.eu/ ; CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ ; identifiers and record structure normalized; no endorsement implied.',
        },
        {
          code: 'documents',
          description:
            'Only adopted texts support keyword document search. Committee filters are unavailable. Files are linked, never downloaded or parsed.',
        },
        {
          code: 'speeches',
          description:
            'Ninth- and tenth-term speech metadata and source links; search defaults to term 10. Term-9 records start in July 2021; earlier term-9 sitting dates return none. Published labels are not transcripts; include_text returns the text Parliament publishes for each speech in the selected language only, with no fallback, and at most 100 search rows per call. Term-10 machine-translated blocks are tagged {source}-t-{target}-mtec, while term-9 translations carry only the target code, so original_languages says whose words a text is. Coverage is not guaranteed for other terms.',
        },
        {
          code: 'meps',
          description:
            "Omit term and mandate_date for members in office today; term selects that published term roster; mandate_date YYYY-MM-DD, not after today (UTC) and exclusive with term, selects members seated that day with country and group as published then. A term's first sitting day can return an incomplete roster or an upstream error; use the following day. Names filter locally over the complete roster.",
        },
        {
          code: 'votes',
          description: `Discover sittings, list the vote items of a sitting or page its compact decisions, read a rich decision, then page recorded or intended positions. Sittings data starts in 2014; earlier years return no sittings. Vote items carry titles, report documents and procedures from 2014; through 2023 their titles are published in French (some also in a combined mul text) and they publish no decision links, so decision_count is absent and vote_item_id selects none of their decisions. Decision records start with the ${firstDecisionSitting} sitting: earlier sittings list but return no decisions, and not every later sitting has them. Names require explicit roster_term and reflect that published roster, never historical affiliation.`,
        },
        {
          code: 'paging',
          description: `Acquisition bounds: ${pageCapList}. Whole-acquired local collections, including process_type procedures and static reference tables, return the requested count or remaining rows without an output-size cap. Limits above the safe-integer range normalize to 9007199254740991. A larger bounded-mode limit narrows with a notice; EUPARL_CLAMP_LIMITS=false rejects values above a tool's largest bound only when all its modes are bounded, adopted texts counting their ${searchResultWindow}-result search window as that bound while still returning ${pageCaps.adopted_documents.maximum}-row pages. Organization lookups page supplied IDs without a snapshot. Non-keyword adopted texts use doc-id:asc; speeches use sitting-date:asc,numbering:asc; both acquire aligned 100-row pages independently of caller geometry within one deadline. Keyword searches retain relevance order and can repeat or omit records. Speeches, adopted texts and unfiltered procedures expose a 10000-result window; limits narrow to remaining results and offsets of 10000 or more fail. Capped totals are lower bounds; has_more can remain true without next_offset at the window. Unfiltered procedures can repeat or omit records; process_type listings are acquired whole and sorted by procedure_id with optional snapshot. Other local continuation requires the snapshot; drift fails snapshot_changed before slicing. Past-end local pages disclose the exact collection size. No retained cache.`,
        },
        {
          code: 'questions',
          description:
            'Human question citations without term verify direct canonical candidates for overlapping terms: term 0 before 1979, five-year elected terms from 1979, and latest supported term 10 for later years. Election years check both adjacent terms and may be ambiguous; supply term to disambiguate. Missing answer links do not prove unanswered status.',
        },
      ];
  }
}
