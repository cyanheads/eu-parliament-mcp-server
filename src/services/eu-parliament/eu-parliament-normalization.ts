/**
 * @fileoverview Canonical identifiers and lossless selected-language domain records.
 * @module services/eu-parliament/eu-parliament-normalization
 */
import { createHash } from 'node:crypto';
import { conflict, serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type {
  RawAdoptedTextRow,
  RawDecision,
  RawDocument,
  RawMep,
  RawParticipation,
  RawProcedure,
  RawQuestion,
  RawSpeech,
  RawVoteItem,
} from './eu-parliament-schemas.js';

const publicOrigin = 'https://data.europarl.europa.eu/';
/** Published value with its actual language. */
export interface LocalizedText {
  language: string;
  value: string;
}
/** File metadata; source byte sizes retain their decimal string encoding. */
export interface Link {
  issued?: string;
  language?: string;
  media_type?: string;
  size_bytes?: string;
  url: string;
}
/** Whole-item paging; snapshot is present for reacquired local collections. */
export interface Page {
  has_more: boolean;
  limit: number;
  next_offset?: number;
  offset: number;
  returned: number;
  snapshot?: string;
}
/** Shared input accepted by paged operations. */
export interface Paging {
  language?: string;
  limit?: number;
  offset?: number;
  snapshot?: string;
}
/** Scalar omission preserves source uncertainty. */
export function field<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}
const nounPrefixes = {
  document: 'eli/dl/doc/',
  person: 'person/',
  organization: 'org/',
  activity: 'eli/dl/event/',
  procedure: 'eli/dl/proc/',
};
type Noun = keyof typeof nounPrefixes;
type Reference = string | { id: string };
/** Each noun's name and accepted input forms, as a caller rejection states them. */
export const nounForms: Record<Noun, { name: string; forms: string }> = {
  document: {
    name: 'a document identifier',
    forms: `a canonical identifier of letters, digits, hyphens and underscores, bare, after ${nounPrefixes.document}, or in the exact ${publicOrigin}${nounPrefixes.document} URI`,
  },
  person: {
    name: 'a person identifier',
    forms: `a decimal person ID (124867), ${nounPrefixes.person}124867, or ${publicOrigin}${nounPrefixes.person}124867`,
  },
  organization: {
    name: 'an organization identifier',
    forms: `a decimal ID (5144) or a case-sensitive code of letters, digits, hyphens and underscores (IMCO, S-D, ep-9, EU_PARLIAMENT), bare, after ${nounPrefixes.organization}, or in the exact ${publicOrigin}${nounPrefixes.organization} URI; labels such as S&D are not identifiers`,
  },
  activity: {
    name: 'an activity identifier',
    forms: `a canonical identifier of letters, digits, hyphens and underscores, bare, after ${nounPrefixes.activity}, or in the exact ${publicOrigin}${nounPrefixes.activity} URI`,
  },
  procedure: {
    name: 'a procedure identifier',
    forms: `YYYY-NNNN or YYYY/NNNN with an optional letter suffix and (TYPE), such as 2021-0106 or 2021/0106(COD), bare, after ${nounPrefixes.procedure}, or in the exact ${publicOrigin}${nounPrefixes.procedure} URI`,
  },
};
/** A caller-supplied identifier: the parameter as the caller wrote it, and the next call to make. */
export interface IdInput {
  hint: string;
  parameter: string;
}
/** Trims the value and strips a leading public origin, then the noun's prefix, once each. */
function withoutPrefixes(value: string, noun: Noun): string {
  let id = value.trim();
  if (id.startsWith(publicOrigin)) id = id.slice(publicOrigin.length);
  if (id.startsWith(nounPrefixes[noun])) id = id.slice(nounPrefixes[noun].length);
  return id;
}
/**
 * Strips only a verified public URI and known noun prefix. Organizations accept decimal IDs and
 * Parliament's case-sensitive codes (`IMCO`, `S-D`, `ep-9`, `EU_PARLIAMENT`) without rewriting case.
 * With `input`, a malformed value fails `invalid_filter` naming that parameter; without it the value
 * came from a Parliament record, so it fails as a serialization failure naming no parameter.
 */
export function canonicalId(value: string, noun: Noun, input?: IdInput): string {
  const id = withoutPrefixes(value, noun);
  if (noun === 'procedure') {
    const match = /^(\d{4})[-/](\d{4}[A-Z]?)(?:\(([A-Z]+)\))?$/.exec(id);
    if (match) return `${match[1]}-${match[2]}`;
  } else if (noun === 'person' ? /^\d+$/.test(id) : /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    return id;
  throw input
    ? validationError(
        `${input.parameter} ${JSON.stringify(value)} is not ${nounForms[noun].name}. Accepted forms: ${nounForms[noun].forms}.`,
        { reason: 'invalid_filter', recovery: { hint: input.hint } },
      )
    : serializationError(
        `Parliament returned a record with a malformed ${noun} identifier ${JSON.stringify(value)}.`,
        { retryable: false },
      );
}
/**
 * Citations the tools return beside document identifiers (labels, register references, decision
 * labels), each with the identifier prefixes it can name in reading order. B- motions and QOB-
 * question motions share one number series and both carry B labels.
 */
const documentCitations: readonly (readonly [RegExp, readonly [string, ...string[]]])[] = [
  [/^T(?<term>\d{1,2})-(?<number>\d{4})\/(?<year>\d{4})$/, ['TA']],
  [/^P(?<term>\d{1,2})_TA\((?<year>\d{4})\)(?<number>\d{4})$/, ['TA']],
  [/^A(?<term>\d{1,2})-(?<number>\d{4})\/(?<year>\d{4})$/, ['A']],
  [/^P(?<term>\d{1,2})_A\((?<year>\d{4})\)(?<number>\d{4})$/, ['A']],
  [/^RC-B(?<term>\d{1,2})-(?<number>\d{4})\/(?<year>\d{4})$/, ['RC']],
  [/^B(?<term>\d{1,2})-(?<number>\d{4})\/(?<year>\d{4})$/, ['B', 'QOB']],
  [/^P(?<term>\d{1,2})_OJQ\((?<year>\d{4})\)(?<number>\d{2}-\d{2})$/, ['OJQ']],
];
const documentForms =
  'Pass a canonical identifier such as TA-9-2024-0138, in any letter case, bare, after eli/dl/doc/ or in the exact https://data.europarl.europa.eu/eli/dl/doc/ URI, or a citation: T9-0138/2024 or P9_TA(2024)0138 (adopted text), A9-0188/2023 or P9_A(2023)0188 (report), B9-0163/2024 (motion or question motion), RC-B9-0163/2024 (joint motion), P9_OJQ(2024)03-13 (agenda).';
/**
 * Canonical identifiers a caller's `document_id` names, in reading order: the identifier folded to
 * upper case, or what its citation maps to (a B citation names B- first, then QOB-). Every
 * published document identifier is upper case and `/documents/{id}` is case-sensitive, so folding
 * input never breaks a returned identifier; records keep their published case through
 * `canonicalId`, which this never replaces.
 */
export function documentInputIds(value: string): [string, ...string[]] {
  const id = withoutPrefixes(value, 'document').toUpperCase();
  for (const [pattern, [first, ...rest]] of documentCitations) {
    const groups = pattern.exec(id)?.groups;
    if (!groups) continue;
    const cite = (prefix: string) => `${prefix}-${groups.term}-${groups.year}-${groups.number}`;
    return [cite(first), ...rest.map(cite)];
  }
  if (/^[A-Z0-9][A-Z0-9_-]*$/.test(id)) return [id];
  throw validationError(
    `document_id ${JSON.stringify(value)} is not a document identifier or citation. ${documentForms}`,
    {
      reason: 'invalid_filter',
      recovery: {
        hint: 'Call euparl_search_documents in search mode for canonical document_id values, then retry; pass a question citation such as E-000003/2025 to euparl_list_questions as question_id.',
      },
    },
  );
}
/** Public linked identity; never an API download route. */
export function sourceUrl(id: string): string {
  return new URL(id, publicOrigin).href;
}
/** Published relations arrive as a singleton or an array; order is preserved. */
function toArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function references(value: Reference | Reference[] | undefined): string[] {
  return toArray(value).map((item) => (typeof item === 'string' ? item : item.id));
}
function canonicalIds(value: Reference | Reference[] | undefined, noun: Noun): string[] {
  return references(value).map((id) => canonicalId(id, noun));
}
/** Canonical IDs of a relation's `eli/dl/proc/` entries in published order; other nouns drop out. */
export function procedureIds(value: Reference | Reference[] | undefined): string[] {
  return canonicalIds(
    references(value).filter(
      (id) => id.startsWith('eli/dl/proc/') || id.startsWith(`${publicOrigin}eli/dl/proc/`),
    ),
    'procedure',
  );
}
/** Published activity identifier, else the canonical form of the record URI. */
export function activityId(raw: { id: string; activity_id?: string | undefined }): string {
  return raw.activity_id ?? canonicalId(raw.id, 'activity');
}
/** Requested language, then English, then the first published language in sort order. */
function selectLanguage(available: readonly string[], language: string): string | undefined {
  return available.includes(language)
    ? language
    : available.includes('en')
      ? 'en'
      : available.toSorted()[0];
}
/** Select requested language, English, then the first available source key. */
export function localized(
  map: Record<string, string> | undefined,
  language: string,
  notices: string[],
): LocalizedText | undefined {
  if (!map) return undefined;
  const selected = selectLanguage(Object.keys(map), language);
  if (selected === undefined) return undefined;
  if (selected !== language)
    notices.push(
      `Requested language ${language} unavailable; returned published ${selected} text.`,
    );
  const value = map[selected];
  if (value === undefined) throw new Error('Selected localization is missing');
  return { value, language: selected };
}
/** Source-language choice is based on expression IDs, preserving every matching manifestation. */
export function documentLinks(raw: RawDocument, language: string, notices: string[]): Link[] {
  const expressions = raw.is_realized_by ?? [];
  const languageOf = (id: string) => id.slice(id.lastIndexOf('/') + 1);
  const selected = selectLanguage(
    [...new Set(expressions.map(({ id }) => languageOf(id)))],
    language,
  );
  if (!selected) return [];
  if (selected !== language)
    notices.push(
      `Requested file language ${language} unavailable; returned published ${selected} files.`,
    );
  return expressions
    .filter((expression) => languageOf(expression.id) === selected)
    .flatMap((expression) =>
      (expression.is_embodied_by ?? []).flatMap((manifestation) =>
        references(manifestation.is_exemplified_by).map((url) => ({
          url: sourceUrl(url),
          language: selected,
          ...field('media_type', manifestation.media_type),
          ...field('issued', manifestation.issued),
          ...field('size_bytes', manifestation.byteSize),
        })),
      ),
    );
}
/** Sparse discovery row. */
export function normalizeDocumentSummary(raw: RawDocument) {
  return {
    document_id: canonicalId(raw.identifier ?? raw.id, 'document'),
    ...field('identifier', raw.identifier),
    ...field('label', raw.label),
    ...field('work_type', raw.work_type),
    source_url: sourceUrl(raw.id),
  };
}
/**
 * Adopted-text search row: the sparse identity plus the title in the requested language (the list
 * publishes no other, so a row without it has none), the date, and the procedures its family
 * relation names, as detail reads them.
 */
export function normalizeAdoptedTextRow(raw: RawAdoptedTextRow, language: string) {
  const title = raw.title_dcterms?.[language];
  return {
    ...normalizeDocumentSummary(raw),
    ...field('title', title === undefined ? undefined : { value: title, language }),
    ...field('date', raw.document_date),
    procedure_ids: procedureIds(raw.inverse_created_a_realization_of),
  };
}
/**
 * Generic work detail preserves only explicitly published relations. `familyProcedureIds` come
 * from the family record and follow the generic record's own, without repeats.
 */
export function normalizeDocument(
  raw: RawDocument,
  language: string,
  notices: string[],
  familyProcedureIds: string[] = [],
) {
  const expressionTitles: Record<string, string> = Object.create(null);
  for (const expression of raw.is_realized_by ?? [])
    Object.assign(expressionTitles, expression.title);
  const maps = raw.title_dcterms ?? expressionTitles;
  return {
    ...normalizeDocumentSummary(raw),
    ...field('title', localized(maps, language, notices)),
    ...field('date', raw.document_date),
    ...field('term_id', raw.parliamentary_term),
    creator_ids: references(raw.creator),
    procedure_ids: [
      ...new Set([
        ...procedureIds(raw.refers_to),
        ...procedureIds(raw.is_about),
        ...familyProcedureIds,
      ]),
    ],
    parent_document_ids: canonicalIds(raw.is_part_of, 'document'),
    adopted_document_ids: canonicalIds(raw.adopts, 'document'),
    based_on_document_ids: canonicalIds(raw.based_on, 'document'),
    ...field('public_register_ref', raw.notation_publicRegister),
    links: documentLinks(raw, language, notices),
  };
}
const languageAuthority = 'http://publications.europa.eu/resource/authority/language/';
/** ISO 639-1 codes of the 24 EU languages, keyed by Parliament's language authority code. */
const isoLanguages = new Map([
  ['BUL', 'bg'],
  ['CES', 'cs'],
  ['DAN', 'da'],
  ['DEU', 'de'],
  ['ELL', 'el'],
  ['ENG', 'en'],
  ['EST', 'et'],
  ['FIN', 'fi'],
  ['FRA', 'fr'],
  ['GLE', 'ga'],
  ['HRV', 'hr'],
  ['HUN', 'hu'],
  ['ITA', 'it'],
  ['LAV', 'lv'],
  ['LIT', 'lt'],
  ['MLT', 'mt'],
  ['NLD', 'nl'],
  ['POL', 'pl'],
  ['POR', 'pt'],
  ['RON', 'ro'],
  ['SLK', 'sk'],
  ['SLV', 'sl'],
  ['SPA', 'es'],
  ['SWE', 'sv'],
]);
/**
 * Published `originalLanguage` values (`…/authority/language/ITA`) as ISO 639-1 codes in published
 * order; a value outside the 24-language table is passed through verbatim.
 */
export function originalLanguages(values: string | string[] | undefined): string[] {
  return toArray(values).map(
    (value) =>
      (value.startsWith(languageAuthority)
        ? isoLanguages.get(value.slice(languageAuthority.length))
        : undefined) ?? value,
  );
}
const addresseeRole = 'def/ep-roles/ADDRESSEE';
/**
 * Embedded answer metadata is returned without individual answer requests. Addressees are the
 * organizations of participations whose role includes ADDRESSEE, verbatim and in published order;
 * an organization participation without a role is never read as one.
 */
export function normalizeQuestion(raw: RawQuestion, language: string, notices: string[]) {
  const document = normalizeDocument(raw, language, notices);
  const alternativeTitles: Record<string, string> = Object.create(null);
  for (const expression of raw.is_realized_by ?? [])
    Object.assign(alternativeTitles, expression.title_alternative);
  return {
    question_id: document.document_id,
    ...field('title', document.title),
    ...field('alternative_title', localized(alternativeTitles, language, notices)),
    ...field('date', document.date),
    ...field('work_type', document.work_type),
    ...field('term_id', document.term_id),
    creator_ids: document.creator_ids,
    addressee_ids: toArray(raw.workHadParticipation)
      .filter((participation) => toArray(participation.participation_role).includes(addresseeRole))
      .flatMap((participation) => references(participation.had_participant_organization)),
    original_languages: originalLanguages(raw.originalLanguage),
    links: document.links,
    answers: (raw.inverse_answers_to ?? []).map((answer) =>
      typeof answer === 'string'
        ? { document_id: canonicalId(answer, 'document'), links: [] }
        : {
            document_id: canonicalId(answer.identifier ?? answer.id, 'document'),
            ...field('date', answer.document_date),
            links: documentLinks(answer, language, notices),
          },
    ),
    source_url: document.source_url,
  };
}
/** Identity only; no contact, birthday, or image fields enter the domain. */
export function normalizeMep(raw: RawMep) {
  return {
    mep_id: canonicalId(raw.identifier ?? raw.id, 'person'),
    ...field('name', raw.label),
    ...field('given_name', raw.givenName),
    ...field('family_name', raw.familyName),
    ...field('country', raw['api:country-of-representation']),
    ...field('political_group', raw['api:political-group']),
  };
}
/** Code-unit order, independent of locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Dated records ascending, undated after them, then by id, then by the whole record: a total order. */
function timelineOrder(a: { id: string; date?: string }, b: { id: string; date?: string }): number {
  return (
    Number(a.date === undefined) - Number(b.date === undefined) ||
    compareText(a.date ?? '', b.date ?? '') ||
    compareText(a.id, b.id) ||
    compareText(JSON.stringify(a), JSON.stringify(b))
  );
}
/** Historical participation fields are never joined to current membership. */
function normalizeParticipant(raw: RawParticipation) {
  return {
    id: raw.id,
    person_ids: canonicalIds(raw.had_participant_person, 'person').toSorted(),
    organization_ids: references(raw.had_participant_organization).toSorted(),
    ...field('role', raw.participation_role),
    ...field('date', raw.activity_date),
    ...field('stage', raw.occured_at_stage),
    ...field('political_group_id', raw.politicalGroup),
    ...field('represented_organization_id', raw.participation_in_name_of),
    ...field('term_id', raw.parliamentary_term),
  };
}
/**
 * Complete normalized procedure sections for local paging. The upstream returns the same
 * records and relation arrays in varying order, so every section and nested ID array is sorted
 * into a total order before its snapshot is hashed and sliced.
 */
export function normalizeProcedure(raw: RawProcedure, language: string, notices: string[]) {
  const events = (raw.consists_of ?? [])
    .map((event) => ({
      id: activityId(event),
      ...field('date', event.activity_date),
      ...field('activity_type', event.had_activity_type),
      ...field('stage', event.occured_at_stage),
      document_ids: [
        ...new Set(
          [
            event.decided_on_a_realization_of,
            event.based_on_a_realization_of,
            event.recorded_in_a_realization_of,
            event.created_a_realization_of,
            event.documented_by_a_realization_of,
          ].flatMap((relation) => canonicalIds(relation, 'document')),
        ),
      ].toSorted(),
      sitting_ids: canonicalIds(event.was_scheduled_in, 'activity').toSorted(),
    }))
    .toSorted(timelineOrder);
  const ids = new Set([
    ...canonicalIds(raw.created_a_realization_of, 'document'),
    ...events.flatMap((event) => event.document_ids),
  ]);
  return {
    procedure_id: raw.process_id ?? canonicalId(raw.id, 'procedure'),
    ...field('reference', raw.label),
    ...field('title', localized(raw.process_title, language, notices)),
    ...field('process_type', raw.process_type),
    ...field('stage', raw.current_stage),
    source_url: sourceUrl(raw.id),
    events,
    participants: toArray(raw.had_participation).map(normalizeParticipant).toSorted(timelineOrder),
    documents: [...ids].toSorted().map((document_id) => ({
      document_id,
      source_url: sourceUrl(`eli/dl/doc/${document_id}`),
    })),
  };
}
/**
 * Elements that open and close a paragraph of speech text: the text-bearing `p`, `heading`,
 * `subheading`, `narrative` and `summary`, the `from` speaker line, and the structural containers
 * around them. Every other element is inline: its markup is dropped and its text kept.
 */
const paragraphElements = new Set([
  'p',
  'heading',
  'subheading',
  'narrative',
  'summary',
  'from',
  'oralStatements',
  'writtenStatements',
  'speech',
  'question',
  'answer',
  'blockContainer',
  'communication',
]);
const xmlEntities = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);
/** XML 1.0 `Char`: the code points a numeric character reference may name. */
function xmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}
/**
 * Decodes the five XML entities and numeric references in one left-to-right pass, looking at most
 * 32 characters ahead for `;`. An unknown name or a reference outside `Char` stays literal.
 */
function decodeXml(value: string): string {
  let decoded = '';
  let copied = 0;
  for (let at = value.indexOf('&'); at !== -1; at = value.indexOf('&', at + 1)) {
    const end = value.slice(at + 1, at + 34).indexOf(';');
    if (end === -1) continue;
    const name = value.slice(at + 1, at + 1 + end);
    let character = xmlEntities.get(name);
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(name);
    if (numeric) {
      const code = numeric[1] === undefined ? Number(numeric[2]) : Number.parseInt(numeric[1], 16);
      if (xmlChar(code)) character = String.fromCodePoint(code);
    }
    if (character === undefined) continue;
    decoded += value.slice(copied, at) + character;
    copied = at + end + 2;
    at = copied - 1;
  }
  return decoded + value.slice(copied);
}
function xmlSpace(value: string, at: number): boolean {
  const code = value.charCodeAt(at);
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}
/** Collapses each run of XML whitespace to one space and trims both ends; no-break spaces stay. */
function collapseSpace(value: string): string {
  const words: string[] = [];
  let start = -1;
  for (let at = 0; at <= value.length; at++) {
    if (at < value.length && !xmlSpace(value, at)) {
      if (start === -1) start = at;
    } else if (start !== -1) {
      words.push(value.slice(start, at));
      start = -1;
    }
  }
  return words.join(' ');
}
interface Tag {
  closing: boolean;
  empty: boolean;
  /** Index after the tag's `>`. */
  end: number;
  language?: string;
  name: string;
}
/**
 * Reads the start or end tag at `lt` in one forward pass, honouring quoted attribute values.
 * `'text'` means no element name follows the `<`, which is then text; `undefined` means the tag
 * never closes.
 */
function readTag(xml: string, lt: number): Tag | 'text' | undefined {
  let at = lt + 1;
  const closing = xml[at] === '/';
  if (closing) at++;
  const nameStart = at;
  while (at < xml.length && !xmlSpace(xml, at) && xml[at] !== '/' && xml[at] !== '>') at++;
  if (at === nameStart) return 'text';
  const name = xml.slice(nameStart, at);
  let language: string | undefined;
  while (at < xml.length) {
    const char = xml[at];
    if (char === '>')
      return { name, closing, empty: false, end: at + 1, ...field('language', language) };
    if (char === '/' && xml[at + 1] === '>')
      return { name, closing, empty: true, end: at + 2, ...field('language', language) };
    if (char === '/' || xmlSpace(xml, at)) {
      at++;
      continue;
    }
    const attributeStart = at;
    while (
      at < xml.length &&
      !xmlSpace(xml, at) &&
      xml[at] !== '=' &&
      xml[at] !== '>' &&
      xml[at] !== '/'
    )
      at++;
    const attribute = xml.slice(attributeStart, at);
    while (at < xml.length && xmlSpace(xml, at)) at++;
    if (xml[at] !== '=') continue;
    at++;
    while (at < xml.length && xmlSpace(xml, at)) at++;
    const quote = xml[at] === '"' || xml[at] === "'" ? xml[at] : undefined;
    const valueStart = quote === undefined ? at : at + 1;
    at = valueStart;
    while (
      at < xml.length &&
      (quote === undefined ? !xmlSpace(xml, at) && xml[at] !== '>' : xml[at] !== quote)
    )
      at++;
    if (quote !== undefined && at === xml.length) return undefined;
    const value = xml.slice(valueStart, at);
    if (quote !== undefined) at++;
    if (attribute === 'xml:lang') language ??= decodeXml(value);
  }
  return undefined;
}
/** Plain text of a speech fragment, its first speaker line, and its `xml:lang` tags. */
interface FragmentText {
  /** Every distinct `xml:lang` value, verbatim, in document order. */
  language_tags: string[];
  /** The first `<from>` text, whitespace-collapsed; absent when empty or unpublished. */
  speaker?: string;
  /** Paragraphs in document order joined by blank lines. */
  text: string;
}
/**
 * Reads Parliament's verbatim-report XML in one stack-based pass. Paragraph elements become
 * paragraphs with whitespace runs collapsed, entities decoded in one pass, comments, processing
 * instructions and declarations dropped, and CDATA kept verbatim; inline markup such as per-word
 * `<time>` drops and keeps its text. A later `<from>` reads as a paragraph. Malformed input keeps
 * its text: an unclosed tag, comment or attribute value turns the rest into text, an unmatched
 * end tag is ignored, and an end tag closes every element opened inside its own.
 */
export function fragmentText(xml: string): FragmentText {
  const paragraphs: string[] = [];
  const speakerParts: string[] = [];
  const languageTags = new Set<string>();
  const open: string[] = [];
  const openCounts = new Map<string, number>();
  let pieces: string[] = [];
  let speakerRead = false;
  /** Stack depth of the first `<from>` while its text is read as the speaker line. */
  let speakerDepth: number | undefined;
  const flush = () => {
    const paragraph = collapseSpace(pieces.join(''));
    if (paragraph) paragraphs.push(paragraph);
    pieces = [];
  };
  const text = (value: string) => {
    if (value) (speakerDepth === undefined ? pieces : speakerParts).push(value);
  };
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf('<', at);
    if (lt === -1) {
      text(decodeXml(xml.slice(at)));
      break;
    }
    text(decodeXml(xml.slice(at, lt)));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      text(xml.slice(lt + 9, end === -1 ? xml.length : end));
      at = end === -1 ? xml.length : end + 3;
      continue;
    }
    const [opener, closer] = xml.startsWith('<!--', lt)
      ? ['<!--', '-->']
      : xml.startsWith('<?', lt)
        ? ['<?', '?>']
        : xml.startsWith('<!', lt)
          ? ['<!', '>']
          : [];
    if (opener !== undefined && closer !== undefined) {
      const end = xml.indexOf(closer, lt + opener.length);
      if (end === -1) {
        text(decodeXml(xml.slice(lt)));
        break;
      }
      at = end + closer.length;
      continue;
    }
    const tag = readTag(xml, lt);
    if (tag === undefined) {
      text(decodeXml(xml.slice(lt)));
      break;
    }
    if (tag === 'text') {
      text('<');
      at = lt + 1;
      continue;
    }
    at = tag.end;
    if (tag.language !== undefined) languageTags.add(tag.language);
    const paragraph = paragraphElements.has(tag.name);
    if (tag.closing) {
      if (!openCounts.get(tag.name)) continue;
      let closed: string | undefined;
      do {
        closed = open.pop();
        if (closed === undefined) break;
        openCounts.set(closed, (openCounts.get(closed) ?? 1) - 1);
        if (open.length === speakerDepth) speakerDepth = undefined;
      } while (closed !== tag.name);
      if (paragraph) flush();
      continue;
    }
    if (paragraph) flush();
    if (tag.empty) continue;
    if (tag.name === 'from' && !speakerRead) {
      speakerRead = true;
      speakerDepth = open.length;
    }
    open.push(tag.name);
    openCounts.set(tag.name, (openCounts.get(tag.name) ?? 0) + 1);
  }
  flush();
  return {
    text: paragraphs.join('\n\n'),
    language_tags: [...languageTags],
    ...field('speaker', collapseSpace(speakerParts.join('')) || undefined),
  };
}
/**
 * Activity metadata and source-document references. With `text`, adds the spoken text, speaker
 * line and language tags of the recording fragments published in `language`, and reads the title
 * in that language only: no fallback, since the request narrows both to it.
 */
export function normalizeSpeech(
  raw: RawSpeech,
  language: string,
  notices: string[],
  { text = false }: { text?: boolean } = {},
) {
  const recordings = toArray(raw.recorded_in_a_realization_of).flatMap((recording) =>
    typeof recording === 'string' ? [] : [recording],
  );
  const fragments = recordings.flatMap(
    (recording) => recording['api:xmlFragment']?.[language] ?? [],
  );
  const spoken = text && fragments.length > 0 ? fragmentText(fragments.join('')) : undefined;
  const label = raw.activity_label?.[language];
  return {
    speech_id: activityId(raw),
    ...field('date', raw.activity_date),
    ...field('start_time', raw.activity_start_date),
    ...field('end_time', raw.activity_end_date),
    ...field(
      'title',
      text
        ? label === undefined
          ? undefined
          : { value: label, language }
        : localized(raw.activity_label, language, notices),
    ),
    ...field('activity_type', raw.had_activity_type),
    participants: toArray(raw.had_participation).map((part) => ({
      person_ids: canonicalIds(part.had_participant_person, 'person'),
      ...field('role', part.participation_role),
    })),
    document_ids: canonicalIds(raw.recorded_in_a_realization_of, 'document'),
    original_languages: recordings.flatMap((recording) =>
      originalLanguages(recording.originalLanguage),
    ),
    ...(spoken && {
      ...field('speaker', spoken.speaker),
      language_tags: spoken.language_tags,
      text: { value: spoken.text, language },
    }),
    source_url: sourceUrl(raw.id),
  };
}
/** Recorded and intended positions are distinct keys. */
export const voterPositions = [
  'favor',
  'against',
  'abstention',
  'intended_favor',
  'intended_against',
  'intended_abstention',
] as const;
/** Accepted voter selector. */
export type VoterPosition = (typeof voterPositions)[number];
/**
 * A voter entry naming no person: `person/`, or its public URI, with nothing after it. Some early
 * decisions (MTG-PL-2019-01-14-DEC-100087) publish only such entries beside their tallies.
 */
function unnamedVoter(id: string): boolean {
  const trimmed = id.trim();
  return trimmed === nounPrefixes.person || trimmed === `${publicOrigin}${nounPrefixes.person}`;
}
/**
 * The notice a page carries when one of `positions` of `raw` holds a voter entry naming no person;
 * worded to hold for every decision on the page.
 */
export function unnamedVotersNotice(
  raw: RawDecision,
  positions: readonly VoterPosition[] = voterPositions,
): string | undefined {
  return positions.some((position) => raw[`had_voter_${position}`]?.some(unnamedVoter))
    ? 'Parliament publishes voter entries that name no person (person/ with no identifier) on some decisions; they are left out of voters, voter_counts and mep_position, and favor, against and abstention keep the published tallies.'
    : undefined;
}
/** Retains unavailable arrays separately from published empty arrays; entries naming no person drop out. */
export function decisionVoters(raw: RawDecision, position: VoterPosition): string[] | undefined {
  return raw[`had_voter_${position}`]?.flatMap((id) =>
    unnamedVoter(id) ? [] : [canonicalId(id, 'person')],
  );
}
/** Compact whole-decision catalogue row. */
export function normalizeDecisionSummary(
  raw: RawDecision,
  language = 'en',
  notices: string[] = [],
  mepId?: string,
) {
  const unnamed = unnamedVotersNotice(raw);
  if (unnamed !== undefined) notices.push(unnamed);
  return {
    decision_id: activityId(raw),
    ...field('label', localized(raw.activity_label, language, notices)),
    document_ids: canonicalIds(raw.decided_on_a_realization_of, 'document'),
    recording_document_ids: canonicalIds(raw.recorded_in_a_realization_of, 'document'),
    partial_document_ids: canonicalIds(raw.decided_on_a_part_of_a_realization_of, 'document'),
    vote_item_ids: canonicalIds(raw.inverse_consists_of, 'activity'),
    ...field('date', raw.activity_date),
    ...field('start_time', raw.activity_start_date),
    ...field('order', raw.activity_order),
    ...field('method', raw.decision_method),
    ...field('outcome', raw.decision_outcome),
    ...field('attendees', raw.number_of_attendees),
    ...field('favor', raw.number_of_votes_favor),
    ...field('against', raw.number_of_votes_against),
    ...field('abstention', raw.number_of_votes_abstention),
    voter_counts: voterPositions.flatMap((position) => {
      const voters = decisionVoters(raw, position);
      return voters === undefined ? [] : [{ position, count: voters.length }];
    }),
    source_url: sourceUrl(raw.id),
    ...(mepId !== undefined && {
      mep_position: {
        recorded: memberPositions(raw, mepId, false),
        intended: memberPositions(raw, mepId, true),
      },
    }),
  };
}
/** Compact decision row. */
export type DecisionSummary = ReturnType<typeof normalizeDecisionSummary>;
/** Rich single decision; all selected text remains whole. */
export function normalizeDecision(
  raw: RawDecision,
  language: string,
  notices: string[],
  mepId?: string,
) {
  return {
    ...normalizeDecisionSummary(raw, language, notices, mepId),
    ...field('reference_text', localized(raw.referenceText, language, notices)),
    ...field('comment', localized(raw.comment, language, notices)),
  };
}
/**
 * One sitting vote item. `decision_count` counts its published decision links and stays absent,
 * never 0, where the item publishes none (sittings before 2024).
 */
export function normalizeVoteItem(raw: RawVoteItem, language: string, notices: string[]) {
  return {
    vote_item_id: activityId(raw),
    ...field('label', localized(raw.activity_label, language, notices)),
    document_ids: canonicalIds(raw.based_on_a_realization_of, 'document'),
    procedure_ids: procedureIds(raw.inverse_consists_of),
    recording_document_ids: canonicalIds(raw.recorded_in_a_realization_of, 'document'),
    ...field(
      'decision_count',
      raw.consists_of === undefined ? undefined : references(raw.consists_of).length,
    ),
    source_url: sourceUrl(raw.id),
  };
}
/** Public URIs of the vote items a record's embedded sitting lists; empty when it embeds none. */
export function listedVoteItems(raw: RawVoteItem, sittingId: string): string[] {
  const sitting = sourceUrl(`eli/dl/event/${sittingId}`);
  return toArray(raw.inverse_consists_of).flatMap((parent) =>
    typeof parent !== 'string' && sourceUrl(parent.id) === sitting
      ? references(parent.consists_of).map(sourceUrl)
      : [],
  );
}
function memberPositions(raw: RawDecision, memberId: string, intended: boolean) {
  const positions = ['favor', 'against', 'abstention'] as const;
  const published = positions.map((position) => ({
    position,
    voters: decisionVoters(raw, intended ? `intended_${position}` : position),
  }));
  const unavailable_positions = published
    .filter(({ voters }) => voters === undefined)
    .map(({ position }) => position);
  return {
    positions: published
      .filter(({ voters }) => voters?.includes(memberId))
      .map(({ position }) => position),
    unavailable_positions,
    availability:
      unavailable_positions.length === 0
        ? ('published' as const)
        : unavailable_positions.length === 3
          ? ('unavailable' as const)
          : ('partial' as const),
  };
}
/** Strict all-token matching after Unicode decomposition. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}
/** Results Parliament exposes to one speech, adopted-text or unfiltered procedure search. */
export const searchResultWindow = 10_000;
/**
 * Acquisition bounds; MAX_SAFE_INTEGER is only the representable local page position bound.
 * `strictMaximum`, where present, is the largest limit EUPARL_CLAMP_LIMITS=false accepts for the
 * collection, normalized to `maximum` with a notice.
 */
export const pageCaps = {
  procedures: { maximum: 1000, noun: 'procedures' },
  local_procedures: { maximum: Number.MAX_SAFE_INTEGER, noun: 'process_type procedures' },
  questions: { maximum: 1000, noun: 'questions' },
  documents: { maximum: 1000, noun: 'documents' },
  // A titled adopted-text page reads 12 to 20 times the bytes of a view=list page (docs/design.md);
  // strict mode still accepts limits up to the search window, the page bound before titled rows.
  adopted_documents: {
    maximum: 100,
    noun: 'adopted texts',
    strictMaximum: searchResultWindow,
  },
  keyword_documents: {
    maximum: 100,
    noun: 'keyword adopted texts',
    strictMaximum: searchResultWindow,
  },
  speeches: { maximum: 10_000, noun: 'speeches' },
  keyword_speeches: { maximum: 1000, noun: 'keyword speeches' },
  text_speeches: { maximum: 100, noun: 'speeches with text' },
  meps: { maximum: Number.MAX_SAFE_INTEGER, noun: 'MEPs' },
  memberships: { maximum: Number.MAX_SAFE_INTEGER, noun: 'memberships' },
  procedure_sections: { maximum: Number.MAX_SAFE_INTEGER, noun: 'procedure section entries' },
  voters: { maximum: Number.MAX_SAFE_INTEGER, noun: 'voters' },
  sittings: { maximum: 1000, noun: 'sittings' },
  decisions: { maximum: Number.MAX_SAFE_INTEGER, noun: 'decisions' },
  vote_items: { maximum: Number.MAX_SAFE_INTEGER, noun: 'vote items' },
  reference: { maximum: 1000, noun: 'reference entries' },
  static_reference: { maximum: Number.MAX_SAFE_INTEGER, noun: 'static reference entries' },
  organizations: { maximum: 20, noun: 'organization lookups' },
} as const;
/** A paged collection with its own cap. */
export type PagedCollection = keyof typeof pageCaps;
/** Effective whole-item position after defaults, the collection cap and any search window. */
export interface PageWindow {
  limit: number;
  offset: number;
  snapshot?: string;
}
/**
 * Requested position with the default 20 and the collection cap applied. Inside an upstream
 * result window, the limit also narrows to the results left before it; an offset at or past the
 * window is left for the caller to reject.
 */
export function pageWindow(
  input: Paging,
  collection: PagedCollection,
  resultWindow?: number,
): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = Math.min(input.limit ?? 20, pageCaps[collection].maximum);
  return {
    offset,
    limit:
      resultWindow !== undefined && offset < resultWindow
        ? Math.min(limit, resultWindow - offset)
        : limit,
  };
}
/**
 * Local snapshots include normalized scope and every returned field before slicing. A supplied
 * snapshot must match; whether continuation requires one is the caller's contract, checked before
 * the collection is acquired. Every requested item is retained regardless of rendered size.
 */
export function localPage<T>(
  items: T[],
  input: PageWindow,
  scope: unknown,
): { items: T[]; page: Page; total: number } {
  const { offset, limit } = input;
  const snapshot = createHash('sha256').update(JSON.stringify({ scope, items })).digest('hex');
  if (input.snapshot !== undefined && input.snapshot !== snapshot)
    throw conflict('The complete collection changed. Restart at offset 0 without snapshot.', {
      reason: 'snapshot_changed',
    });
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    total: items.length,
    page: { ...upstreamPage(selected.length, input, items.length), snapshot },
  };
}
/** Preserve uncertain totals and omit inaccessible continuation at an upstream result window. */
export function upstreamPage(
  returned: number,
  input: PageWindow,
  total?: number,
  resultWindow?: number,
): Page {
  const { offset, limit } = input;
  const exactTotal =
    resultWindow !== undefined && total !== undefined && total >= resultWindow ? undefined : total;
  const atWindow =
    resultWindow !== undefined && offset + returned >= resultWindow && exactTotal === undefined;
  const has_more =
    atWindow || (exactTotal === undefined ? returned === limit : offset + returned < exactTotal);
  return {
    offset,
    limit,
    returned,
    has_more,
    ...(has_more && !atWindow && { next_offset: offset + returned }),
  };
}
