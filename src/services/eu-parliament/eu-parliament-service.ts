/**
 * @fileoverview Typed domain operations with complete acquisition and stateless snapshots.
 * @module services/eu-parliament/eu-parliament-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  type ClientOptions,
  type Envelope,
  EuParliamentClient,
  type Operation,
} from './eu-parliament-client.js';
import {
  canonicalId,
  decisionVoters,
  field,
  localized,
  localPage,
  normalizeDecision,
  normalizeDecisionSummary,
  normalizeDocument,
  normalizeDocumentSummary,
  normalizeMep,
  normalizeName,
  normalizeProcedure,
  normalizeQuestion,
  normalizeSpeech,
  type Paging,
  sourceUrl,
  upstreamPage,
  type VoterPosition,
} from './eu-parliament-normalization.js';
import { normalizeCode, type ReferenceTopic, referenceEntries } from './eu-parliament-reference.js';
import {
  bodySchema,
  decisionSchema,
  documentSchema,
  mepSchema,
  procedureSchema,
  questionSchema,
  type RawMep,
  sittingSchema,
  speechSchema,
} from './eu-parliament-schemas.js';

/** Request dependency is explicit; no state or logging is needed for public reads. */
export type ServiceContext = Pick<Context, 'signal'>;
/** Result metadata is applied by definitions through ctx.enrich on both surfaces. */
export interface Enrichment {
  appliedFilters: Record<string, unknown>;
  available?: boolean;
  notice?: string;
  totalCount?: number;
}
/** Domain payload and result-set context remain separate for framework rendering. */
export interface ServiceResult<T> {
  data: T;
  enrichment: Enrichment;
}
/** Reference input. */
export interface ReferenceInput extends Paging {
  topic: ReferenceTopic;
}
/** Procedure catalogue input. */
export interface ProceduresInput extends Paging {
  process_type?: string;
}
/** Procedure detail input. */
export interface ProcedureInput extends Paging {
  procedure_id: string;
  section?: 'overview' | 'events' | 'participants' | 'documents';
}
/** Document family search or canonical detail. */
export interface DocumentsInput extends Paging {
  document_id?: string;
  mode?: 'search' | 'get';
  related_process_id?: string;
  sitting_date?: string;
  sitting_date_end?: string;
  source?: 'adopted_texts' | 'committee' | 'plenary';
  term?: number;
  text?: string;
  title?: string;
  work_type?: string;
  year?: number;
}
/** Speech metadata search or detail. */
export interface SpeechesInput extends Paging {
  activity_type?: string;
  mode?: 'search' | 'get';
  person_id?: string;
  sitting_date?: string;
  sitting_date_end?: string;
  speech_id?: string;
  text?: string;
  title?: string;
}
/** Complete current or explicit-term roster filtering. */
export interface MepsInput extends Paging {
  country?: string;
  gender?: string;
  name_contains?: string;
  political_group?: string;
  term?: number;
}
/** Identity and separately paged membership history. */
export interface MepInput extends Paging {
  mep_id: string;
  section?: 'overview' | 'memberships';
}
/** Sitting discovery, compact decisions, rich decision or one voter position. */
export interface VotesInput extends Paging {
  decision_id?: string;
  mode?: 'sittings' | 'decisions' | 'decision' | 'voters';
  position?: VoterPosition;
  resolve_names?: boolean;
  roster_term?: number;
  sitting_id?: string;
  year?: number;
}
/** Questions can resolve an exact citation across all terms represented in a year. */
export interface QuestionsInput extends Paging {
  mode?: 'list' | 'get';
  question_id?: string;
  term?: number;
  work_type?: string;
  year?: number;
}

function invalidMode(message: string): never {
  throw validationError(message, { reason: 'invalid_mode_fields' });
}
function invalidFilter(message: string): never {
  throw validationError(message, { reason: 'invalid_filter' });
}
function meaningful(value: unknown): boolean {
  return (
    value !== undefined && value !== false && !(typeof value === 'string' && value.trim() === '')
  );
}
function forbid(input: object, keys: string[]): void {
  for (const key of keys)
    if (Object.hasOwn(input, key) && meaningful(Reflect.get(input, key)))
      invalidMode(`${key} is not supported in this mode.`);
}
function required(value: string | undefined, key: string): string {
  if (!value?.trim()) invalidMode(`${key} is required in this mode.`);
  return value;
}
function detailPaging(input: Paging): void {
  if ((input.offset ?? 0) !== 0 || (input.limit ?? 20) !== 20 || input.snapshot !== undefined)
    invalidMode('Detail mode does not accept paging or snapshot fields.');
}
function localPaging(input: Paging): void {
  if ((input.offset ?? 0) > 0 && !input.snapshot)
    invalidMode('Local continuation requires the previous page snapshot.');
}
function term(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 10))
    invalidFilter('term must be an integer from 0 through 10.');
}
function year(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1000 || value > 9999))
    invalidFilter('year must be a four-digit integer.');
}
function date(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalidFilter('Use a real calendar date in YYYY-MM-DD form.');
  return value;
}
function dates(input: { sitting_date?: string; sitting_date_end?: string }): void {
  if (input.sitting_date) date(input.sitting_date);
  if (input.sitting_date_end) {
    date(input.sitting_date_end);
    if (!input.sitting_date || input.sitting_date_end < input.sitting_date)
      invalidFilter('sitting_date_end requires an ordered sitting_date range.');
  }
}
function queryPage(input: Paging) {
  return { offset: input.offset ?? 0, limit: Math.min(input.limit ?? 20, 100) };
}
function scopePage(input: Paging) {
  const language = normalizeCode(input.language, 'language') ?? 'en';
  return { ...queryPage(input), language, ...field('snapshot', input.snapshot) };
}
function result<T>(
  data: T,
  filters: Record<string, unknown>,
  notices: string[],
  total?: number,
  available?: boolean,
): ServiceResult<T> {
  return {
    data,
    enrichment: {
      appliedFilters: filters,
      ...(notices.length > 0 && { notice: [...new Set(notices)].join(' ') }),
      ...field('totalCount', total),
      ...field('available', available),
    },
  };
}
function noticesFor(input: Paging): string[] {
  return (input.limit ?? 20) > 100
    ? ['Requested limit normalized to the effective maximum of 100.']
    : [];
}
function stalled(): never {
  throw serviceUnavailable(
    'Parliament pagination did not establish a complete collection. Retry later.',
    { reason: 'upstream_paging_stalled', retryable: false },
  );
}

/** Public GET workflow service; one client instance shares pacing across operations. */
export class EuParliamentService {
  readonly client: EuParliamentClient;
  constructor(options: ClientOptions) {
    this.client = new EuParliamentClient(options);
  }

  /** Live bodies page upstream; static tables page without snapshots. */
  async listReference(input: ReferenceInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    if (input.topic === 'committees' || input.topic === 'political_groups') {
      const classification =
        input.topic === 'committees' ? 'COMMITTEE_PARLIAMENTARY_STANDING' : 'EU_POLITICAL_GROUP';
      const response = await this.client.get(
        'corporate-bodies',
        { ...queryPage(paging), 'body-classification': classification },
        bodySchema,
        operation,
      );
      const items = response.data.map((raw) => ({
        code: raw.identifier ?? raw.id,
        id: raw.id,
        ...field('classification', raw.classification),
        ...field(
          'label',
          typeof raw.label === 'string'
            ? { value: raw.label, language: 'mul' }
            : localized(raw.label, paging.language, notices),
        ),
      }));
      if (!items.length)
        notices.push(
          'No reference entries matched. Call euparl_list_reference with topic identifiers to inspect accepted identifiers.',
        );
      return result(
        { topic: input.topic, items, page: upstreamPage(items.length, paging, response.total) },
        { topic: input.topic, language: paging.language },
        notices,
        response.total,
      );
    }
    const all = referenceEntries(input.topic);
    const items = all.slice(paging.offset, paging.offset + paging.limit);
    const has_more = paging.offset + items.length < all.length;
    return result(
      {
        topic: input.topic,
        items,
        page: {
          offset: paging.offset,
          limit: paging.limit,
          returned: items.length,
          has_more,
          ...(has_more && { next_offset: paging.offset + items.length }),
        },
      },
      { topic: input.topic, language: paging.language },
      notices,
      all.length,
    );
  }

  /** Catalogue rows deliberately do not claim procedure titles. */
  async listProcedures(input: ProceduresInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const process_type = normalizeCode(input.process_type, 'process_type');
    const notices = noticesFor(input);
    const response = await this.client.get(
      'procedures',
      { ...queryPage(paging), 'process-type': process_type },
      procedureSchema,
      operation,
    );
    const items = response.data.map((raw) => ({
      procedure_id: raw.process_id ?? canonicalId(raw.id, 'procedure'),
      ...field('reference', raw.label),
      ...field('process_type', raw.process_type),
      source_url: sourceUrl(raw.id),
    }));
    if (!items.length)
      notices.push(
        'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.',
      );
    return result(
      { items, page: upstreamPage(items.length, paging, response.total) },
      { ...field('process_type', process_type) },
      notices,
      response.total,
    );
  }

  /** Overview omits collections; selected sections use complete-record snapshots. */
  async getProcedure(input: ProcedureInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const procedure_id = canonicalId(input.procedure_id, 'procedure');
    const section = input.section ?? 'overview';
    if (section === 'overview' && paging.offset !== 0)
      invalidMode('Procedure overview rejects nonzero offset.');
    if (section !== 'overview') localPaging(input);
    const response = await this.client.get(
      `procedures/${procedure_id}`,
      {},
      procedureSchema,
      operation,
    );
    const raw = response.data[0];
    if (!raw) {
      notices.push(
        'No procedure detail was published. Call euparl_list_procedures to discover references.',
      );
      return result(
        {
          found: false,
          procedure_id,
          source_url: sourceUrl(`eli/dl/proc/${procedure_id}`),
          section,
        },
        { procedure_id, section, language: paging.language },
        notices,
      );
    }
    const requestedType = /\(([A-Z]+)\)$/.exec(input.procedure_id)?.[1];
    if (requestedType && raw.process_type?.split('/').at(-1) !== requestedType)
      invalidFilter('Procedure citation type conflicts with the published procedure type.');
    const normalized = normalizeProcedure(raw, paging.language, notices);
    const { events, participants, documents, ...overview } = normalized;
    const filters = { procedure_id, section, language: paging.language };
    if (section === 'overview')
      return result(
        {
          found: true,
          ...overview,
          section,
          available_sections: [
            { name: 'events', count: events.length },
            { name: 'participants', count: participants.length },
            { name: 'documents', count: documents.length },
          ],
        },
        filters,
        notices,
      );
    if (section === 'events') {
      const page = localPage(events, paging, filters);
      return result(
        { found: true, ...overview, section, events: page.items, page: page.page },
        filters,
        notices,
        page.total,
      );
    }
    if (section === 'participants') {
      const page = localPage(participants, paging, filters);
      return result(
        { found: true, ...overview, section, participants: page.items, page: page.page },
        filters,
        notices,
        page.total,
      );
    }
    const page = localPage(documents, paging, filters);
    return result(
      { found: true, ...overview, section, documents: page.items, page: page.page },
      filters,
      notices,
      page.total,
    );
  }

  /** Search-only filters are checked against the selected source before HTTP. */
  async searchDocuments(input: DocumentsInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const mode = input.mode ?? 'search';
    if (mode === 'get') {
      forbid(input, [
        'source',
        'text',
        'title',
        'year',
        'term',
        'work_type',
        'sitting_date',
        'sitting_date_end',
        'related_process_id',
      ]);
      detailPaging(input);
      const document_id = canonicalId(required(input.document_id, 'document_id'), 'document');
      const response = await this.client.get(
        `documents/${document_id}`,
        {},
        documentSchema,
        operation,
      );
      const raw = response.data[0];
      if (!raw)
        notices.push(
          'No document detail was published. Call euparl_search_documents in search mode to discover identifiers.',
        );
      return result(
        {
          mode,
          found: !!raw,
          ...field('document', raw ? normalizeDocument(raw, paging.language, notices) : undefined),
        },
        { mode, document_id, language: paging.language },
        notices,
      );
    }
    forbid(input, ['document_id', 'snapshot']);
    const source = input.source ?? 'adopted_texts';
    year(input.year);
    term(input.term);
    dates(input);
    if (
      source !== 'adopted_texts' &&
      [
        input.text,
        input.title,
        input.sitting_date,
        input.sitting_date_end,
        input.related_process_id,
      ].some(meaningful)
    )
      invalidFilter(
        'Keyword, sitting-date and related-process filters are available only for adopted_texts.',
      );
    if (source === 'committee' && input.year !== undefined)
      invalidFilter('Committee documents do not support year.');
    if (source === 'plenary' && input.term !== undefined)
      invalidFilter('Plenary documents do not support term.');
    const work_type = normalizeCode(input.work_type, source);
    const related_process_id = input.related_process_id
      ? canonicalId(input.related_process_id, 'procedure')
      : undefined;
    const filters = {
      source,
      language: paging.language,
      ...field('text', input.text),
      ...field('title', input.title),
      ...field('year', input.year),
      ...field('term', input.term),
      ...field('work_type', work_type),
      ...field('sitting_date', input.sitting_date),
      ...field('sitting_date_end', input.sitting_date_end),
      ...field('related_process_id', related_process_id),
    };
    const query = {
      ...queryPage(paging),
      'work-type': work_type,
      ...(source !== 'committee' && { year: input.year }),
      ...(source !== 'plenary' && { 'parliamentary-term': input.term }),
      ...(source === 'adopted_texts' && {
        text: input.text,
        title: input.title,
        'search-language': paging.language,
        'sitting-date': input.sitting_date,
        'sitting-date-end': input.sitting_date_end,
        'related-process-id': related_process_id,
        view: 'list',
      }),
    };
    const endpoint =
      source === 'adopted_texts'
        ? 'adopted-texts'
        : source === 'committee'
          ? 'committee-documents'
          : 'plenary-documents';
    const response = await this.client.get(endpoint, query, documentSchema, operation);
    const items = response.data.map(normalizeDocumentSummary);
    if (!items.length)
      notices.push(
        'No documents matched. Remove a named filter, or call euparl_list_reference with topic document_types; keyword search is available only for adopted_texts.',
      );
    return result(
      { mode, source, items, page: upstreamPage(items.length, paging, response.total) },
      filters,
      notices,
      response.total,
    );
  }

  /** Speech results preserve metadata rather than manufacturing transcripts. */
  async searchSpeeches(input: SpeechesInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const mode = input.mode ?? 'search';
    if (mode === 'get') {
      forbid(input, [
        'text',
        'title',
        'person_id',
        'activity_type',
        'sitting_date',
        'sitting_date_end',
      ]);
      detailPaging(input);
      const speech_id = canonicalId(required(input.speech_id, 'speech_id'), 'activity');
      const response = await this.client.get(`speeches/${speech_id}`, {}, speechSchema, operation);
      const raw = response.data[0];
      if (!raw)
        notices.push('No speech detail was published. Call euparl_search_speeches in search mode.');
      return result(
        {
          mode,
          found: !!raw,
          ...field('speech', raw ? normalizeSpeech(raw, paging.language, notices) : undefined),
        },
        { mode, speech_id, language: paging.language },
        notices,
      );
    }
    forbid(input, ['speech_id', 'snapshot']);
    dates(input);
    const activity_type = normalizeCode(input.activity_type, 'activity_type');
    const person_id = input.person_id ? canonicalId(input.person_id, 'person') : undefined;
    const response = await this.client.get(
      'speeches',
      {
        ...queryPage(paging),
        text: input.text,
        title: input.title,
        'person-id': person_id,
        'activity-type': activity_type,
        'search-language': paging.language,
        'parliamentary-term': 10,
        'sitting-date': input.sitting_date,
        'sitting-date-end': input.sitting_date_end,
      },
      speechSchema,
      operation,
    );
    const items = response.data.map((raw) => normalizeSpeech(raw, paging.language, notices));
    if (!items.length)
      notices.push(
        'No speech records matched. Broaden sitting_date or remove person_id; call euparl_list_reference with topic activity_types. Speech coverage is limited to the tenth term.',
      );
    return result(
      { mode, items, page: upstreamPage(items.length, paging, response.total) },
      {
        mode,
        language: paging.language,
        term: 10,
        ...field('text', input.text),
        ...field('title', input.title),
        ...field('person_id', person_id),
        ...field('activity_type', activity_type),
        ...field('sitting_date', input.sitting_date),
        ...field('sitting_date_end', input.sitting_date_end),
      },
      notices,
      response.total,
    );
  }

  private async roster(
    query: Record<string, string | number | undefined>,
    current: boolean,
    operation: Operation,
  ): Promise<RawMep[]> {
    const endpoint = current ? 'meps/show-current' : 'meps';
    const first = await this.client.get(endpoint, query, mepSchema, operation);
    const all = [...first.data];
    if (first.next === undefined && (first.total === undefined || first.total <= all.length))
      return all;
    const seen = new Set(all.map((row) => row.id));
    let offset = all.length;
    let total = first.total;
    let response: Envelope<RawMep> = first;
    while (response.next !== undefined || (total ?? Infinity) > all.length) {
      operation.signal.throwIfAborted();
      if (response.next !== undefined) {
        const marker = String(response.next);
        const candidate = /^\d+$/.test(marker)
          ? Number(marker)
          : Number(new URL(marker, 'https://data.europarl.europa.eu/').searchParams.get('offset'));
        if (!Number.isInteger(candidate) || candidate < offset) stalled();
        offset = candidate;
      }
      response = await this.client.get(
        endpoint,
        { ...query, offset, limit: 50 },
        mepSchema,
        operation,
      );
      total = response.total ?? total;
      if (!response.data.length) {
        if (response.next !== undefined || (total !== undefined && all.length < total)) stalled();
        break;
      }
      for (const row of response.data) {
        if (seen.has(row.id)) stalled();
        seen.add(row.id);
        all.push(row);
      }
      offset += response.data.length;
      if (response.next === undefined && total === undefined && response.data.length < 50) break;
      if (response.next === undefined && total !== undefined && all.length >= total) break;
    }
    return all;
  }

  /** Full selected roster is acquired before strict token matching and local paging. */
  async searchMeps(input: MepsInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    term(input.term);
    localPaging(input);
    const country = normalizeCode(input.country, 'country');
    const political_group = normalizeCode(input.political_group, 'political_group');
    const gender = normalizeCode(input.gender, 'gender');
    const tokens = input.name_contains
      ? normalizeName(input.name_contains).split(/\s+/).filter(Boolean)
      : [];
    const filters = {
      scope: input.term === undefined ? 'current' : 'parliamentary_term',
      ...(input.term === undefined
        ? { as_of: new Date(this.client.now()).toISOString().slice(0, 10) }
        : { term: input.term }),
      language: paging.language,
      ...field('country', country),
      ...field('political_group', political_group),
      ...field('gender', gender),
      ...field('name_contains', input.name_contains ? tokens.join(' ') : undefined),
    };
    const all = await this.roster(
      {
        ...(input.term !== undefined && { 'parliamentary-term': input.term }),
        'country-of-representation': country,
        'political-group': political_group,
        gender,
      },
      input.term === undefined,
      operation,
    );
    const selected = all
      .filter((raw) => {
        if (!tokens.length) return true;
        const name = normalizeName(
          [raw.label, raw.givenName, raw.familyName]
            .filter((value) => value !== undefined)
            .join(' '),
        );
        return tokens.every((token) => name.includes(token));
      })
      .sort(
        (a, b) =>
          (a.sortLabel ?? '').localeCompare(b.sortLabel ?? '') ||
          canonicalId(a.id, 'person').localeCompare(canonicalId(b.id, 'person')),
      )
      .map(normalizeMep);
    const page = localPage(selected, paging, filters);
    if (!selected.length)
      notices.push(
        'No MEPs matched. Remove name_contains to browse, relax country or political_group, or call euparl_list_reference with topic mep_filters.',
      );
    return result({ items: page.items, page: page.page }, filters, notices, page.total);
  }

  /** Full memberships remain a separate local collection. */
  async getMep(input: MepInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const mep_id = canonicalId(input.mep_id, 'person');
    const section = input.section ?? 'overview';
    if (section === 'overview' && paging.offset !== 0)
      invalidMode('MEP overview rejects nonzero offset.');
    if (section !== 'overview') localPaging(input);
    const filters = { mep_id, section, language: paging.language };
    const response = await this.client.get(`meps/${mep_id}`, {}, mepSchema, operation);
    const raw = response.data[0];
    const source_url = sourceUrl(`person/${mep_id}`);
    if (!raw) {
      notices.push(
        'No MEP detail was published. Call euparl_search_meps with name_contains or term.',
      );
      return result({ found: false, mep_id, source_url, section }, filters, notices);
    }
    const identity = {
      mep_id,
      source_url,
      ...field('name', raw.label),
      ...field('given_name', raw.givenName),
      ...field('family_name', raw.familyName),
      ...field('citizenship', raw.citizenship),
      ...field('place_of_birth', raw.placeOfBirth),
    };
    const memberships = (raw.hasMembership ?? []).map((membership) => ({
      id: membership.id,
      ...field('organization_id', membership.organization),
      ...field('classification', membership.membershipClassification),
      ...field('role', membership.role),
      ...field('start_date', membership.memberDuring?.startDate),
      ...field('end_date', membership.memberDuring?.endDate),
    }));
    if (section === 'overview')
      return result(
        { found: true, ...identity, section, membership_count: memberships.length },
        filters,
        notices,
      );
    const page = localPage(memberships, paging, filters);
    return result(
      { found: true, ...identity, section, memberships: page.items, page: page.page },
      filters,
      notices,
      page.total,
    );
  }

  /** Sitting decisions are fetched whole, then compact records or voter positions are paged. */
  async getPlenaryVotes(input: VotesInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const mode = input.mode ?? 'decisions';
    year(input.year);
    term(input.roster_term);
    if (mode !== 'voters' && (input.resolve_names || input.roster_term !== undefined))
      invalidMode('Name resolution fields are supported only in voters mode.');
    if (mode === 'sittings') {
      forbid(input, [
        'sitting_id',
        'decision_id',
        'position',
        'resolve_names',
        'roster_term',
        'snapshot',
      ]);
      if (input.year === undefined) invalidMode('year is required for sittings mode.');
      const response = await this.client.get(
        'meetings',
        { ...queryPage(paging), year: input.year },
        sittingSchema,
        operation,
      );
      const sittings = response.data.map((raw) => ({
        sitting_id: raw.activity_id ?? canonicalId(raw.id, 'activity'),
        ...field('date', raw.activity_date),
        ...field('label', localized(raw.activity_label, paging.language, notices)),
        source_url: sourceUrl(raw.id),
      }));
      if (!sittings.length) notices.push('No sittings matched this year. Try another year.');
      return result(
        { mode, sittings, page: upstreamPage(sittings.length, paging, response.total) },
        { mode, year: input.year, language: paging.language },
        notices,
        response.total,
      );
    }
    forbid(input, ['year']);
    let sitting_id = canonicalId(required(input.sitting_id, 'sitting_id'), 'activity');
    if (/^\d{4}-\d{2}-\d{2}$/.test(sitting_id)) sitting_id = `MTG-PL-${date(sitting_id)}`;
    if (!/^MTG-PL-\d{4}-\d{2}-\d{2}$/.test(sitting_id))
      invalidFilter('Use a sitting date or exact MTG-PL-YYYY-MM-DD identifier.');
    date(sitting_id.slice(7));
    if (mode === 'decisions') forbid(input, ['decision_id', 'position']);
    if (mode === 'decision') {
      forbid(input, ['position']);
      detailPaging(input);
    }
    const decision_id =
      mode === 'decisions'
        ? undefined
        : canonicalId(required(input.decision_id, 'decision_id'), 'activity');
    if (mode === 'voters') {
      if (!input.position) invalidMode('position is required for voters mode.');
      if (input.resolve_names && input.roster_term === undefined)
        invalidMode('resolve_names requires roster_term.');
      if (!input.resolve_names && input.roster_term !== undefined)
        invalidMode('roster_term requires resolve_names=true.');
    }
    if (mode === 'decisions' || mode === 'voters') localPaging(input);
    const response = await this.client.get(
      `meetings/${sitting_id}/decisions`,
      {},
      decisionSchema,
      operation,
    );
    const filters = {
      mode,
      sitting_id,
      language: paging.language,
      ...field('decision_id', decision_id),
      ...field('position', input.position),
      ...(mode === 'voters' && {
        resolve_names: input.resolve_names ?? false,
        ...field('roster_term', input.roster_term),
      }),
    };
    if (mode === 'decisions') {
      const page = localPage(response.data.map(normalizeDecisionSummary), paging, filters);
      if (!page.total)
        notices.push(
          'No decision data was published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.',
        );
      return result(
        { mode, sitting_id, decisions: page.items, page: page.page },
        filters,
        notices,
        page.total,
      );
    }
    const raw = response.data.find(
      (row) => (row.activity_id ?? canonicalId(row.id, 'activity')) === decision_id,
    );
    if (!raw)
      throw notFound('Decision is absent from the complete sitting collection.', {
        reason: 'decision_not_found',
      });
    if (decision_id === undefined)
      throw new Error('Decision mode requires its normalized identifier');
    if (mode === 'decision')
      return result(
        {
          mode,
          sitting_id,
          decision_id,
          decision: normalizeDecision(raw, paging.language, notices),
        },
        filters,
        notices,
      );
    const position = input.position;
    if (position === undefined) invalidMode('position is required for voters mode.');
    const ids = decisionVoters(raw, position);
    let voters: { mep_id: string; name?: string }[] = (ids ?? []).map((mep_id) => ({ mep_id }));
    let resolution:
      | { scope: string; term: number; sitting_date?: string; resolved: number; unresolved: number }
      | undefined;
    if (input.resolve_names) {
      const rosterTerm = input.roster_term;
      if (rosterTerm === undefined) invalidMode('resolve_names requires roster_term.');
      const roster = await this.roster({ 'parliamentary-term': rosterTerm }, false, operation);
      const names = new Map(roster.map((row) => [canonicalId(row.id, 'person'), row.label]));
      voters = voters.map((voter) => ({ ...voter, ...field('name', names.get(voter.mep_id)) }));
      const resolved = voters.filter((voter) => voter.name !== undefined).length;
      resolution = {
        scope: 'parliamentary_term',
        term: rosterTerm,
        ...field('sitting_date', raw.activity_date),
        resolved,
        unresolved: voters.length - resolved,
      };
      notices.push(
        'Names are published identities in the selected term roster, not proof of spelling or affiliation on the vote date.',
      );
      if (resolution.unresolved)
        notices.push(
          'Some voter identities are unresolved. Call euparl_get_mep with the returned mep_id.',
        );
    }
    const page = localPage(voters, paging, {
      ...filters,
      ...field('voter_resolution', resolution),
    });
    if (ids === undefined)
      notices.push('This voter position array was not published in the response.');
    return result(
      {
        mode,
        sitting_id,
        decision_id,
        position,
        voters: page.items,
        page: page.page,
        ...field('voter_resolution', resolution),
      },
      filters,
      notices,
      page.total,
      ids !== undefined,
    );
  }

  /** Resolves human citations only after exhausting the published year catalogue. */
  async listQuestions(input: QuestionsInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input);
    const notices = noticesFor(input);
    const mode = input.mode ?? 'list';
    year(input.year);
    term(input.term);
    if (mode === 'list') {
      forbid(input, ['question_id', 'term', 'snapshot']);
      const work_type = normalizeCode(input.work_type, 'question');
      const response = await this.client.get(
        'parliamentary-questions',
        { ...queryPage(paging), year: input.year, 'work-type': work_type },
        questionSchema,
        operation,
      );
      const items = response.data.map((raw) => ({
        question_id: canonicalId(raw.identifier ?? raw.id, 'document'),
        ...field('work_type', raw.work_type),
        source_url: sourceUrl(raw.id),
      }));
      if (!items.length)
        notices.push(
          'No questions matched. Remove work_type or change year; call euparl_list_reference with topic question_types.',
        );
      return result(
        { mode, items, page: upstreamPage(items.length, paging, response.total) },
        {
          mode,
          ...field('year', input.year),
          ...field('work_type', work_type),
          language: paging.language,
        },
        notices,
        response.total,
      );
    }
    forbid(input, ['year', 'work_type']);
    detailPaging(input);
    const citation = required(input.question_id, 'question_id').trim();
    let question_id: string | undefined;
    const human = /^([EPO])-(\d{6})\/(\d{4})$/.exec(citation);
    if (human) {
      if (input.term !== undefined)
        question_id = `${human[1]}-${input.term}-${human[3]}-${human[2]}`;
      else {
        let offset = 0;
        let advertisedTotal: number | undefined;
        const matches = new Set<string>();
        const seenPages = new Set<string>();
        while (true) {
          operation.signal.throwIfAborted();
          const response = await this.client.get(
            'parliamentary-questions',
            { year: human[3], offset, limit: 50 },
            questionSchema,
            operation,
          );
          if (response.total !== undefined)
            advertisedTotal = Math.max(advertisedTotal ?? 0, response.total);
          const ids = response.data.map((row) => canonicalId(row.identifier ?? row.id, 'document'));
          const fingerprint = JSON.stringify(ids);
          if (ids.length && seenPages.has(fingerprint)) stalled();
          seenPages.add(fingerprint);
          for (const id of ids) {
            const match = /^([EPO])-(\d+)-(\d{4})-(\d{6})$/.exec(id);
            if (match && match[1] === human[1] && match[3] === human[3] && match[4] === human[2])
              matches.add(id);
          }
          offset += ids.length;
          if (response.next !== undefined) {
            const marker = String(response.next);
            let candidate: number;
            if (/^\d+$/.test(marker)) candidate = Number(marker);
            else {
              let next: URL;
              try {
                next = new URL(marker, 'https://data.europarl.europa.eu/');
              } catch {
                stalled();
              }
              const parameter = next.searchParams.get('offset');
              if (parameter === null || !/^\d+$/.test(parameter)) stalled();
              candidate = Number(parameter);
            }
            if (!ids.length || !Number.isSafeInteger(candidate) || candidate < offset) stalled();
            offset = candidate;
            continue;
          }
          if (!ids.length) {
            if (advertisedTotal !== undefined && offset < advertisedTotal) stalled();
            break;
          }
          if (advertisedTotal !== undefined ? offset >= advertisedTotal : ids.length < 50) break;
        }
        if (matches.size > 1)
          invalidFilter(
            'Question citation matches multiple terms. Supply term or use a returned canonical question identifier.',
          );
        question_id = [...matches][0];
      }
    } else {
      question_id = canonicalId(citation, 'document');
      const match = /^[EPO]-(\d+)-\d{4}-\d{6}$/.exec(question_id);
      if (!match)
        invalidFilter('Use a canonical question identifier or human E-NNNNNN/YYYY citation.');
      if (input.term !== undefined && Number(match[1]) !== input.term)
        invalidFilter('term conflicts with the canonical question identifier.');
    }
    const filters = {
      mode,
      question_id: question_id ?? citation,
      language: paging.language,
      ...field('term', input.term),
    };
    if (!question_id) {
      notices.push(
        'No matching question was published. Call euparl_list_questions in list mode with the citation year.',
      );
      return result({ mode, found: false }, filters, notices);
    }
    const response = await this.client.get(
      `parliamentary-questions/${question_id}`,
      {},
      questionSchema,
      operation,
    );
    const raw = response.data[0];
    if (raw && canonicalId(raw.identifier ?? raw.id, 'document') !== question_id)
      throw serializationError(
        'Parliament returned a different question identifier than requested.',
      );
    if (!raw)
      notices.push(
        'No question detail was published. Call euparl_list_questions in list mode with the citation year.',
      );
    return result(
      {
        mode,
        found: !!raw,
        ...field('question', raw ? normalizeQuestion(raw, paging.language, notices) : undefined),
      },
      filters,
      notices,
    );
  }
}

let service: EuParliamentService | undefined;
/** Initialize once in createApp setup; tests construct isolated service instances. */
export function initEuParliamentService(
  options: ClientOptions = { fetch: globalThis.fetch },
): void {
  service = new EuParliamentService(options);
}
/** Obtain the initialized domain service at request time. */
export function getEuParliamentService(): EuParliamentService {
  if (!service)
    throw new Error(
      'Parliament service is not initialized. Call initEuParliamentService in setup.',
    );
  return service;
}
