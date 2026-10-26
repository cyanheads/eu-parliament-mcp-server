/** @fileoverview Member identities, nested membership history and wire twins. */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
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

const invalidHint =
  'Call euparl_list_reference with topic identifiers or the relevant code topic, then retry with a supported value.';
const modeHint =
  'Call euparl_list_reference with topic coverage, then retry the selected mode with its required identifiers.';
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

  it('caps memberships at whole items and continues past the cap', async () => {
    installToolHttp(() =>
      envelopeResponse([
        {
          id: 'person/900000001',
          hasMembership: Array.from({ length: 101 }, (_, index) => ({ id: `membership/${index}` })),
        },
      ]),
    );
    const first = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        limit: 1000,
      }),
    );
    expect(first.memberships).toHaveLength(100);
    expect(first).toMatchObject({
      totalCount: 101,
      cap: 100,
      page: { limit: 100, next_offset: 100 },
    });
    expect(first.notice).toBe(
      'Requested limit normalized to the effective maximum of 100. Continue with offset 100 and the returned snapshot.',
    );
    const last = expectSuccessTwin(
      await runToolContract(getMepTool, {
        mep_id: '900000001',
        section: 'memberships',
        offset: 100,
        snapshot: snapshotOf(first),
      }),
    );
    expect(last.memberships).toEqual([{ id: 'membership/100' }]);
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

  it.each([{ offset: 1 }, { section: 'memberships', offset: 1 }] as const)(
    'rejects invalid continuation %j before HTTP',
    async (input) => {
      const fetcher = installToolHttp(() => envelopeResponse([]));
      expectErrorTwin(
        await runToolContract(getMepTool, { mep_id: '900000001', ...input }),
        'invalid_mode_fields',
        modeHint,
        JsonRpcErrorCode.ValidationError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported language with declared recovery', async () => {
    installToolHttp(() => envelopeResponse([]));
    expectErrorTwin(
      await runToolContract(getMepTool, { mep_id: '900000001', language: 'xx' }),
      'invalid_filter',
      invalidHint,
      JsonRpcErrorCode.ValidationError,
    );
  });

  it.each([
    { mep_id: '' },
    { mep_id: 'https://evil.example/person/1' },
    { mep_id: '1?token=secret' },
    { limit: 1001 },
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
