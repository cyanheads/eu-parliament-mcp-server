/**
 * @fileoverview Supported Parliament query codes and offline reference records.
 * @module services/eu-parliament/eu-parliament-reference
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Canonical input codes copied from the public OpenAPI, plus verified group tokens. */
export const codes = {
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
    'UK',
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
  ['S&D', 'S-D'],
  ['VERTS/ALE', 'VERTS-ALE'],
  ['THE LEFT', 'THE-LEFT'],
]);
/** Validates only input codes; source output remains unmodified. */
export function normalizeCode(
  value: string | undefined,
  family: keyof typeof codes,
): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let canonical = family === 'language' ? value.trim().toLowerCase() : value.trim().toUpperCase();
  if (family === 'political_group') canonical = aliases.get(canonical) ?? canonical;
  if (!(codes[family] as readonly string[]).includes(canonical))
    throw validationError(`Unsupported ${family} filter. Consult euparl_list_reference.`, {
      reason: 'invalid_filter',
      field: family,
    });
  return canonical;
}
/** Reference topics supported by the nine-tool surface. */
export type ReferenceTopic =
  | 'committees'
  | 'political_groups'
  | 'procedure_types'
  | 'document_types'
  | 'question_types'
  | 'activity_types'
  | 'mep_filters'
  | 'identifiers'
  | 'coverage';
/** Flat reference record; live bodies add their published identity/classification. */
export interface ReferenceEntry {
  classification?: string;
  code: string;
  description?: string;
  id?: string;
  label?: { language: string; value: string };
}
/** Static tables have no upstream totals or snapshot requirement. */
export function referenceEntries(
  topic: Exclude<ReferenceTopic, 'committees' | 'political_groups'>,
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
        'Speech activity type; case-insensitive input; tenth term only.',
      );
    case 'mep_filters':
      return [
        ...rows(codes.country, 'country; ISO alpha-2; case-insensitive input; UK is historical.'),
        ...codes.political_group.map((code) => ({
          code,
          description: `political_group; ${['PFE', 'ESN'].includes(code) ? 'observed in live API' : 'documented by OpenAPI'}; case-insensitive; aliases S&D→S-D, Verts/ALE→VERTS-ALE, The Left→THE-LEFT, Renew→RENEW, PfE→PFE.`,
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
          code: 'activity',
          description:
            'Canonical activity ID, eli/dl/event/ prefix, or exact public event URI; sitting accepts YYYY-MM-DD.',
        },
        {
          code: 'question',
          description:
            'E-term-year-six-digit-sequence (also P/O), or E-six-digit-sequence/year citation; term avoids a full year lookup.',
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
            'Tenth-term speech metadata and source links; published labels are not transcripts.',
        },
        {
          code: 'votes',
          description:
            'Discover sittings, page compact decisions, read a rich decision, then page recorded or intended positions. Names require explicit roster_term and reflect that published roster, never historical affiliation.',
        },
        {
          code: 'paging',
          description:
            'Effective limit 100. Local continuation requires returned snapshot; collection is reacquired and drift causes snapshot_changed. No retained cache.',
        },
        {
          code: 'questions',
          description:
            'Human question citations without term require complete year traversal; election years may be ambiguous. Missing answer links do not prove unanswered status.',
        },
      ];
  }
}
