/**
 * @fileoverview Canonical identifiers and lossless selected-language domain records.
 * @module services/eu-parliament/eu-parliament-normalization
 */
import { createHash } from 'node:crypto';
import { conflict, validationError } from '@cyanheads/mcp-ts-core/errors';
import type {
  RawDecision,
  RawDocument,
  RawMep,
  RawParticipation,
  RawProcedure,
  RawQuestion,
  RawSpeech,
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
/** Strips only a verified public URI and known noun prefix. */
export function canonicalId(
  value: string,
  noun: 'document' | 'person' | 'activity' | 'procedure',
): string {
  const prefixes = {
    document: 'eli/dl/doc/',
    person: 'person/',
    activity: 'eli/dl/event/',
    procedure: 'eli/dl/proc/',
  };
  let id = value.trim();
  if (id.startsWith(publicOrigin)) id = id.slice(publicOrigin.length);
  if (id.startsWith(prefixes[noun])) id = id.slice(prefixes[noun].length);
  if (noun === 'procedure') {
    const match = /^(\d{4})[-/](\d{4}[A-Z]?)(?:\(([A-Z]+)\))?$/.exec(id);
    if (!match)
      throw validationError('Invalid procedure identifier. Use YYYY-NNNN or YYYY/NNNN(TYPE).', {
        reason: 'invalid_filter',
      });
    return `${match[1]}-${match[2]}`;
  }
  if (!(noun === 'person' ? /^\d+$/.test(id) : /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)))
    throw validationError(
      `Invalid ${noun} identifier. Use a canonical identifier returned by a discovery tool.`,
      { reason: 'invalid_filter' },
    );
  return id;
}
/** Public linked identity; never an API download route. */
export function sourceUrl(id: string): string {
  return new URL(id, publicOrigin).href;
}
/** Known relationship references flatten singleton and array forms without reordering. */
export function references(
  value: string | { id: string } | (string | { id: string })[] | undefined,
): string[] {
  return value === undefined
    ? []
    : (Array.isArray(value) ? value : [value]).map((item) =>
        typeof item === 'string' ? item : item.id,
      );
}
/** Select requested language, English, then the first available source key. */
export function localized(
  map: Record<string, string> | undefined,
  language: string,
  notices: string[],
): LocalizedText | undefined {
  if (!map) return undefined;
  const keys = Object.keys(map)
    .filter((key) => map[key] !== undefined)
    .sort();
  const selected = Object.hasOwn(map, language)
    ? language
    : Object.hasOwn(map, 'en')
      ? 'en'
      : keys[0];
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
  const languages = [
    ...new Set(
      expressions.map((expression) => expression.id.slice(expression.id.lastIndexOf('/') + 1)),
    ),
  ].sort();
  const selected = languages.includes(language)
    ? language
    : languages.includes('en')
      ? 'en'
      : languages[0];
  if (!selected) return [];
  if (selected !== language)
    notices.push(
      `Requested file language ${language} unavailable; returned published ${selected} files.`,
    );
  return expressions
    .filter((expression) => expression.id.split('/').at(-1) === selected)
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
/** Generic work detail preserves only explicitly published relations. */
export function normalizeDocument(raw: RawDocument, language: string, notices: string[]) {
  const expressionTitles: Record<string, string> = Object.create(null);
  for (const expression of raw.is_realized_by ?? [])
    Object.assign(expressionTitles, expression.title);
  const maps = raw.title_dcterms ?? expressionTitles;
  const procedures = [...references(raw.refers_to), ...references(raw.is_about)].filter(
    (id) => id.startsWith('eli/dl/proc/') || id.startsWith(`${publicOrigin}eli/dl/proc/`),
  );
  return {
    ...normalizeDocumentSummary(raw),
    ...field('title', localized(maps, language, notices)),
    ...field('date', raw.document_date),
    ...field('term_id', raw.parliamentary_term),
    creator_ids: references(raw.creator),
    procedure_ids: procedures.map((id) => canonicalId(id, 'procedure')),
    parent_document_ids: references(raw.is_part_of).map((id) => canonicalId(id, 'document')),
    links: documentLinks(raw, language, notices),
  };
}
/** Embedded answer metadata is returned without individual answer requests. */
export function normalizeQuestion(raw: RawQuestion, language: string, notices: string[]) {
  const document = normalizeDocument(raw, language, notices);
  return {
    question_id: document.document_id,
    ...field('title', document.title),
    ...field('date', document.date),
    ...field('work_type', document.work_type),
    ...field('term_id', document.term_id),
    creator_ids: document.creator_ids,
    links: document.links,
    answers: (raw.inverse_answers_to ?? []).map((answer) =>
      typeof answer === 'string'
        ? { document_id: canonicalId(answer, 'document'), links: [] as Link[] }
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
/** Historical participation fields are never joined to current membership. */
export function normalizeParticipant(raw: RawParticipation) {
  return {
    id: raw.id,
    person_ids: references(raw.had_participant_person).map((id) => canonicalId(id, 'person')),
    organization_ids: references(raw.had_participant_organization),
    ...field('role', raw.participation_role),
    ...field('date', raw.activity_date),
    ...field('stage', raw.occured_at_stage),
    ...field('political_group_id', raw.politicalGroup),
    ...field('represented_organization_id', raw.participation_in_name_of),
    ...field('term_id', raw.parliamentary_term),
  };
}
/** Procedure sections are complete normalized collections before local paging. */
export function normalizeProcedure(raw: RawProcedure, language: string, notices: string[]) {
  const events = (raw.consists_of ?? []).map((event) => {
    const related = [
      ...references(event.decided_on_a_realization_of),
      ...references(event.based_on_a_realization_of),
      ...references(event.recorded_in_a_realization_of),
      ...references(event.created_a_realization_of),
      ...references(event.documented_by_a_realization_of),
    ];
    return {
      id: event.activity_id ?? canonicalId(event.id, 'activity'),
      ...field('date', event.activity_date),
      ...field('activity_type', event.had_activity_type),
      ...field('stage', event.occured_at_stage),
      document_ids: [...new Set(related.map((id) => canonicalId(id, 'document')))],
      sitting_ids: references(event.was_scheduled_in).map((id) => canonicalId(id, 'activity')),
    };
  });
  const ids = [
    ...new Set([
      ...references(raw.created_a_realization_of).map((id) => canonicalId(id, 'document')),
      ...events.flatMap((event) => event.document_ids),
    ]),
  ];
  const participations =
    raw.had_participation === undefined
      ? []
      : Array.isArray(raw.had_participation)
        ? raw.had_participation
        : [raw.had_participation];
  return {
    procedure_id: raw.process_id ?? canonicalId(raw.id, 'procedure'),
    ...field('reference', raw.label),
    ...field('title', localized(raw.process_title, language, notices)),
    ...field('process_type', raw.process_type),
    ...field('stage', raw.current_stage),
    source_url: sourceUrl(raw.id),
    events,
    participants: participations.map(normalizeParticipant),
    documents: ids.map((document_id) => ({
      document_id,
      source_url: sourceUrl(`eli/dl/doc/${document_id}`),
    })),
  };
}
/** Activity metadata and its source-document references, never inferred spoken text. */
export function normalizeSpeech(raw: RawSpeech, language: string, notices: string[]) {
  const parts =
    raw.had_participation === undefined
      ? []
      : Array.isArray(raw.had_participation)
        ? raw.had_participation
        : [raw.had_participation];
  return {
    speech_id: raw.activity_id ?? canonicalId(raw.id, 'activity'),
    ...field('date', raw.activity_date),
    ...field('start_time', raw.activity_start_date),
    ...field('end_time', raw.activity_end_date),
    ...field('title', localized(raw.activity_label, language, notices)),
    ...field('activity_type', raw.had_activity_type),
    participants: parts.map((part) => ({
      person_ids: references(part.had_participant_person).map((id) => canonicalId(id, 'person')),
      ...field('role', part.participation_role),
    })),
    document_ids: references(raw.recorded_in_a_realization_of).map((id) =>
      canonicalId(id, 'document'),
    ),
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
/** Retains unavailable arrays separately from published empty arrays. */
export function decisionVoters(raw: RawDecision, position: VoterPosition): string[] | undefined {
  return raw[`had_voter_${position}`]?.map((id) => canonicalId(id, 'person'));
}
/** Compact whole-decision catalogue row. */
export function normalizeDecisionSummary(raw: RawDecision) {
  return {
    decision_id: raw.activity_id ?? canonicalId(raw.id, 'activity'),
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
  };
}
/** Rich single decision; all selected text remains whole. */
export function normalizeDecision(raw: RawDecision, language: string, notices: string[]) {
  return {
    ...normalizeDecisionSummary(raw),
    ...field('label', localized(raw.activity_label, language, notices)),
    ...field('reference_text', localized(raw.referenceText, language, notices)),
    ...field('comment', localized(raw.comment, language, notices)),
    document_ids: references(raw.decided_on_a_realization_of).map((id) =>
      canonicalId(id, 'document'),
    ),
    recording_document_ids: references(raw.recorded_in_a_realization_of).map((id) =>
      canonicalId(id, 'document'),
    ),
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
/** Local snapshots include normalized scope and every returned field before slicing. */
export function localPage<T>(
  items: T[],
  input: Paging,
  scope: unknown,
): { items: T[]; page: Page; total: number } {
  const offset = input.offset ?? 0;
  const limit = Math.min(input.limit ?? 20, 100);
  if (offset > 0 && !input.snapshot)
    throw validationError('Local continuation requires the previous page snapshot.', {
      reason: 'invalid_mode_fields',
    });
  const snapshot = createHash('sha256').update(JSON.stringify({ scope, items })).digest('hex');
  if (input.snapshot !== undefined && input.snapshot !== snapshot)
    throw conflict('The complete collection changed. Restart at offset 0 without snapshot.', {
      reason: 'snapshot_changed',
    });
  const selected = items.slice(offset, offset + limit);
  const has_more = offset + selected.length < items.length;
  return {
    items: selected,
    total: items.length,
    page: {
      offset,
      limit,
      returned: selected.length,
      has_more,
      ...(has_more && { next_offset: offset + selected.length }),
      snapshot,
    },
  };
}
/** Offset lists lack an invented total; a full page requires another request. */
export function upstreamPage(returned: number, input: Paging, total?: number): Page {
  const offset = input.offset ?? 0;
  const limit = Math.min(input.limit ?? 20, 100);
  const has_more = total === undefined ? returned === limit : offset + returned < total;
  return { offset, limit, returned, has_more, ...(has_more && { next_offset: offset + returned }) };
}
