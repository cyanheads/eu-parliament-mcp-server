/**
 * @fileoverview Typed domain operations with complete acquisition and stateless snapshots.
 * @module services/eu-parliament/eu-parliament-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createCounter, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import type { z } from 'zod';
import {
  type ClientOptions,
  type Envelope,
  EuParliamentClient,
  type Operation,
} from './eu-parliament-client.js';
import {
  activityId,
  canonicalId,
  compareText,
  type DecisionSummary,
  decisionVoters,
  documentInputIds,
  field,
  type IdInput,
  type LocalizedText,
  listedVoteItems,
  localized,
  localPage,
  normalizeAdoptedTextRow,
  normalizeDecision,
  normalizeDecisionSummary,
  normalizeDocument,
  normalizeDocumentSummary,
  normalizeMep,
  normalizeName,
  normalizeProcedure,
  normalizeQuestion,
  normalizeSpeech,
  normalizeVoteItem,
  nounForms,
  type PagedCollection,
  type PageWindow,
  type Paging,
  pageCaps,
  pageWindow,
  procedureIds,
  searchResultWindow,
  sourceUrl,
  unnamedVotersNotice,
  upstreamPage,
  type VoterPosition,
} from './eu-parliament-normalization.js';
import {
  documentFamily,
  firstDecisionSitting,
  labelCitation,
  listed,
  normalizeCode,
  politicalGroupNotice,
  type ReferenceEntry,
  type ReferenceTopic,
  referenceEntries,
} from './eu-parliament-reference.js';
import {
  adoptedTextRowSchema,
  bodySchema,
  decisionSchema,
  documentFamilySchema,
  documentSchema,
  mepSchema,
  procedureSchema,
  questionSchema,
  type RawAdoptedTextRow,
  type RawBody,
  type RawDocument,
  type RawMep,
  type RawProcedure,
  type RawQuestion,
  type RawVoteItem,
  sittingSchema,
  speechSchema,
  voteItemSchema,
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
  organization_ids?: string[];
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
/** Speech metadata search or detail, with spoken text on request. */
export interface SpeechesInput extends Paging {
  activity_type?: string;
  include_text?: boolean;
  mode?: 'search' | 'get';
  person_id?: string;
  sitting_date?: string;
  sitting_date_end?: string;
  speech_id?: string;
  term?: 9 | 10;
  text?: string;
  title?: string;
}
/** Complete current, dated, or explicit-term roster filtering. */
export interface MepsInput extends Paging {
  country?: string;
  gender?: string;
  /** YYYY-MM-DD on `meps/show-current`; exclusive with term. */
  mandate_date?: string;
  /** Person IDs in any `euparl_get_mep` form, matched against the acquired roster. */
  mep_ids?: string[];
  name_contains?: string;
  political_group?: string;
  term?: number;
}
/** Identity and separately paged membership history. */
export interface MepInput extends Paging {
  /** Memberships whose published interval includes this YYYY-MM-DD date, both ends inclusive. */
  active_on?: string;
  /** A membershipClassification code, bare or `def/ep-entities/`-prefixed, any case. */
  classification?: string;
  mep_id: string;
  section?: 'overview' | 'memberships';
}
/** The `euparl_get_mep` person identifier grammar: decimal ID, `person/` prefix, or the exact public URI. */
export const personIdPattern = /^(?:https:\/\/data\.europarl\.europa\.eu\/person\/|person\/)?\d+$/;
/** Sitting discovery, compact decisions, rich decision or one voter position. */
export interface VotesInput extends Paging {
  decision_id?: string;
  document_id?: string;
  label_contains?: string;
  mep_id?: string;
  mode?: 'sittings' | 'vote_items' | 'decisions' | 'decision' | 'voters';
  position?: VoterPosition;
  resolve_names?: boolean;
  roster_term?: number;
  sitting_id?: string;
  vote_item_id?: string;
  year?: number;
}
/** Questions resolve exact citations across every term overlapping the citation year. */
export interface QuestionsInput extends Paging {
  mode?: 'list' | 'get';
  question_id?: string;
  term?: number;
  work_type?: string;
  year?: number;
}

function invalidMode(message: string, hint = message): never {
  throw validationError(message, { reason: 'invalid_mode_fields', recovery: { hint } });
}
function invalidFilter(message: string, hint: string): never {
  throw validationError(message, { reason: 'invalid_filter', recovery: { hint } });
}
function meaningful(value: unknown): boolean {
  return (
    value !== undefined && value !== false && !(typeof value === 'string' && value.trim() === '')
  );
}
function forbid<T extends Paging>(input: T, keys: (keyof T & string)[]): void {
  for (const key of keys)
    if (meaningful(input[key]))
      invalidMode(
        `${key} is not supported in this mode.`,
        `Remove ${key}, or select a mode that accepts ${key}.`,
      );
}
function required(value: string | undefined, key: string): string {
  if (!value?.trim())
    invalidMode(`${key} is required in this mode.`, `Supply ${key} for the selected mode.`);
  return value;
}
function detailPaging(input: Paging): void {
  if ((input.offset ?? 0) !== 0 || (input.limit ?? 20) !== 20 || input.snapshot !== undefined)
    invalidMode(
      'Detail mode does not accept paging or snapshot fields.',
      'Remove snapshot and use offset 0 with the default limit 20 for detail mode.',
    );
}
function localPaging(input: Paging): void {
  if ((input.offset ?? 0) > 0 && !input.snapshot)
    invalidMode(
      'Local continuation requires the previous page snapshot.',
      'Pass the previous page.snapshot with the same filters, or restart at offset 0 without snapshot.',
    );
}
/** Literal label selection folds case, Unicode dash punctuation and repeated whitespace. */
function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\p{Dash_Punctuation}\u2212]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}
/** A missing label never matches a normalized `label_contains` query. */
function labelMatches(label: LocalizedText | undefined, query: string): boolean {
  return label !== undefined && normalizeLabel(label.value).includes(query);
}
/** A person identifier the caller passed as `parameter`, with the call that returns one. */
function personInput(parameter: string): IdInput {
  return {
    parameter,
    hint: `Call euparl_search_meps with name_contains for the member's mep_id, then retry with it as ${parameter}.`,
  };
}
/** A procedure identifier the caller passed as `parameter`, with the call that returns one. */
function procedureInput(parameter: string): IdInput {
  return {
    parameter,
    hint: `Call euparl_list_procedures for procedure_id values, then retry with one as ${parameter}.`,
  };
}
/** Older question records name addressees with these URIs, which no Parliament route resolves. */
const authorityCorporateBodies = 'http://publications.europa.eu/resource/authority/corporate-body/';
/**
 * Rejects anything but an existing calendar day, naming `parameter` and quoting `written`, the
 * caller's input when `value` was derived from it.
 */
function date(
  value: string,
  parameter: string,
  {
    hint = 'Pass an existing calendar day as YYYY-MM-DD.',
    written = value,
  }: { hint?: string; written?: string } = {},
): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalidFilter(
      `${parameter} ${JSON.stringify(written)} is not a real calendar date in YYYY-MM-DD form.`,
      hint,
    );
  return value;
}
function dates(input: { sitting_date?: string; sitting_date_end?: string }): void {
  if (input.sitting_date) date(input.sitting_date, 'sitting_date');
  if (input.sitting_date_end) {
    date(input.sitting_date_end, 'sitting_date_end');
    if (!input.sitting_date || input.sitting_date_end < input.sitting_date)
      invalidFilter(
        `sitting_date_end ${JSON.stringify(input.sitting_date_end)} needs a sitting_date on or before it, but sitting_date ${input.sitting_date ? `is ${JSON.stringify(input.sitting_date)}` : 'was not supplied'}.`,
        'Pass sitting_date with sitting_date_end, on or before it.',
      );
  }
}
function scopePage(input: Paging, collection: PagedCollection, resultWindow?: number) {
  const language = normalizeCode(input.language, 'language') ?? 'en';
  return {
    ...pageWindow(input, collection, resultWindow),
    language,
    ...field('snapshot', input.snapshot),
  };
}
function result<T>(
  data: T,
  filters: Record<string, unknown>,
  notices: string[],
  total?: number,
  available?: boolean,
): ServiceResult<T> {
  const page = (data as { page?: { offset: number; returned: number; snapshot?: string } }).page;
  const local =
    page?.snapshot !== undefined ||
    (filters.topic !== undefined &&
      filters.topic !== 'committees' &&
      filters.topic !== 'political_groups');
  if (local && page?.returned === 0 && total !== undefined && total > 0 && page.offset >= total)
    notices.push(
      `The offset ${page.offset} is at or beyond the complete collection of ${total} items. Restart at offset 0 or return to the previous page.`,
    );
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
const limitClamps = createCounter(
  'euparl.limit.clamps',
  'Paged calls whose requested limit was narrowed to a collection cap or search window',
  '{calls}',
);
const loggedClamps = new Set<PagedCollection>();
/**
 * Disclose a limit the collection cap or the search window narrowed. Every clamp is counted;
 * the first per collection is also logged, once per process.
 */
function noticesFor(input: Paging, paging: PageWindow, collection: PagedCollection): string[] {
  const requested = input.limit ?? 20;
  if (paging.limit >= requested) return [];
  const { maximum, noun } = pageCaps[collection];
  const bound = paging.limit < maximum ? 'search_window' : 'collection_cap';
  limitClamps.add(1, { 'euparl.collection': collection, 'euparl.limit.bound': bound });
  if (!loggedClamps.has(collection)) {
    loggedClamps.add(collection);
    logger.info(
      `Limit clamped on ${collection}: requested ${requested}, effective ${paging.limit}; later clamps on this collection are counted, not logged.`,
      requestContextService.createRequestContext({
        operation: 'LimitClamp',
        additionalContext: { collection, bound, requested, effective: paging.limit },
      }),
    );
  }
  return [
    bound === 'search_window'
      ? `Requested limit normalized to ${paging.limit}: offset plus limit cannot pass the ${searchResultWindow}-result search window.`
      : `Requested limit normalized to the effective maximum of ${maximum} ${noun}.`,
  ];
}
const restartAfterNarrowing = 'Restart paging at offset 0 after narrowing.';
/**
 * The limit already narrows inside the window; an offset at or past it cannot be served. `hint`
 * is the caller's route back inside the window.
 */
function searchWindow(paging: PageWindow, hint: string): void {
  if (paging.offset >= searchResultWindow)
    invalidFilter(
      `This search exposes at most ${searchResultWindow} results; offset ${paging.offset} is past the window.`,
      hint,
    );
}
function searchPage(
  returned: number,
  input: PageWindow,
  total: number | undefined,
  notices: string[],
  narrowing: string,
) {
  const page = upstreamPage(returned, input, total, searchResultWindow);
  if (total !== undefined && total >= searchResultWindow)
    notices.push(
      'The upstream total is capped: at least 10000 results match; the exact total is unknown.',
    );
  if (page.has_more && page.next_offset === undefined)
    notices.push(
      `The 10000-result search window is exhausted; further matches cannot be ruled out. ${narrowing}`,
    );
  return { page, total: total !== undefined && total < searchResultWindow ? total : undefined };
}
/**
 * An empty upstream page at offset 0 means nothing matched. Past it, the empty page says nothing
 * about earlier pages (a 204 carries no total), so the notice names only the position.
 */
function emptyNotice(offset: number, collection: PagedCollection, noMatch: string): string {
  return offset > 0
    ? `The page at offset ${offset} returned no ${pageCaps[collection].noun}. Restart at offset 0 or return to the previous page.`
    : noMatch;
}
const documentEndpoints = {
  adopted_texts: 'adopted-texts',
  committee: 'committee-documents',
  plenary: 'plenary-documents',
} as const;
/** Sparse catalogue row; titles, stages and participants need a procedure lookup. */
function procedureRow(raw: RawProcedure) {
  return {
    procedure_id: raw.process_id ?? canonicalId(raw.id, 'procedure'),
    ...field('reference', raw.label),
    ...field('process_type', raw.process_type),
    source_url: sourceUrl(raw.id),
  };
}
function stalled(
  message = 'Parliament pagination did not establish a complete collection. Retry later.',
): never {
  throw serviceUnavailable(message, { reason: 'upstream_paging_stalled', retryable: false });
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** Vote items a steering notice names; it counts the rest, and every decision row lists its own. */
const namedVoteItems = 5;
/**
 * Name the vote items holding decisions document_id matched beside decisions it left out, in
 * first-match order, so a caller starting from a report reaches the whole vote.
 */
function voteItemSteering(
  decisions: DecisionSummary[],
  matched: DecisionSummary[],
): string | undefined {
  const selected = new Set(matched);
  const counts = new Map<string, { all: number; left: number }>();
  for (const decision of decisions)
    for (const item of decision.vote_item_ids) {
      const count = counts.get(item) ?? { all: 0, left: 0 };
      count.all++;
      if (!selected.has(decision)) count.left++;
      counts.set(item, count);
    }
  const split = [...new Set(matched.flatMap((decision) => decision.vote_item_ids))].flatMap(
    (item) => {
      const count = counts.get(item);
      return count?.left ? [{ item, ...count }] : [];
    },
  );
  if (!split.length) return undefined;
  const named = split
    .slice(0, namedVoteItems)
    .map(({ item, all, left }) => `${item} (${left} of ${all} left out)`);
  const rest = split.slice(namedVoteItems);
  if (rest.length)
    named.push(
      `and ${plural(rest.length, 'more vote item')} (${plural(
        rest.reduce((sum, { left }) => sum + left, 0),
        'decision',
      )} left out; each decision row lists its vote_item_ids)`,
    );
  return `document_id left out other decisions of the vote items it matched: ${named.join(', ')}. Pass a vote item as vote_item_id without document_id to read all of its decisions.`;
}
/**
 * Why a decisions page is empty: a sitting that published no decisions routes to sitting
 * discovery whatever the filters; otherwise the filter that matched nothing and the lever that helps.
 */
function decisionsUnmatched(
  decisions: DecisionSummary[],
  document_id: string | undefined,
  vote_item_id: string | undefined,
): string {
  if (!decisions.length)
    return 'No decision data was published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.';
  const related = (decision: DecisionSummary) =>
    decision.document_ids.length > 0 ||
    decision.partial_document_ids.length > 0 ||
    decision.vote_item_ids.length > 0;
  if (!decisions.some(related)) {
    const names = [
      ...(document_id === undefined ? [] : ['document_id']),
      ...(vote_item_id === undefined ? [] : ['vote_item_id']),
    ].join(' and ');
    return `No decision in this sitting publishes a decided-on, part-of or vote-item relation, so a report or vote item cannot select its decisions. Remove ${names} and use label_contains with the report's citation as decision labels write it (${labelCitation}), or, when no decision label carries it, with words of the vote item's title from mode vote_items and language set to the title's language. Matching label text does not establish a final vote.`;
  }
  if (vote_item_id !== undefined) {
    const held = decisions.filter((decision) => decision.vote_item_ids.includes(vote_item_id));
    return held.length > 0
      ? `No decision of vote_item_id matched document_id. Remove document_id to read the vote item's ${plural(held.length, 'decision')}.`
      : 'No decision in this sitting belongs to vote_item_id. Remove vote_item_id to inspect all published decisions.';
  }
  return decisions.some((decision) => decision.vote_item_ids.length > 0)
    ? "No decisions matched document_id in the complete sitting. A vote can decide on no document: pass the procedure's PLENARY_VOTE_RESULTS event id as vote_item_id, or remove document_id to inspect all published decisions."
    : 'No decisions matched document_id in the complete sitting. Remove document_id to inspect all published decisions.';
}
/**
 * A sitting's vote items in published order, without the roll-call, split and separate-vote
 * requests published beside them. Every item embeds its sitting's complete vote-item list, so a
 * read missing a listed item (the route documents a default page of 50) is incomplete.
 */
function sittingVoteItems(
  raws: RawVoteItem[],
  sitting_id: string,
  language: string,
  notices: string[],
) {
  const items = raws.filter(
    (raw) => raw.had_activity_type?.split('/').at(-1) === 'PLENARY_VOTE_RESULTS',
  );
  const returned = new Set(items.map((raw) => sourceUrl(raw.id)));
  const sittingList = new Set(items.flatMap((raw) => listedVoteItems(raw, sitting_id)));
  const present = [...sittingList].filter((id) => returned.has(id)).length;
  if (present < sittingList.size)
    stalled(
      `Parliament returned ${present} of the ${sittingList.size} vote items this sitting lists. Retry later.`,
    );
  return items.map((raw) => normalizeVoteItem(raw, language, notices));
}

/** Public GET workflow service; one client instance shares pacing across operations. */
export class EuParliamentService {
  readonly client: EuParliamentClient;
  constructor(options: ClientOptions) {
    this.client = new EuParliamentClient(options);
  }

  /**
   * Fixed 100-row geometry keeps equal-sort-key ordering independent of caller page sizes.
   * `compare` puts each aligned page in a fixed order before it is sliced, for a view that returns
   * a page's rows in varying order.
   */
  private async alignedSearch<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: z.ZodType<T>,
    operation: Operation,
    paging: PageWindow,
    { compare }: { compare?: (a: T, b: T) => number } = {},
  ): Promise<Envelope<T>> {
    const size = 100;
    const data: T[] = [];
    let total: number | undefined;
    for (
      let offset = Math.floor(paging.offset / size) * size;
      offset < paging.offset + paging.limit;
      offset += size
    ) {
      const response = await this.client.get(
        path,
        { ...query, offset, limit: size },
        schema,
        operation,
      );
      total = response.total ?? total;
      const start = Math.max(0, paging.offset - offset);
      const rows = compare ? response.data.toSorted(compare) : response.data;
      data.push(...rows.slice(start, Math.min(size, paging.offset + paging.limit - offset)));
      if (response.data.length < size || (total !== undefined && offset + size >= total)) {
        // A short aligned page establishes its end even when the upstream omits a total.
        if (response.data.length > 0 || offset === 0) total ??= offset + response.data.length;
        break;
      }
    }
    return { status: data.length ? 'ok' : 'empty', data, ...field('total', total) };
  }

  /** Live bodies page upstream; static tables page without snapshots. */
  async listReference(input: ReferenceInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const collection =
      input.topic === 'organizations'
        ? 'organizations'
        : input.topic === 'committees' || input.topic === 'political_groups'
          ? 'reference'
          : 'static_reference';
    const paging = scopePage(input, collection);
    const notices = noticesFor(input, paging, collection);
    const normalizeBody = (raw: RawBody) => ({
      code: raw.identifier ?? raw.id,
      id: raw.id,
      ...field('classification', raw.classification),
      ...field(
        'label',
        typeof raw.label === 'string'
          ? { value: raw.label, language: 'mul' }
          : localized(raw.label, paging.language, notices),
      ),
      ...field('name', localized(raw.prefLabel, paging.language, notices)),
      ...field('start_date', raw.temporal?.startDate),
      ...field('end_date', raw.temporal?.endDate),
    });
    if (input.topic === 'organizations') {
      if (!input.organization_ids?.length)
        invalidMode(
          'organizations requires nonempty organization_ids.',
          'Supply a nonempty organization_ids list for topic organizations.',
        );
      // The whole list is checked before any request; an entry is named by its 1-based position.
      const ids = input.organization_ids.map((id, index) => {
        const parameter = `organization_ids entry ${index + 1}`;
        if (id.trim().startsWith(authorityCorporateBodies))
          invalidFilter(
            `${parameter} ${JSON.stringify(id)} is an EU authority URI, not a Parliament organization identifier. Accepted forms: ${nounForms.organization.forms}.`,
            "Remove EU authority URIs from organization_ids: Parliament publishes no organization record for them, and a trailing code is no substitute (COM here is the Communist and Allies Group). A question's alternative_title names its addressee in words.",
          );
        return canonicalId(id, 'organization', {
          parameter,
          hint: 'Call euparl_list_reference with topic political_groups or committees for group and committee codes, or take organization IDs from euparl_get_mep memberships or euparl_get_procedure participants, then retry organization_ids.',
        });
      });
      const items: ReferenceEntry[] = [];
      for (const organization_id of ids.slice(paging.offset, paging.offset + paging.limit)) {
        const response = await this.client.get(
          `corporate-bodies/${organization_id}`,
          {},
          bodySchema,
          operation,
        );
        const identity = { organization_id, source_url: sourceUrl(`org/${organization_id}`) };
        if (response.status === 'empty' || response.status === 'missing') {
          items.push({ code: organization_id, found: false, ...identity });
          continue;
        }
        const raw = response.data[0];
        if (
          response.data.length !== 1 ||
          !raw ||
          (raw.id !== `org/${organization_id}` && raw.id !== sourceUrl(`org/${organization_id}`))
        )
          throw serializationError(
            'Parliament returned an unexpected organization detail identity or record count.',
            { retryable: false },
          );
        items.push({ ...normalizeBody(raw), found: true, ...identity });
      }
      if (!items.length)
        notices.push(
          'No organization IDs remain at this offset. Restart at offset 0 or supply another organization_ids list.',
        );
      return result(
        { topic: input.topic, items, page: upstreamPage(items.length, paging, ids.length) },
        { topic: input.topic, language: paging.language, organization_ids: ids },
        notices,
        ids.length,
      );
    }
    if (input.organization_ids !== undefined)
      invalidMode(
        'organization_ids is supported only with topic organizations.',
        'Remove organization_ids, or use topic organizations to resolve those identifiers.',
      );
    if (input.topic === 'committees' || input.topic === 'political_groups') {
      const classification =
        input.topic === 'committees' ? 'COMMITTEE_PARLIAMENTARY_STANDING' : 'EU_POLITICAL_GROUP';
      const response = await this.client.get(
        'corporate-bodies',
        { offset: paging.offset, limit: paging.limit, 'body-classification': classification },
        bodySchema,
        operation,
      );
      const items = response.data.map(normalizeBody);
      if (!items.length)
        notices.push(
          emptyNotice(
            paging.offset,
            'reference',
            'No reference entries matched. Call euparl_list_reference with topic identifiers to inspect accepted identifiers.',
          ),
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
    return result(
      { topic: input.topic, items, page: upstreamPage(items.length, paging, all.length) },
      { topic: input.topic, language: paging.language },
      notices,
      all.length,
    );
  }

  /**
   * Catalogue rows deliberately do not claim procedure titles. Parliament serves each
   * `/procedures` request from one of two orderings of the same set, so upstream offsets repeat
   * and skip rows across calls. A `process_type` set fits inside the 10000-result window, so it is
   * acquired whole in one request and paged locally in `procedure_id` order; its snapshot is
   * optional because that order is deterministic for an unchanged set. Unfiltered listings exceed
   * the window, so they keep upstream paging and disclose the overlap.
   */
  async listProcedures(input: ProceduresInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const process_type = normalizeCode(input.process_type, 'process_type');
    const filters = { ...field('process_type', process_type) };
    const noMatches =
      'No procedures matched. Remove process_type or call euparl_list_reference with topic procedure_types.';
    if (process_type === undefined) {
      const paging = scopePage(input, 'procedures', searchResultWindow);
      if (input.snapshot !== undefined)
        invalidMode(
          'snapshot applies only to a process_type listing.',
          'Remove snapshot, or repeat the call with the process_type of the listing that returned it.',
        );
      const notices = noticesFor(input, paging, 'procedures');
      const narrowing = 'Narrow process_type to retrieve a smaller procedure set.';
      searchWindow(paging, `${narrowing} ${restartAfterNarrowing}`);
      const response = await this.client.get(
        'procedures',
        { offset: paging.offset, limit: paging.limit },
        procedureSchema,
        operation,
      );
      const items = response.data.map(procedureRow);
      if (!items.length) notices.push(emptyNotice(paging.offset, 'procedures', noMatches));
      const paged = searchPage(items.length, paging, response.total, notices, narrowing);
      notices.push(
        'Parliament serves each page of the unfiltered procedure listing from one of two orderings, so pages reached through next_offset can repeat some procedures and omit others. Set process_type for a complete walk in procedure_id order.',
      );
      return result({ items, page: paged.page }, filters, notices, paged.total);
    }
    const paging = scopePage(input, 'local_procedures');
    const notices = noticesFor(input, paging, 'local_procedures');
    const response = await this.client.get(
      'procedures',
      { offset: 0, limit: searchResultWindow, 'process-type': process_type },
      procedureSchema,
      operation,
    );
    const items = response.data
      .map(procedureRow)
      .toSorted((a, b) => compareText(a.procedure_id, b.procedure_id));
    const distinct = new Set(items.map((item) => item.procedure_id)).size;
    // A total at the window is capped, and a full window without one may be cut: neither is whole.
    const atWindow =
      response.total === undefined
        ? items.length >= searchResultWindow
        : response.total >= searchResultWindow;
    if (atWindow || distinct < items.length || distinct < (response.total ?? 0))
      stalled(
        `Parliament returned ${distinct} distinct procedures in ${items.length} rows for process_type ${process_type} against a reported total of ${response.total ?? 'none'}, so the complete set was not acquired. Retry later.`,
      );
    if (!items.length) notices.push(noMatches);
    const page = localPage(items, paging, filters);
    return result({ items: page.items, page: page.page }, filters, notices, page.total);
  }

  /** Overview omits collections; selected sections use complete-record snapshots. */
  async getProcedure(input: ProcedureInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input, 'procedure_sections');
    const notices = noticesFor(input, paging, 'procedure_sections');
    const procedure_id = canonicalId(
      input.procedure_id,
      'procedure',
      procedureInput('procedure_id'),
    );
    const section = input.section ?? 'overview';
    if (section === 'overview' && paging.offset !== 0)
      invalidMode(
        'Procedure overview rejects nonzero offset.',
        'Use offset 0 for overview, or select events, participants or documents for continuation.',
      );
    if (section !== 'overview') localPaging(input);
    const response = await this.client.get(
      `procedures/${procedure_id}`,
      {},
      procedureSchema,
      operation,
    );
    const raw = response.data[0];
    const filters = { procedure_id, section, language: paging.language };
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
        filters,
        notices,
      );
    }
    const requestedType = /\(([A-Z]+)\)$/.exec(input.procedure_id)?.[1];
    const publishedType = raw.process_type?.split('/').at(-1);
    if (requestedType && publishedType !== requestedType)
      invalidFilter(
        `procedure_id ${JSON.stringify(input.procedure_id)} names type ${requestedType}, but Parliament publishes ${publishedType === undefined ? `no type for procedure ${procedure_id}` : `procedure ${procedure_id} as type ${publishedType}`}.`,
        `Retry with procedure_id ${procedure_id}, without the type suffix${publishedType === undefined ? '' : `, or ${procedure_id}(${publishedType})`}.`,
      );
    const { events, participants, documents, ...overview } = normalizeProcedure(
      raw,
      paging.language,
      notices,
    );
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
    const source = input.source ?? 'adopted_texts';
    const keywords = meaningful(input.text) || meaningful(input.title);
    const collection =
      source === 'adopted_texts'
        ? keywords
          ? 'keyword_documents'
          : 'adopted_documents'
        : 'documents';
    const paging = scopePage(
      input,
      collection,
      source === 'adopted_texts' ? searchResultWindow : undefined,
    );
    const notices = noticesFor(input, paging, collection);
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
      const candidates = documentInputIds(required(input.document_id, 'document_id'));
      let [document_id] = candidates;
      let raw: RawDocument | undefined;
      for (const candidate of candidates) {
        raw = (await this.client.get(`documents/${candidate}`, {}, documentSchema, operation))
          .data[0];
        if (!raw) continue;
        // A citation naming two families is answered only by the record carrying the read identity.
        if (
          candidates.length > 1 &&
          canonicalId(raw.identifier ?? raw.id, 'document') !== candidate
        )
          throw serializationError(
            'Parliament returned a different document identifier than requested.',
          );
        document_id = candidate;
        break;
      }
      if (!raw)
        notices.push(
          candidates.length > 1
            ? `No document detail was published as ${candidates.join(' or ')}. Call euparl_search_documents in search mode to discover identifiers.`
            : 'No document detail was published. Call euparl_search_documents in search mode to discover identifiers.',
        );
      const familyIds = raw ? await this.familyProcedureIds(raw, operation, notices) : [];
      return result(
        {
          mode,
          found: !!raw,
          ...field(
            'document',
            raw ? normalizeDocument(raw, paging.language, notices, familyIds) : undefined,
          ),
        },
        { mode, document_id, language: paging.language },
        notices,
      );
    }
    forbid(input, ['document_id', 'snapshot']);
    const narrowing =
      'Narrow text, title, year, term, work_type, sitting dates or related_process_id.';
    if (source === 'adopted_texts') searchWindow(paging, `${narrowing} ${restartAfterNarrowing}`);
    dates(input);
    const adoptedOnly = (
      ['text', 'title', 'sitting_date', 'sitting_date_end', 'related_process_id'] as const
    ).filter((key) => meaningful(input[key]));
    if (source !== 'adopted_texts' && adoptedOnly.length)
      invalidFilter(
        `${listed(adoptedOnly)} ${adoptedOnly.length === 1 ? 'is' : 'are'} accepted only with source "adopted_texts", not with source ${JSON.stringify(source)}.`,
        'Use source adopted_texts for text, title, sitting_date, sitting_date_end or related_process_id, or remove those filters.',
      );
    if (source === 'committee' && input.year !== undefined)
      invalidFilter(
        'Committee documents do not support year.',
        'Remove year for committee documents; use term and work_type to narrow this family.',
      );
    if (source === 'plenary' && input.term !== undefined)
      invalidFilter(
        'Plenary documents do not support term.',
        'Remove term for plenary documents; use year and work_type to narrow this family.',
      );
    const work_type = normalizeCode(input.work_type, source);
    const related_process_id = input.related_process_id
      ? canonicalId(input.related_process_id, 'procedure', procedureInput('related_process_id'))
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
      offset: paging.offset,
      limit: paging.limit,
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
        language: paging.language,
      }),
    };
    if (source === 'adopted_texts' && keywords)
      notices.push(
        'Keyword searches retain upstream relevance order; pages can repeat or omit records as ordering changes.',
      );
    const { items, total } =
      source === 'adopted_texts'
        ? await this.adoptedTextRows(query, keywords, paging, operation, notices)
        : await this.client
            .get(documentEndpoints[source], query, documentSchema, operation)
            .then((response) => ({
              items: response.data.map(normalizeDocumentSummary),
              total: response.total,
            }));
    if (!items.length)
      notices.push(
        emptyNotice(
          paging.offset,
          'documents',
          'No documents matched. Remove a named filter, or call euparl_list_reference with topic document_types; keyword search is available only for adopted_texts.',
        ),
      );
    const paged =
      source === 'adopted_texts'
        ? searchPage(items.length, paging, total, notices, narrowing)
        : { page: upstreamPage(items.length, paging, total), total };
    return result({ mode, source, items, page: paged.page }, filters, notices, paged.total);
  }

  /**
   * Adopted-text rows in the requested language: keyword searches keep relevance order; other
   * searches read aligned pages reordered by document_id, since `language=` returns the page set
   * of the sorted list in varying order. Returned rows without a title in that language are counted.
   */
  private async adoptedTextRows(
    query: Record<string, string | number | undefined>,
    keywords: boolean,
    paging: PageWindow & { language: string },
    operation: Operation,
    notices: string[],
  ) {
    const path = documentEndpoints.adopted_texts;
    const documentId = (raw: RawAdoptedTextRow) =>
      canonicalId(raw.identifier ?? raw.id, 'document');
    const response = keywords
      ? await this.client.get(path, query, adoptedTextRowSchema, operation)
      : await this.alignedSearch(
          path,
          { ...query, 'sort-by': 'doc-id:asc' },
          adoptedTextRowSchema,
          operation,
          paging,
          { compare: (a, b) => compareText(documentId(a), documentId(b)) },
        );
    const items = response.data.map((raw) => normalizeAdoptedTextRow(raw, paging.language));
    const untitled = items.filter((item) => item.title === undefined).length;
    if (untitled)
      notices.push(
        `${plural(untitled, 'row')} on this page ${untitled === 1 ? 'has' : 'have'} no title in ${paging.language}, the only language the adopted-text list returns; mode get with a row's document_id reads its title in another published language.`,
      );
    return { items, total: response.total };
  }

  /**
   * Procedures of an adopted text, plenary or committee document, published only on its family
   * record: one attempt inside the get's deadline, with `language=mul` so no expression is
   * embedded. 204/404 means the family publishes no record. Any other classified failure leaves
   * the generic answer standing with a notice; caller cancellation and unclassified throws
   * propagate.
   */
  private async familyProcedureIds(
    raw: RawDocument,
    operation: Operation,
    notices: string[],
  ): Promise<string[]> {
    const family = documentFamily(raw.work_type);
    if (!family) return [];
    const document_id = canonicalId(raw.identifier ?? raw.id, 'document');
    try {
      const response = await this.client.get(
        `${documentEndpoints[family]}/${document_id}`,
        { language: 'mul' },
        documentFamilySchema,
        operation,
        { attempts: 1 },
      );
      if (response.status !== 'ok') return [];
      const [record] = response.data;
      if (response.data.length === 1 && record?.id === raw.id)
        return procedureIds(record.inverse_created_a_realization_of);
    } catch (error) {
      if (operation.callerSignal.aborted || !(error instanceof McpError)) throw error;
    }
    notices.push(
      `The procedure relation could not be read from the ${family} family record of this document, so procedure_ids may be incomplete; repeat the same get to retry.`,
    );
    return [];
  }

  /**
   * Speech metadata, and with `include_text` the published text of each speech: one request per
   * get, and at most 100 search rows per call because text pages run about 1.7× the bytes.
   */
  async searchSpeeches(input: SpeechesInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const keywords = meaningful(input.text) || meaningful(input.title);
    const text = input.include_text === true;
    const collection = text ? 'text_speeches' : keywords ? 'keyword_speeches' : 'speeches';
    const paging = scopePage(input, collection, searchResultWindow);
    const notices = noticesFor(input, paging, collection);
    const mode = input.mode ?? 'search';
    const textQuery = text ? { 'include-output': 'xml_fragment', language: paging.language } : {};
    /**
     * Text requests narrow title and text to one language; name the rows that lack either. Chair
     * rows publish no title in any language, so no retry could supply one and they are not counted.
     */
    const textNotice = (speeches: ReturnType<typeof normalizeSpeech>[]) => {
      const titles = speeches.filter(
        (speech) =>
          !speech.title && speech.activity_type !== 'def/ep-activities/MEETING_NAME_CHAIR',
      ).length;
      const texts = speeches.filter((speech) => speech.document_ids.length && !speech.text).length;
      if (!text || (!titles && !texts)) return;
      const { language } = paging;
      const missing = [
        ...(titles ? [`title on ${titles}`] : []),
        ...(texts ? [`text on ${texts}`] : []),
      ].join(' and ');
      notices.push(
        `include_text returns title and text only in the requested language ${language}, without fallback. Missing in ${language}: ${missing} of ${speeches.length} ${speeches.length === 1 ? 'speech' : 'speeches'}. Retry with ${language === 'en' ? '' : 'language en or '}a language in the speech's original_languages.`,
      );
    };
    if (mode === 'get') {
      forbid(input, [
        'text',
        'title',
        'person_id',
        'activity_type',
        'term',
        'sitting_date',
        'sitting_date_end',
      ]);
      detailPaging(input);
      const speech_id = canonicalId(required(input.speech_id, 'speech_id'), 'activity', {
        parameter: 'speech_id',
        hint: 'Call euparl_search_speeches in search mode for speech_id values, then retry mode get with one.',
      });
      const response = await this.client.get(
        `speeches/${speech_id}`,
        textQuery,
        speechSchema,
        operation,
      );
      const raw = response.data[0];
      if (!raw)
        notices.push('No speech detail was published. Call euparl_search_speeches in search mode.');
      const speech = raw ? normalizeSpeech(raw, paging.language, notices, { text }) : undefined;
      if (speech) textNotice([speech]);
      return result(
        { mode, found: !!raw, ...field('speech', speech) },
        { mode, speech_id, language: paging.language, ...(text && { include_text: true }) },
        notices,
      );
    }
    forbid(input, ['speech_id', 'snapshot']);
    const term = input.term ?? 10;
    const narrowing = 'Narrow text, title, person_id, activity_type or sitting dates.';
    searchWindow(paging, `${narrowing} ${restartAfterNarrowing}`);
    dates(input);
    const activity_type = normalizeCode(input.activity_type, 'activity_type');
    const person_id = input.person_id
      ? canonicalId(input.person_id, 'person', personInput('person_id'))
      : undefined;
    const query = {
      offset: paging.offset,
      limit: paging.limit,
      text: input.text,
      title: input.title,
      'person-id': person_id,
      'activity-type': activity_type,
      'search-language': paging.language,
      'parliamentary-term': term,
      'sitting-date': input.sitting_date,
      'sitting-date-end': input.sitting_date_end,
      ...textQuery,
    };
    const response = keywords
      ? await this.client.get('speeches', query, speechSchema, operation)
      : await this.alignedSearch(
          'speeches',
          { ...query, 'sort-by': 'sitting-date:asc,numbering:asc' },
          speechSchema,
          operation,
          paging,
        );
    if (keywords)
      notices.push(
        'Keyword searches retain upstream relevance order; pages can repeat or omit records as ordering changes.',
      );
    const items = response.data.map((raw) =>
      normalizeSpeech(raw, paging.language, notices, { text }),
    );
    textNotice(items);
    if (!items.length)
      notices.push(
        emptyNotice(
          paging.offset,
          'speeches',
          `No speech records matched in term ${term}${input.term === undefined ? ' (the default)' : ''}. Term 9 ran 2019-07-02 to 2024-07-15 and term 10 began 2024-07-16; ${input.sitting_date === undefined ? 'pass term to search the other term' : 'pass the term containing sitting_date'}. Speech records do not cover every date of a term; euparl_list_reference topic coverage gives the dates they cover. Otherwise broaden sitting_date or remove person_id; call euparl_list_reference with topic activity_types.`,
        ),
      );
    const paged = searchPage(items.length, paging, response.total, notices, narrowing);
    return result(
      { mode, items, page: paged.page },
      {
        mode,
        language: paging.language,
        term,
        ...field('text', input.text),
        ...field('title', input.title),
        ...field('person_id', person_id),
        ...field('activity_type', activity_type),
        ...field('sitting_date', input.sitting_date),
        ...field('sitting_date_end', input.sitting_date_end),
        ...(text && { include_text: true }),
      },
      notices,
      paged.total,
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
    }
    return all;
  }

  private utcToday(): string {
    return new Date(this.client.now()).toISOString().slice(0, 10);
  }

  /** Full selected roster is acquired before strict token matching and local paging. */
  async searchMeps(input: MepsInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input, 'meps');
    const notices = noticesFor(input, paging, 'meps');
    localPaging(input);
    const today = this.utcToday();
    const mandate_date = input.mandate_date?.trim() ? input.mandate_date : undefined;
    if (mandate_date !== undefined) {
      if (input.term !== undefined)
        invalidMode(
          'Supply term or mandate_date, not both: term selects a term roster, mandate_date the members seated on that date.',
        );
      date(mandate_date, 'mandate_date');
      // Parliament answers a future date with today's roster, which would misreport the date.
      if (mandate_date > today)
        invalidFilter(
          `mandate_date ${JSON.stringify(mandate_date)} is after the current UTC date ${today}.`,
          `Use a mandate_date on or before ${today}, or omit mandate_date for members in office today.`,
        );
    }
    const country = normalizeCode(input.country, 'country');
    const groupRoster = { term: input.term, mandate_date };
    const political_group = normalizeCode(input.political_group, 'political_group', groupRoster);
    const gender = normalizeCode(input.gender, 'gender');
    const tokens = input.name_contains
      ? normalizeName(input.name_contains).split(/\s+/).filter(Boolean)
      : [];
    // A tokenless nonblank filter would otherwise match every row and return the whole roster.
    if (!tokens.length && input.name_contains?.trim())
      invalidFilter(
        `name_contains ${JSON.stringify(input.name_contains)} has no letter or digit after case, diacritic, and punctuation normalization.`,
        'Include at least one letter or digit in name_contains, or omit name_contains to browse the roster.',
      );
    // Canonical, deduplicated in first-seen order; an empty list is the same call as none.
    const mepIdsInput = {
      parameter: 'mep_ids entry',
      hint: 'Retry euparl_search_meps with only person IDs in mep_ids; resolve org/ identifiers with euparl_list_reference topic organizations and organization_ids instead.',
    };
    const wanted = new Set(
      (input.mep_ids ?? []).map((entry) => {
        if (!personIdPattern.test(entry.trim()))
          invalidFilter(
            `${mepIdsInput.parameter} ${JSON.stringify(entry)} is not ${nounForms.person.name}. Accepted forms: ${nounForms.person.forms}.`,
            mepIdsInput.hint,
          );
        return canonicalId(entry, 'person', mepIdsInput);
      }),
    );
    const mep_ids = [...wanted];
    const filters = {
      ...(input.term !== undefined
        ? { scope: 'parliamentary_term', term: input.term }
        : mandate_date !== undefined
          ? { scope: 'mandate_date', mandate_date }
          : { scope: 'current', as_of: today }),
      language: paging.language,
      ...field('country', country),
      ...field('political_group', political_group),
      ...field('gender', gender),
      ...field('name_contains', tokens.length ? tokens.join(' ') : undefined),
      ...field('mep_ids', mep_ids.length ? mep_ids : undefined),
    };
    const all = await this.roster(
      {
        ...(input.term !== undefined && { 'parliamentary-term': input.term }),
        ...(mandate_date !== undefined && { 'mandate-date': mandate_date }),
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
      .map(normalizeMep)
      .filter((row) => !wanted.size || wanted.has(row.mep_id));
    const returned = new Set(selected.map((row) => row.mep_id));
    const unmatched = mep_ids.filter((id) => !returned.has(id));
    const page = localPage(selected, paging, filters);
    if (!selected.length) {
      notices.push(
        'No MEPs matched. Remove name_contains to browse, relax country or political_group, or call euparl_list_reference with topic mep_filters.',
      );
      if (!all.length && input.term === undefined && political_group !== undefined)
        notices.push(
          mandate_date !== undefined
            ? "On a mandate_date roster, political_group matches only the group code in force on that date; omit political_group and read each member's published political_group."
            : "On the current roster, political_group matches only the group code in force today; pass mandate_date or term for an earlier group, or omit political_group and read each member's published political_group.",
        );
    }
    // Parliament matches a term roster against any membership in the code still open at the term's start.
    if (input.term !== undefined && political_group !== undefined)
      notices.push(
        'On a term roster, political_group matches each member of the term holding a membership in that code that had not ended when the term began, including memberships that began later, even after the term ended; it does not show who sat in the group during the term. Pass mandate_date instead of term for the members published under a code on one day.',
      );
    const groupNotice = politicalGroupNotice(input.political_group, political_group, groupRoster);
    if (groupNotice !== undefined) notices.push(groupNotice);
    if (unmatched.length)
      notices.push(
        `${plural(unmatched.length, 'requested mep_id')} matched no row of the selected roster after the other filters; unmatched_mep_ids lists ${unmatched.length === 1 ? 'it' : 'them'}. A term roster holds only that term's members and a mandate_date roster only members seated that day; euparl_get_mep reads any member by ID.`,
      );
    return result(
      {
        items: page.items,
        ...(mep_ids.length > 0 && { unmatched_mep_ids: unmatched }),
        page: page.page,
      },
      filters,
      notices,
      page.total,
    );
  }

  /**
   * Full memberships remain a separate local collection, latest start first, filtered by
   * classification and date before paging; the overview counts them by classification.
   */
  async getMep(input: MepInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input, 'memberships');
    const notices = noticesFor(input, paging, 'memberships');
    const mep_id = canonicalId(input.mep_id, 'person', personInput('mep_id'));
    const section = input.section ?? 'overview';
    if (section === 'overview' && paging.offset !== 0)
      invalidMode(
        'MEP overview rejects nonzero offset.',
        'Use offset 0 for overview, or select memberships for continuation.',
      );
    const requestedClassification = input.classification?.trim() || undefined;
    const active_on = input.active_on?.trim() || undefined;
    if (section === 'overview') {
      if (requestedClassification !== undefined)
        invalidMode(
          `classification ${JSON.stringify(input.classification)} filters membership rows, which only section "memberships" returns.`,
          'Retry with section "memberships" and the same classification, or remove classification; the overview lists the codes in membership_classifications.',
        );
      if (active_on !== undefined)
        invalidMode(
          `active_on ${JSON.stringify(input.active_on)} filters membership rows, which only section "memberships" returns.`,
          'Retry with section "memberships" and the same active_on, or remove active_on; the overview counts every membership.',
        );
    } else localPaging(input);
    let classification: string | undefined;
    if (requestedClassification !== undefined) {
      const code = /^(?:def\/ep-entities\/)?([A-Za-z0-9_-]+)$/i.exec(requestedClassification)?.[1];
      if (code === undefined)
        invalidFilter(
          `classification ${JSON.stringify(input.classification)} is not a membership classification code. Accepted forms: a code such as COMMITTEE_PARLIAMENTARY_STANDING, bare or as published (def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING), in any case.`,
          'Call euparl_get_mep with this mep_id and no classification; its membership_classifications lists the codes this history carries.',
        );
      classification = code.toUpperCase();
    }
    if (active_on !== undefined) {
      date(active_on, 'active_on', {
        hint: 'Pass active_on as an existing calendar day in YYYY-MM-DD form, such as 2024-07-19.',
      });
      const today = this.utcToday();
      if (active_on > today)
        invalidFilter(
          `active_on ${JSON.stringify(active_on)} is after the current UTC date ${today}.`,
          `Pass an active_on on or before ${today}, or omit active_on to keep every period.`,
        );
    }
    const filters = {
      mep_id,
      section,
      language: paging.language,
      ...field('classification', classification),
      ...field('active_on', active_on),
    };
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
    const memberships = (raw.hasMembership ?? [])
      .map((membership) => ({
        id: membership.id,
        ...field('organization_id', membership.organization),
        ...field('classification', membership.membershipClassification),
        ...field('role', membership.role),
        ...field('start_date', membership.memberDuring?.startDate),
        ...field('end_date', membership.memberDuring?.endDate),
      }))
      // Latest start first, undated last, then id and the whole record: one order on every read.
      .sort(
        (a, b) =>
          Number(a.start_date === undefined) - Number(b.start_date === undefined) ||
          compareText(b.start_date ?? '', a.start_date ?? '') ||
          compareText(a.id, b.id) ||
          compareText(JSON.stringify(a), JSON.stringify(b)),
      );
    // A classification matches on the last path segment of the published value, in any case.
    const codeOf = (published: string | undefined) =>
      published?.slice(published.lastIndexOf('/') + 1).toUpperCase() || undefined;
    const counts = new Map<string, number>();
    for (const row of memberships) {
      const code = codeOf(row.classification);
      if (code !== undefined) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const carried = [...counts].sort(([a], [b]) => compareText(a, b));
    if (section === 'overview')
      return result(
        {
          found: true,
          ...identity,
          section,
          membership_count: memberships.length,
          membership_classifications: carried.map(([code, count]) => ({
            classification: code,
            count,
          })),
        },
        filters,
        notices,
      );
    const selected = memberships.filter(
      (row) =>
        (classification === undefined || codeOf(row.classification) === classification) &&
        (active_on === undefined ||
          (row.start_date !== undefined &&
            row.start_date <= active_on &&
            (row.end_date === undefined || active_on <= row.end_date))),
    );
    if (!selected.length && memberships.length) {
      const unclassified = memberships.length - carried.reduce((sum, [, count]) => sum + count, 0);
      if (classification !== undefined && !counts.has(classification))
        notices.push(
          carried.length
            ? `No membership in this history has classification ${classification}. It carries ${listed(carried.map(([code, count]) => `${code} (${count})`))}${unclassified ? `, and ${plural(unclassified, 'membership')} ${unclassified === 1 ? 'has' : 'have'} no classification` : ''}. Retry with one of those codes, or remove classification.`
            : `No membership in this history carries a classification, so classification ${classification} matches none of its ${plural(memberships.length, 'membership')}. Remove classification.`,
        );
      else if (active_on !== undefined)
        notices.push(
          `No membership${classification === undefined ? '' : ` classified ${classification}`} has a published interval including active_on ${active_on} (start_date on or before it, end_date on or after it or absent). Remove active_on to read every period; an absent end date does not establish current membership.`,
        );
    }
    const page = localPage(selected, paging, filters);
    return result(
      { found: true, ...identity, section, memberships: page.items, page: page.page },
      filters,
      notices,
      page.total,
    );
  }

  /**
   * Sitting vote items or decisions are fetched whole, then vote items, compact records or voter
   * positions are paged.
   */
  async getPlenaryVotes(input: VotesInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const mode = input.mode ?? 'decisions';
    const collection =
      mode === 'sittings' || mode === 'vote_items' || mode === 'voters' ? mode : 'decisions';
    const paging = scopePage(input, collection);
    const notices = noticesFor(input, paging, collection);
    if (mode !== 'decisions') forbid(input, ['document_id', 'vote_item_id']);
    if (mode !== 'decisions' && mode !== 'vote_items') forbid(input, ['label_contains']);
    if (mode !== 'decision' && mode !== 'decisions' && meaningful(input.mep_id))
      invalidMode(
        'mep_id is supported only in decisions and decision modes.',
        'Remove mep_id, or use mode decisions or decision for member positions.',
      );
    const label_contains = input.label_contains?.trim()
      ? normalizeLabel(input.label_contains)
      : undefined;
    // Decision relations name B- motions only, so a B citation selects its B- identifier.
    const document_id = input.document_id?.trim()
      ? documentInputIds(input.document_id)[0]
      : undefined;
    const vote_item_id = input.vote_item_id?.trim()
      ? canonicalId(input.vote_item_id, 'activity', {
          parameter: 'vote_item_id',
          hint: 'Call euparl_get_plenary_votes with mode vote_items and the same sitting_id for vote_item_id values.',
        })
      : undefined;
    const mep_id = input.mep_id?.trim()
      ? canonicalId(input.mep_id, 'person', personInput('mep_id'))
      : undefined;
    if (mode !== 'voters' && (input.resolve_names || input.roster_term !== undefined))
      invalidMode(
        'Name resolution fields are supported only in voters mode.',
        'Remove resolve_names and roster_term, or use mode voters with decision_id and position.',
      );
    if (mode === 'sittings') {
      forbid(input, ['sitting_id', 'decision_id', 'position', 'snapshot']);
      if (input.year === undefined)
        invalidMode(
          'year is required for sittings mode.',
          'Supply a four-digit year for mode sittings.',
        );
      const response = await this.client.get(
        'meetings',
        { offset: paging.offset, limit: paging.limit, year: input.year },
        sittingSchema,
        operation,
      );
      const sittings = response.data.map((raw) => ({
        sitting_id: activityId(raw),
        ...field('date', raw.activity_date),
        ...field('label', localized(raw.activity_label, paging.language, notices)),
        source_url: sourceUrl(raw.id),
      }));
      if (!sittings.length)
        notices.push(
          emptyNotice(
            paging.offset,
            'sittings',
            'No sittings matched this year. Try another year.',
          ),
        );
      return result(
        { mode, sittings, page: upstreamPage(sittings.length, paging, response.total) },
        { mode, year: input.year, language: paging.language },
        notices,
        response.total,
      );
    }
    forbid(input, ['year']);
    const sittingHint =
      'Call euparl_get_plenary_votes with mode sittings and a year for sitting_id values.';
    const written = required(input.sitting_id, 'sitting_id');
    let sitting_id = canonicalId(written, 'activity', {
      parameter: 'sitting_id',
      hint: sittingHint,
    });
    if (/^\d{4}-\d{2}-\d{2}$/.test(sitting_id)) sitting_id = `MTG-PL-${sitting_id}`;
    if (!/^MTG-PL-\d{4}-\d{2}-\d{2}$/.test(sitting_id))
      invalidFilter(
        `sitting_id ${JSON.stringify(written)} is not a plenary sitting. Accepted forms: a sitting date YYYY-MM-DD or MTG-PL-YYYY-MM-DD, bare, after eli/dl/event/, or in the exact https://data.europarl.europa.eu/eli/dl/event/ URI.`,
        sittingHint,
      );
    const sittingDate = sitting_id.slice(7);
    date(sittingDate, 'sitting_id', { written });
    // A vote item names its sitting; a mismatch could only return an empty whole-sitting download.
    const voteItemDate = vote_item_id?.match(/^MTG-PL-(\d{4}-\d{2}-\d{2})-/)?.[1];
    if (voteItemDate !== undefined && voteItemDate !== sittingDate)
      invalidFilter(
        `vote_item_id ${JSON.stringify(input.vote_item_id)} belongs to the ${voteItemDate} sitting, not to sitting_id ${JSON.stringify(input.sitting_id)}; both must name the same sitting.`,
        `Retry with sitting_id ${voteItemDate}, the date in vote_item_id.`,
      );
    if (mode === 'decisions' || mode === 'vote_items') forbid(input, ['decision_id', 'position']);
    if (mode === 'vote_items') {
      localPaging(input);
      // One unpaged read in published order: paging and language both reorder the items.
      const response = await this.client.get(
        `meetings/${sitting_id}/vote-results`,
        {},
        voteItemSchema,
        operation,
      );
      const items = sittingVoteItems(response.data, sitting_id, paging.language, notices);
      const selected =
        label_contains === undefined
          ? items
          : items.filter((item) => labelMatches(item.label, label_contains));
      const filters = {
        mode,
        sitting_id,
        language: paging.language,
        ...field('label_contains', label_contains),
      };
      const page = localPage(selected, paging, filters);
      if (!items.length)
        notices.push(
          'No vote items were published for this sitting. Call euparl_get_plenary_votes with mode sittings and year to discover available sittings.',
        );
      else if (!selected.length)
        notices.push(
          `No published vote item label matched label_contains. Vote item labels are titles; decision labels carry report citations and amendment numbers, so try mode decisions with the same label_contains or the report citation as decision labels write it (${labelCitation}), or remove label_contains to list every vote item.`,
        );
      const unlinked = selected.filter((item) => item.decision_count === undefined).length;
      if (unlinked)
        notices.push(
          sittingDate < firstDecisionSitting
            ? `${unlinked} of ${selected.length} vote items publish no decision links: decision_count is omitted rather than 0. Parliament publishes no decision records for sittings before ${firstDecisionSitting}, so decisions mode has none for this sitting; each vote item's recording_document_ids names the minutes item that records it, readable with euparl_search_documents mode get.`
            : `${unlinked} of ${selected.length} vote items publish no decision links: decision_count is omitted rather than 0, and vote_item_id selects none of their decisions. Call euparl_get_plenary_votes with mode decisions, the same sitting_id and label_contains set to the report citation as decision labels write it (${labelCitation}), or, when no decision label carries it, to words of the vote item's title with language set to the title's language; matching label text does not establish a final vote.`,
        );
      return result(
        { mode, sitting_id, vote_items: page.items, page: page.page },
        filters,
        notices,
        page.total,
      );
    }
    if (mode === 'decision') {
      forbid(input, ['position']);
      detailPaging(input);
    }
    const decision_id =
      mode === 'decisions'
        ? undefined
        : canonicalId(required(input.decision_id, 'decision_id'), 'activity', {
            parameter: 'decision_id',
            hint: 'Call euparl_get_plenary_votes with mode decisions and the same sitting_id for decision_id values.',
          });
    if (mode === 'voters') {
      if (!input.position)
        invalidMode(
          'position is required for voters mode.',
          'Supply position: favor, against, abstention, intended_favor, intended_against, or intended_abstention.',
        );
      if (input.resolve_names && input.roster_term === undefined)
        invalidMode(
          'resolve_names requires roster_term.',
          'Supply roster_term for the sitting date when resolve_names is true.',
        );
      if (!input.resolve_names && input.roster_term !== undefined)
        invalidMode(
          'roster_term requires resolve_names=true.',
          'Remove roster_term, or set resolve_names true in voters mode.',
        );
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
      ...field('document_id', document_id),
      ...field('vote_item_id', vote_item_id),
      ...field('mep_id', mep_id),
      ...field('label_contains', label_contains),
      ...field('position', input.position),
      ...(mode === 'voters' && {
        resolve_names: input.resolve_names ?? false,
        ...field('roster_term', input.roster_term),
      }),
    };
    if (mode === 'decisions') {
      const decisions = response.data.map((raw) =>
        normalizeDecisionSummary(raw, paging.language, notices, mep_id),
      );
      const related = decisions.filter(
        (decision) =>
          (document_id === undefined ||
            [
              ...decision.document_ids,
              ...decision.recording_document_ids,
              ...decision.partial_document_ids,
            ].some((id) => id === document_id || id.startsWith(`${document_id}-`))) &&
          (vote_item_id === undefined || decision.vote_item_ids.includes(vote_item_id)),
      );
      const selected =
        label_contains === undefined
          ? related
          : related.filter((decision) => labelMatches(decision.label, label_contains));
      const page = localPage(selected, paging, filters);
      if (!page.total) {
        if (label_contains !== undefined && related.length)
          notices.push(
            `No published decision label matched label_contains within the selected document and vote-item filters. Remove or change label_contains (in decision labels ${labelCitation}; a label without the report citation can carry words of the vote item's title from mode vote_items instead, matched with language set to the title's language); matching text does not establish a final vote.`,
          );
        else notices.push(decisionsUnmatched(decisions, document_id, vote_item_id));
      } else if (document_id !== undefined && vote_item_id === undefined) {
        const steering = voteItemSteering(decisions, selected);
        if (steering) notices.push(steering);
      }
      return result(
        { mode, sitting_id, decisions: page.items, page: page.page },
        filters,
        notices,
        page.total,
      );
    }
    const raw = response.data.find((row) => activityId(row) === decision_id);
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
          decision: normalizeDecision(raw, paging.language, notices, mep_id),
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
      if (resolution.unresolved) {
        notices.push(
          `Some voter identities are unresolved. roster_term must be the term containing the sitting date ${sittingDate}; if it is not, retry with that term. For voters still without a name, call euparl_search_meps once with mep_ids set to their mep_ids, mandate_date ${sittingDate} and limit at least their count: it returns each name with the country and political group published that day. An ID it lists in unmatched_mep_ids was not seated that day; read it with euparl_get_mep.`,
        );
      }
    }
    const page = localPage(voters, paging, {
      ...filters,
      ...field('voter_resolution', resolution),
    });
    if (ids === undefined)
      notices.push('This voter position array was not published in the response.');
    const unnamed = unnamedVotersNotice(raw, [position]);
    if (unnamed !== undefined) notices.push(unnamed);
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
      ids === undefined ? undefined : page.total,
      ids !== undefined,
    );
  }

  /** Resolve every overlapping term candidate before choosing a human citation. */
  async listQuestions(input: QuestionsInput, ctx: ServiceContext) {
    const operation = this.client.operation(ctx.signal);
    const paging = scopePage(input, 'questions');
    const notices = noticesFor(input, paging, 'questions');
    const mode = input.mode ?? 'list';
    if (mode === 'list') {
      forbid(input, ['question_id', 'term', 'snapshot']);
      const work_type = normalizeCode(input.work_type, 'question');
      const response = await this.client.get(
        'parliamentary-questions',
        { offset: paging.offset, limit: paging.limit, year: input.year, 'work-type': work_type },
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
          emptyNotice(
            paging.offset,
            'questions',
            'No questions matched. Remove work_type or change year; call euparl_list_reference with topic question_types.',
          ),
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
    let resolved: Envelope<RawQuestion> | undefined;
    // Published work prefixes: E written, P priority written, O oral, G major and K minor interpellation.
    const human = /^([EPOGK])-(\d{1,6})\/(\d{4})$/i.exec(citation);
    if (human) {
      const prefix = citation.charAt(0).toUpperCase();
      const sequence = citation.slice(2, citation.indexOf('/')).padStart(6, '0');
      if (input.term !== undefined) question_id = `${prefix}-${input.term}-${human[3]}-${sequence}`;
      else {
        const year = Number(human[3]);
        // Elected terms span five years from 1979; election years overlap adjacent terms.
        const latestTerm = 10;
        const term = Math.min(latestTerm, Math.max(0, Math.floor((year - 1979) / 5) + 1));
        const terms =
          year >= 1979 && year <= 2024 && (year - 1979) % 5 === 0 ? [term - 1, term] : [term];
        const matches: { id: string; term: number; response: Envelope<RawQuestion> }[] = [];
        for (const candidateTerm of terms) {
          operation.signal.throwIfAborted();
          const id = `${prefix}-${candidateTerm}-${human[3]}-${sequence}`;
          const response = await this.client.get(
            `parliamentary-questions/${id}`,
            {},
            questionSchema,
            operation,
          );
          const raw = response.data[0];
          if (raw && canonicalId(raw.identifier ?? raw.id, 'document') !== id)
            throw serializationError(
              'Parliament returned a different question identifier than requested.',
            );
          if (raw) matches.push({ id, term: candidateTerm, response });
        }
        // At most two terms overlap a citation year.
        const [first, second] = matches;
        if (first && second)
          invalidFilter(
            `question_id ${JSON.stringify(input.question_id)} matches questions in terms ${first.term} and ${second.term}: ${first.id} and ${second.id}.`,
            `Retry with term ${first.term} or term ${second.term}, or pass ${first.id} or ${second.id} as question_id.`,
          );
        question_id = matches[0]?.id;
        resolved = matches[0]?.response;
      }
    } else {
      const documentPrefix = 'eli/dl/doc/';
      const publicOrigin = 'https://data.europarl.europa.eu/';
      const local = citation.startsWith(publicOrigin)
        ? citation.slice(publicOrigin.length)
        : citation;
      const unwrapped = local.startsWith(documentPrefix)
        ? local.slice(documentPrefix.length)
        : local;
      const match = /^([EPOGK])-(\d+)-(\d{4})-(\d{1,6})$/i.exec(unwrapped);
      if (!match)
        invalidFilter(
          `question_id ${JSON.stringify(input.question_id)} is not a question identifier or citation. Accepted forms: a canonical identifier such as E-10-2025-000001, bare, after eli/dl/doc/ or in the exact https://data.europarl.europa.eu/eli/dl/doc/ URI, or a human citation such as E-000001/2025; prefix E, P, O, G or K in any case, sequence of one to six digits.`,
          "Call euparl_list_questions with mode list and the question's year for question_id values, then retry mode get with one of them.",
        );
      const sequence = unwrapped.slice(unwrapped.lastIndexOf('-') + 1).padStart(6, '0');
      question_id = `${unwrapped.charAt(0).toUpperCase()}-${match[2]}-${match[3]}-${sequence}`;
      const idTerm = Number(match[2]);
      if (input.term !== undefined && idTerm !== input.term)
        invalidFilter(
          `term ${input.term} conflicts with question_id ${JSON.stringify(input.question_id)}, whose term is ${idTerm}.`,
          `Retry with term ${idTerm}, or omit term; a canonical question identifier carries its own term.`,
        );
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
    const response =
      resolved ??
      (await this.client.get(
        `parliamentary-questions/${question_id}`,
        {},
        questionSchema,
        operation,
      ));
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
