/**
 * @fileoverview Supported Parliament query codes and offline reference records.
 * @module services/eu-parliament/eu-parliament-reference
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { type LocalizedText, pageCaps } from './eu-parliament-normalization.js';

/**
 * Canonical input codes copied from the public OpenAPI, plus verified group tokens. Country lists
 * GB, not the OpenAPI enum's UK: rosters publish and match United Kingdom members only as GB.
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
  political_group: [
    'PPE',
    'NI',
    'S-D',
    'VERTS-ALE',
    'ECR',
    'RENEW',
    'THE-LEFT',
    'ID',
    'PFE',
    'ESN',
  ],
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
const aliases = new Map([
  ['EPP', 'PPE'],
  ['S&D', 'S-D'],
  ['VERTS/ALE', 'VERTS-ALE'],
  ['GREENS/EFA', 'VERTS-ALE'],
  ['THE LEFT', 'THE-LEFT'],
  ['GUE/NGL', 'THE-LEFT'],
  ['PATRIOTS', 'PFE'],
]);
/** Validates only input codes; source output remains unmodified. */
export function normalizeCode(
  value: string | undefined,
  family: keyof typeof codes,
): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let canonical = family === 'language' ? value.trim().toLowerCase() : value.trim().toUpperCase();
  if (family === 'political_group') canonical = aliases.get(canonical) ?? canonical;
  if (family === 'country' && canonical === 'UK') canonical = 'GB';
  if (!(codes[family] as readonly string[]).includes(canonical)) {
    const guidance =
      family === 'country' || family === 'political_group' || family === 'gender'
        ? `Accepted codes: ${codes[family].join(', ')}.`
        : 'Consult euparl_list_reference.';
    throw validationError(`Unsupported ${family} filter. ${guidance}`, {
      reason: 'invalid_filter',
      field: family,
    });
  }
  return canonical;
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
        ...codes.political_group.map((code) => ({
          code,
          description: `political_group; ${['PFE', 'ESN'].includes(code) ? 'observed in live API' : 'documented by OpenAPI'}; case-insensitive; aliases EPP→PPE, S&D→S-D, Verts/ALE and Greens/EFA→VERTS-ALE, The Left and GUE/NGL→THE-LEFT, Renew→RENEW, PfE and Patriots→PFE. Query aliases never rewrite historical organization identities. On mandate_date rosters a code matches only members published under it on that date.`,
        })),
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
            'Canonical document identifier, eli/dl/doc/ prefix, or exact public document URI.',
        },
        {
          code: 'person',
          description: 'Decimal person ID, person/ prefix, or exact public person URI.',
        },
        {
          code: 'organization',
          description:
            'Decimal ID or case-sensitive code (IMCO, S-D, ep-9, EU_PARLIAMENT): letters, digits, hyphens and underscores, bare, after org/, or in the exact https://data.europarl.europa.eu/org/ URI. Resolve organizations from memberships, procedure participants, document creators and terms with topic organizations and organization_ids; labels such as S&D are not identifiers.',
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
            'Ninth- and tenth-term speech metadata and source links; search defaults to term 10. Term-9 records start in July 2021; earlier term-9 sitting dates return none. Published labels are not transcripts; coverage is not guaranteed for other terms.',
        },
        {
          code: 'meps',
          description:
            "Omit term and mandate_date for members in office today; term selects that published term roster; mandate_date YYYY-MM-DD, not after today (UTC) and exclusive with term, selects members seated that day with country and group as published then. A term's first sitting day can return an incomplete roster or an upstream error; use the following day. Names filter locally over the complete roster.",
        },
        {
          code: 'votes',
          description:
            'Discover sittings, page compact decisions, read a rich decision, then page recorded or intended positions. Sittings data starts in 2014; earlier years return no sittings. Decisions start in 2019: 2014–2018 sittings list but return no decisions, and not every later sitting has them. Names require explicit roster_term and reflect that published roster, never historical affiliation.',
        },
        {
          code: 'paging',
          description: `Acquisition bounds: ${pageCapList}. Whole-acquired local collections, including process_type procedures and static reference tables, return the requested count or remaining rows without an output-size cap. Limits above the safe-integer range normalize to 9007199254740991. A larger bounded-mode limit narrows with a notice; EUPARL_CLAMP_LIMITS=false rejects values above a tool's largest bound only when all its modes are bounded. Organization lookups page supplied IDs without a snapshot. Non-keyword adopted texts use doc-id:asc; speeches use sitting-date:asc,numbering:asc; both acquire aligned 100-row pages independently of caller geometry within one deadline. Keyword searches retain relevance order and can repeat or omit records. Speeches, adopted texts and unfiltered procedures expose a 10000-result window; limits narrow to remaining results and offsets of 10000 or more fail. Capped totals are lower bounds; has_more can remain true without next_offset at the window. Unfiltered procedures can repeat or omit records; process_type listings are acquired whole and sorted by procedure_id with optional snapshot. Other local continuation requires the snapshot; drift fails snapshot_changed before slicing. Past-end local pages disclose the exact collection size. No retained cache.`,
        },
        {
          code: 'questions',
          description:
            'Human question citations without term verify direct canonical candidates for overlapping terms: term 0 before 1979, five-year elected terms from 1979, and latest supported term 10 for later years. Election years check both adjacent terms and may be ambiguous; supply term to disambiguate. Missing answer links do not prove unanswered status.',
        },
      ];
  }
}
