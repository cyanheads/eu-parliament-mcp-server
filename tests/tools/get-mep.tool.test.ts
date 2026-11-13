/** @fileoverview Member identities, nested membership history and wire twins. */
import { createHash } from 'node:crypto';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getMepTool } from '../../src/mcp-server/tools/definitions/get-mep.tool.js';
import { listReferenceTool } from '../../src/mcp-server/tools/definitions/list-reference.tool.js';
import {
  contractText,
  expectErrorTwin,
  expectSuccessTwin,
  installToolHttp,
} from '../helpers/eu-parliament-contract.js';
import { envelopeResponse, mepRecord } from '../helpers/eu-parliament-fixtures.js';

const languageHint =
  'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.';
const snapshotHint =
  'Repeat the same tool call with offset 0 and no snapshot, then use the returned snapshot for continuation.';
const rejectedHint =
  'Call euparl_list_reference for supported filters and identifiers, then retry with a narrower supported request.';
const rateHint = 'Wait for the reported retry interval, then repeat the same euparl tool call.';
const detail = {
  ...mepRecord,
  citizenship: 'http://publications.europa.eu/resource/authority/country/FRA',
  placeOfBirth: 'Example **town** `name`\n[link](https://example.org)',
  hasMembership: [
    mepRecord.hasMembership[0],
    {
      id: 'membership/second',
      organization: 'org/HISTORICAL',
      membershipClassification: 'def/classification/GROUP',
      role: 'def/roles/CHAIR',
      memberDuring: { startDate: '2019-07-02', endDate: '2024-07-15' },
    },
  ],
};
const snapshotOf = (data: Record<string, unknown>) =>
  z.object({ snapshot: z.string() }).parse(data.page).snapshot;
/** 14 of the 81 memberships of meps/124867, in published order, captured 2026-11-13. */
const benifei = {
  id: 'person/124867',
  type: 'Person',
  identifier: '124867',
  label: 'Brando BENIFEI',
  givenName: 'Brando',
  familyName: 'Benifei',
  hasMembership: [
    {
      id: 'membership/124867-f-170705',
      type: 'Membership',
      organization: 'org/ep-10',
      membershipClassification: 'def/ep-entities/EU_INSTITUTION',
      role: 'def/ep-roles/MEMBER',
      memberDuring: { id: 'time-period/20240716', type: 'PeriodOfTime', startDate: '2024-07-16' },
    },
    {
      id: 'membership/124867-f-174367',
      type: 'Membership',
      organization: 'org/6585',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER_SUBSTITUTE',
      memberDuring: { id: 'time-period/20240719', type: 'PeriodOfTime', startDate: '2024-07-19' },
    },
    {
      id: 'membership/124867-f-166020',
      type: 'Membership',
      organization: 'org/6362',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER_SUBSTITUTE',
      memberDuring: {
        id: 'time-period/20220120-20240715',
        type: 'PeriodOfTime',
        startDate: '2022-01-20',
        endDate: '2024-07-15',
      },
    },
    {
      id: 'membership/124867-m-16219',
      type: 'Membership',
      organization: 'org/ep-9',
      role: 'def/ep-roles/MEMBER_PARLIAMENT',
      memberDuring: {
        id: 'time-period/20190702-20240715',
        type: 'PeriodOfTime',
        startDate: '2019-07-02',
        endDate: '2024-07-15',
      },
    },
    {
      id: 'membership/124867-f-154148',
      type: 'Membership',
      organization: 'org/ep-9',
      membershipClassification: 'def/ep-entities/EU_INSTITUTION',
      role: 'def/ep-roles/MEMBER',
      memberDuring: {
        id: 'time-period/20190702-20240715',
        type: 'PeriodOfTime',
        startDate: '2019-07-02',
        endDate: '2024-07-15',
      },
    },
    {
      id: 'membership/124867-f-174476',
      type: 'Membership',
      organization: 'org/6579',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER_SUBSTITUTE',
      memberDuring: { id: 'time-period/20240719', type: 'PeriodOfTime', startDate: '2024-07-19' },
    },
    {
      id: 'membership/124867-m-17464',
      type: 'Membership',
      organization: 'org/ep-10',
      role: 'def/ep-roles/MEMBER_PARLIAMENT',
      memberDuring: { id: 'time-period/20240716', type: 'PeriodOfTime', startDate: '2024-07-16' },
    },
    {
      id: 'membership/124867-f-174034',
      type: 'Membership',
      organization: 'org/6564',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER',
      memberDuring: { id: 'time-period/20240719', type: 'PeriodOfTime', startDate: '2024-07-19' },
    },
    {
      id: 'membership/124867-f-177494',
      type: 'Membership',
      organization: 'org/3730',
      role: 'def/ep-roles/MEMBER',
      memberDuring: { id: 'time-period/20241025', type: 'PeriodOfTime', startDate: '2024-10-25' },
    },
    {
      id: 'membership/124867-f-141599',
      type: 'Membership',
      organization: 'org/ep-8',
      membershipClassification: 'def/ep-entities/EU_INSTITUTION',
      role: 'def/ep-roles/MEMBER',
      memberDuring: {
        id: 'time-period/20140701-20190701',
        type: 'PeriodOfTime',
        startDate: '2014-07-01',
        endDate: '2019-07-01',
      },
    },
    {
      id: 'membership/124867-m-15384',
      type: 'Membership',
      organization: 'org/ep-8',
      role: 'def/ep-roles/MEMBER_PARLIAMENT',
      memberDuring: {
        id: 'time-period/20140701-20190701',
        type: 'PeriodOfTime',
        startDate: '2014-07-01',
        endDate: '2019-07-01',
      },
    },
    {
      id: 'membership/124867-f-168438',
      type: 'Membership',
      organization: 'org/6360',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER',
      memberDuring: {
        id: 'time-period/20230509-20230614',
        type: 'PeriodOfTime',
        startDate: '2023-05-09',
        endDate: '2023-06-14',
      },
    },
    {
      id: 'membership/124867-f-180753',
      type: 'Membership',
      organization: 'org/7890',
      membershipClassification: 'def/ep-entities/WORKING_GROUP',
      role: 'def/ep-roles/MEMBER',
      memberDuring: { id: 'time-period/20260220', type: 'PeriodOfTime', startDate: '2026-02-20' },
    },
    {
      id: 'membership/124867-f-172935',
      type: 'Membership',
      organization: 'org/6587',
      membershipClassification: 'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      role: 'def/ep-roles/MEMBER',
      memberDuring: { id: 'time-period/20240719', type: 'PeriodOfTime', startDate: '2024-07-19' },
    },
  ],
};
const organizationsOf = (data: Record<string, unknown>) =>
  z
    .array(z.object({ organization_id: z.string() }))
    .parse(data.memberships)
    .map((row) => row.organization_id);
const standing = 'committee_parliamentary_standing';
afterEach(() => vi.useRealTimers());

describe('euparl_get_mep contract', () => {
  it('keeps membership reads cheap and resolves a supported organization in a separate reference call', async () => {
    const fetcher = installToolHttp((url) =>
      url.pathname.includes('/meps/')
        ? envelopeResponse([
            { id: 'person/1', hasMembership: [{ id: 'membership/1', organization: 'org/5144' }] },
          ])
        : envelopeResponse([
            { id: 'org/5144', label: 'DLAT', prefLabel: { en: 'Delegation example' } },
          ]),
    );
    const member = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '1', section: 'memberships' }),
    );
    expect(member.memberships).toEqual([{ id: 'membership/1', organization_id: 'org/5144' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const organization = expectSuccessTwin(
      await runToolContract(listReferenceTool, {
        topic: 'organizations',
        organization_ids: ['org/5144'],
      }),
    );
    expect(organization.items).toMatchObject([
      {
        found: true,
        organization_id: '5144',
        name: { value: 'Delegation example', language: 'en' },
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['900000001', 'person/900000001', 'https://data.europarl.europa.eu/person/900000001'])(
    'reads canonical identity for %s',
    async (mep_id) => {
      const fetcher = installToolHttp(() => envelopeResponse([detail]));
      const data = expectSuccessTwin(
        await runToolContract(getMepTool, { mep_id, language: '', snapshot: '' }),
      );
      expect(data).toMatchObject({
        found: true,
        mep_id: '900000001',
        name: 'Alex EXAMPLE',
        given_name: 'Alex',
        family_name: 'Example',
        citizenship: 'http://publications.europa.eu/resource/authority/country/FRA',
        place_of_birth: 'Example **town** `name`\n[link](https://example.org)',
        section: 'overview',
        membership_count: 2,
        source_url: 'https://data.europarl.europa.eu/person/900000001',
      });
      expect(data).not.toHaveProperty('memberships');
      expect(data).not.toHaveProperty('page');
      expect(data).not.toHaveProperty('country');
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe('/api/v2/meps/900000001');
    },
  );

  it('preserves nested intervals and pages membership history beyond the first record', async () => {
    installToolHttp(() => envelopeResponse([detail]));
    const first = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', section: 'memberships', limit: 1 }),
    );
    expect(first.memberships).toEqual([
      {
        id: 'membership/900000001-m-1',
        organization_id: 'org/ep-10',
        role: 'def/ep-roles/MEMBER_PARLIAMENT',
        start_date: '2024-07-16',
      },
    ]);
    expect(first).toMatchObject({
      totalCount: 2,
      page: { next_offset: 1, returned: 1 },
      truncated: true,
    });
    const snapshot = snapshotOf(first);
    const second = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        offset: 1,
        limit: 1,
        snapshot,
      }),
    );
    expect(second.memberships).toEqual([
      {
        id: 'membership/second',
        organization_id: 'org/HISTORICAL',
        classification: 'def/classification/GROUP',
        role: 'def/roles/CHAIR',
        start_date: '2019-07-02',
        end_date: '2024-07-15',
      },
    ]);
    expect(second).toMatchObject({ page: { returned: 1, has_more: false, snapshot } });
    const past = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        offset: 999,
        snapshot,
      }),
    );
    expect(past).toMatchObject({
      memberships: [],
      totalCount: 2,
      page: { returned: 0, has_more: false },
    });
  });

  it('detects changes in later membership fields and retrieval scope', async () => {
    let changed = false;
    installToolHttp(() =>
      envelopeResponse([
        changed
          ? {
              ...detail,
              hasMembership: [
                detail.hasMembership[0],
                { ...detail.hasMembership[1], role: 'def/roles/MEMBER' },
              ],
            }
          : detail,
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', section: 'memberships', limit: 1 }),
    );
    const snapshot = snapshotOf(first);
    expectErrorTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        language: 'fr',
        offset: 1,
        snapshot,
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
    changed = true;
    expectErrorTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        offset: 1,
        snapshot,
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('pages memberships at whole items and continues', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'person/900000001',
          hasMembership: Array.from({ length: 226 }, (_, index) => ({ id: `membership/${index}` })),
        },
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        limit: 225,
      }),
    );
    expect(first.memberships).toHaveLength(225);
    expect(first).toMatchObject({
      totalCount: 226,
      cap: 225,
      page: { limit: 225, next_offset: 225 },
    });
    expect(first.notice).toBe('Continue with offset 225 and the returned snapshot.');
    const last = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        offset: 225,
        snapshot: snapshotOf(first),
      }),
    );
    // Undated memberships sort last by id in code-unit order, so membership/99 ends the history.
    expect(last.memberships).toEqual([{ id: 'membership/99' }]);
  });

  it.each([204, 404])('returns found false for HTTP %i with discovery guidance', async (status) => {
    installToolHttp(() => new Response(null, { status }));
    const data = expectSuccessTwin(await runToolContract(getMepTool, { mep_id: '900000001' }));
    expect(data).toEqual({
      found: false,
      mep_id: '900000001',
      source_url: 'https://data.europarl.europa.eu/person/900000001',
      section: 'overview',
      appliedFilters: { mep_id: '900000001', section: 'overview', language: 'en' },
      notice: 'No MEP detail was published. Call euparl_search_meps with name_contains or term.',
    });
  });

  it('preserves genuinely sparse identity and empty membership history', async () => {
    installToolHttp(() => envelopeResponse([{ id: 'person/900000001' }]));
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', section: 'memberships' }),
    );
    expect(data).toMatchObject({
      found: true,
      memberships: [],
      totalCount: 0,
      page: { returned: 0, has_more: false },
    });
    expect(data).not.toHaveProperty('name');
    expect(data).not.toHaveProperty('citizenship');
  });

  it.each([
    [{ offset: 1 }, 'Use offset 0 for overview, or select memberships for continuation.'],
    [
      { section: 'memberships', offset: 1 },
      'Pass the previous page.snapshot with the same filters, or restart at offset 0 without snapshot.',
    ],
  ] as const)('rejects invalid continuation %j before HTTP', async (input, hint) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', ...input }),
      'invalid_mode_fields',
      hint,
      JsonRpcErrorCode.ValidationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unsupported language with declared recovery', async () => {
    installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', language: 'xx' }),
      'invalid_filter',
      languageHint,
      JsonRpcErrorCode.ValidationError,
    );
  });

  it.each([
    { mep_id: '' },
    { mep_id: 'https://evil.example/person/1' },
    { mep_id: '1?token=secret' },
    { limit: 2.5 },
    { offset: -1 },
    { unknown: true },
  ])('rejects malformed fields %j', async (input) => {
    const fetcher = installToolHttp(() => envelopeResponse([]));
    const result = await runToolContract(getMepTool, { mep_id: '900000001', ...input });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(contractText(result)).toContain('euparl_get_mep');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders upstream rejection with recovery', async () => {
    installToolHttp(() => new Response(null, { status: 422 }));
    expectErrorTwin(
      await runToolContract(getMepTool, { mep_id: '900000001' }),
      'upstream_rejected',
      rejectedHint,
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it('renders persistent rate limiting after bounded retries', async () => {
    const fetcher = installToolHttp(() => new Response(null, { status: 429 }));
    expectErrorTwin(
      await runToolContract(getMepTool, { mep_id: '900000001' }),
      'upstream_rate_limited',
      rateHint,
      JsonRpcErrorCode.RateLimited,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('euparl_get_mep membership classification, date and order', () => {
  const latestFirst = [
    'org/7890',
    'org/3730',
    'org/6587',
    'org/6564',
    'org/6585',
    'org/6579',
    'org/ep-10',
    'org/ep-10',
    'org/6360',
    'org/6362',
    'org/ep-9',
    'org/ep-9',
    'org/ep-8',
    'org/ep-8',
  ];

  it('counts classified memberships by code on the overview, on both surfaces', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const result = await runToolContract(getMepTool, { mep_id: '124867' });
    const data = expectSuccessTwin(result);
    expect(data).toMatchObject({ membership_count: 14 });
    expect(data.membership_classifications).toEqual([
      { classification: 'COMMITTEE_PARLIAMENTARY_STANDING', count: 6 },
      { classification: 'EU_INSTITUTION', count: 3 },
      { classification: 'WORKING_GROUP', count: 1 },
    ]);
    expect(contractText(result)).toContain(
      'result.membership_classifications[0].classification: ` "COMMITTEE_PARLIAMENTARY_STANDING" `',
    );
  });

  it('pages the history latest start first, then by id, the same on every read', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const all = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '124867', section: 'memberships' }),
    );
    expect(organizationsOf(all)).toEqual(latestFirst);
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(all.memberships)
        .slice(2, 6),
    ).toEqual([
      { id: 'membership/124867-f-172935' },
      { id: 'membership/124867-f-174034' },
      { id: 'membership/124867-f-174367' },
      { id: 'membership/124867-f-174476' },
    ]);
    expect(all).toMatchObject({ totalCount: 14, appliedFilters: { section: 'memberships' } });
    expect(all.appliedFilters).not.toHaveProperty('classification');
    installToolHttp(() =>
      envelopeResponse([{ ...benifei, hasMembership: benifei.hasMembership.toReversed() }]),
    );
    const reread = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '124867', section: 'memberships' }),
    );
    expect(reread.memberships).toEqual(all.memberships);
    expect(snapshotOf(reread)).toBe(snapshotOf(all));
  });

  it('sorts undated memberships last, by id', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'person/1',
          hasMembership: [
            { id: 'membership/c' },
            { id: 'membership/b', memberDuring: { startDate: '2019-07-02' } },
            { id: 'membership/a' },
            {
              id: 'membership/d',
              memberDuring: { startDate: '2024-07-16', endDate: '2024-09-01' },
            },
          ],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, { mep_id: '1', section: 'memberships' }),
    );
    expect(
      z
        .array(z.object({ id: z.string() }))
        .parse(data.memberships)
        .map((row) => row.id),
    ).toEqual(['membership/d', 'membership/b', 'membership/a', 'membership/c']);
  });

  it.each([
    [standing, '2024-07-19', ['org/6587', 'org/6564', 'org/6585', 'org/6579']],
    [
      'def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING',
      '2024-07-19',
      ['org/6587', 'org/6564', 'org/6585', 'org/6579'],
    ],
    [
      ' Def/Ep-Entities/Committee_Parliamentary_Standing ',
      '2024-07-19',
      ['org/6587', 'org/6564', 'org/6585', 'org/6579'],
    ],
    [standing, '2023-06-14', ['org/6360', 'org/6362']],
    [standing, '2023-05-09', ['org/6360', 'org/6362']],
    [standing, '2023-06-15', ['org/6362']],
    [standing, undefined, ['org/6587', 'org/6564', 'org/6585', 'org/6579', 'org/6360', 'org/6362']],
    [undefined, '2024-07-16', ['org/ep-10', 'org/ep-10']],
    [undefined, '2014-07-01', ['org/ep-8', 'org/ep-8']],
  ] as const)(
    'keeps classification %j active on %j, both ends inclusive',
    async (classification, active_on, organizations) => {
      installToolHttp(() => envelopeResponse([benifei]));
      const data = expectSuccessTwin(
        await runToolContract(getMepTool, {
          mep_id: '124867',
          section: 'memberships',
          ...(classification !== undefined && { classification }),
          ...(active_on !== undefined && { active_on }),
        }),
      );
      expect(organizationsOf(data)).toEqual(organizations);
      expect(data.totalCount).toBe(organizations.length);
      expect(data.appliedFilters).toEqual({
        mep_id: '124867',
        section: 'memberships',
        language: 'en',
        ...(classification !== undefined && { classification: 'COMMITTEE_PARLIAMENTARY_STANDING' }),
        ...(active_on !== undefined && { active_on }),
      });
    },
  );

  it('returns no rows the day before the open committee periods began, naming the date rule', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '124867',
        section: 'memberships',
        classification: standing,
        active_on: '2024-07-18',
      }),
    );
    expect(data).toMatchObject({ memberships: [], totalCount: 0 });
    expect(data.notice).toBe(
      'No membership classified COMMITTEE_PARLIAMENTARY_STANDING has a published interval including active_on 2024-07-18 (start_date on or before it, end_date on or after it or absent). Remove active_on to read every period; an absent end date does not establish current membership.',
    );
  });

  it('names the classifications this history carries when the code matches none', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '124867',
        section: 'memberships',
        classification: 'delegation_parliamentary',
      }),
    );
    expect(data).toMatchObject({ memberships: [], totalCount: 0 });
    expect(data.notice).toBe(
      'No membership in this history has classification DELEGATION_PARLIAMENTARY. It carries COMMITTEE_PARLIAMENTARY_STANDING (6), EU_INSTITUTION (3), and WORKING_GROUP (1), and 4 memberships have no classification. Retry with one of those codes, or remove classification.',
    );
  });

  it.each([
    ['committee_parliamentary', 'COMMITTEE_PARLIAMENTARY'],
    ['institution', 'INSTITUTION'],
    ['ep-entities', 'EP-ENTITIES'],
  ])(
    'matches classification %j on the whole last path segment, never part of it',
    async (classification, code) => {
      installToolHttp(() => envelopeResponse([benifei]));
      const data = expectSuccessTwin(
        await runToolContract(getMepTool, {
          mep_id: '124867',
          section: 'memberships',
          classification,
        }),
      );
      expect(data).toMatchObject({ memberships: [], totalCount: 0 });
      expect(data.notice).toBe(
        `No membership in this history has classification ${code}. It carries COMMITTEE_PARLIAMENTARY_STANDING (6), EU_INSTITUTION (3), and WORKING_GROUP (1), and 4 memberships have no classification. Retry with one of those codes, or remove classification.`,
      );
    },
  );

  it('pages a filtered history and binds the snapshot to the filters', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const input = { mep_id: '124867', section: 'memberships', classification: standing } as const;
    const first = expectSuccessTwin(await runToolContract(getMepTool, { ...input, limit: 4 }));
    expect(organizationsOf(first)).toEqual(['org/6587', 'org/6564', 'org/6585', 'org/6579']);
    const snapshot = snapshotOf(first);
    const second = expectSuccessTwin(
      await runToolContract(getMepTool, { ...input, limit: 4, offset: 4, snapshot }),
    );
    expect(organizationsOf(second)).toEqual(['org/6360', 'org/6362']);
    expect(second).toMatchObject({ totalCount: 6, page: { has_more: false, snapshot } });
    expectErrorTwin(
      await runToolContract(getMepTool, {
        ...input,
        active_on: '2024-07-19',
        offset: 4,
        snapshot,
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('binds the snapshot to the filters when two filter sets select the same rows', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    const input = {
      mep_id: '124867',
      section: 'memberships',
      classification: 'working_group',
      limit: 1,
    } as const;
    const undated = expectSuccessTwin(await runToolContract(getMepTool, input));
    const dated = expectSuccessTwin(
      await runToolContract(getMepTool, { ...input, active_on: '2026-03-01' }),
    );
    expect(organizationsOf(dated)).toEqual(['org/7890']);
    expect(dated.memberships).toEqual(undated.memberships);
    expect(snapshotOf(dated)).not.toBe(snapshotOf(undated));
    expectErrorTwin(
      await runToolContract(getMepTool, {
        ...input,
        active_on: '2026-03-01',
        offset: 1,
        snapshot: snapshotOf(undated),
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('fails a continuation taken on the previous membership order before slicing', async () => {
    installToolHttp(() => envelopeResponse([benifei]));
    // The snapshot the previous release returned: scope plus memberships in published order.
    const memberships = benifei.hasMembership.map(
      ({ id, organization, membershipClassification, role, memberDuring }) => ({
        id,
        organization_id: organization,
        ...(membershipClassification !== undefined && { classification: membershipClassification }),
        role,
        start_date: memberDuring.startDate,
        ...('endDate' in memberDuring && { end_date: memberDuring.endDate }),
      }),
    );
    const previous = createHash('sha256')
      .update(
        JSON.stringify({
          scope: { mep_id: '124867', section: 'memberships', language: 'en' },
          items: memberships,
        }),
      )
      .digest('hex');
    expectErrorTwin(
      await runToolContract(getMepTool, {
        mep_id: '124867',
        section: 'memberships',
        offset: 4,
        limit: 4,
        snapshot: previous,
      }),
      'snapshot_changed',
      snapshotHint,
      JsonRpcErrorCode.Conflict,
    );
  });

  it('keeps a membership without a start date out of every active_on page', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'person/1',
          hasMembership: [
            { id: 'membership/open', memberDuring: { endDate: '2030-01-01' } },
            { id: 'membership/dated', memberDuring: { startDate: '2020-01-01' } },
          ],
        },
      ]),
    );
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '1',
        section: 'memberships',
        active_on: '2024-01-01',
      }),
    );
    expect(data.memberships).toEqual([{ id: 'membership/dated', start_date: '2020-01-01' }]);
  });

  it.each([
    [
      { section: 'overview', classification: standing },
      'invalid_mode_fields',
      'Retry with section "memberships" and the same classification, or remove classification; the overview lists the codes in membership_classifications.',
      'classification "committee_parliamentary_standing" filters membership rows, which only section "memberships" returns.',
    ],
    [
      { active_on: '2024-07-19' },
      'invalid_mode_fields',
      'Retry with section "memberships" and the same active_on, or remove active_on; the overview counts every membership.',
      'active_on "2024-07-19" filters membership rows, which only section "memberships" returns.',
    ],
    [
      { section: 'memberships', active_on: '2024-02-30' },
      'invalid_filter',
      'Pass active_on as an existing calendar day in YYYY-MM-DD form, such as 2024-07-19.',
      'active_on "2024-02-30" is not a real calendar date in YYYY-MM-DD form.',
    ],
    [
      { section: 'memberships', active_on: '2026-11-14' },
      'invalid_filter',
      'Pass an active_on on or before 2026-11-13, or omit active_on to keep every period.',
      'active_on "2026-11-14" is after the current UTC date 2026-11-13.',
    ],
    [
      { section: 'memberships', classification: 'org/AFCO' },
      'invalid_filter',
      'Call euparl_get_mep with this mep_id and no classification; its membership_classifications lists the codes this history carries.',
      'classification "org/AFCO" is not a membership classification code. Accepted forms: a code such as COMMITTEE_PARLIAMENTARY_STANDING, bare or as published (def/ep-entities/COMMITTEE_PARLIAMENTARY_STANDING), in any case.',
    ],
  ] as const)(
    'rejects %j as %s on both surfaces before HTTP',
    async (input, reason, hint, message) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
      const fetcher = installToolHttp(() => envelopeResponse([benifei]));
      const result = await runToolContract(getMepTool, { mep_id: '124867', ...input });
      expectErrorTwin(result, reason, hint, JsonRpcErrorCode.ValidationError);
      expect(contractText(result)).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('accepts active_on of the current UTC date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T23:59:59Z'));
    installToolHttp(() => envelopeResponse([benifei]));
    const data = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '124867',
        section: 'memberships',
        classification: 'working_group',
        active_on: '2026-11-13',
      }),
    );
    expect(organizationsOf(data)).toEqual(['org/7890']);
  });
});
