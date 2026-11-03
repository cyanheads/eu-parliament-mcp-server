/** @fileoverview Input code aliases and discoverable coverage constraints. */
import { describe, expect, it } from 'vitest';
import {
  normalizeCode,
  referenceEntries,
} from '../../../src/services/eu-parliament/eu-parliament-reference.js';

describe('Parliament reference codes', () => {
  it.each([
    ['S&D', 'S-D'],
    ['Verts/ALE', 'VERTS-ALE'],
    ['The Left', 'THE-LEFT'],
    [' PfE ', 'PFE'],
    ['Renew', 'RENEW'],
    [' epp ', 'PPE'],
    [' greens/efa ', 'VERTS-ALE'],
    [' Gue/Ngl ', 'THE-LEFT'],
    [' patriots ', 'PFE'],
  ])('normalizes political group alias %s', (input, expected) => {
    expect(normalizeCode(input, 'political_group')).toBe(expected);
  });
  it('normalizes language and procedure codes without accepting arbitrary values', () => {
    expect(normalizeCode(' FR ', 'language')).toBe('fr');
    expect(normalizeCode('cod', 'process_type')).toBe('COD');
    expect(() => normalizeCode('committee-name', 'process_type')).toThrow();
    expect(() => normalizeCode('__proto__', 'political_group')).toThrow();
    expect(() => normalizeCode('constructor', 'country')).toThrow();
  });
  it('treats omitted and whitespace-only optional filters as unset', () => {
    expect(normalizeCode(undefined, 'gender')).toBeUndefined();
    expect(normalizeCode('  ', 'gender')).toBeUndefined();
  });
  it.each([' gb ', 'GB', ' uk ', 'Uk'])(
    'normalizes United Kingdom input %j to the published GB code',
    (input) => {
      expect(normalizeCode(input, 'country')).toBe('GB');
    },
  );
  it('keeps United Kingdom codes out of other filter families', () => {
    expect(() => normalizeCode('GB', 'political_group')).toThrow();
    expect(() => normalizeCode('UK', 'gender')).toThrow();
    expect(() => normalizeCode('EPP', 'country')).toThrow();
  });
  it('lists GB, never UK, as the United Kingdom mep_filters code', () => {
    const countries = referenceEntries('mep_filters').filter((entry) =>
      entry.description?.startsWith('country;'),
    );
    expect(countries.map((entry) => entry.code)).toContain('GB');
    expect(countries.map((entry) => entry.code)).not.toContain('UK');
    expect(countries.find((entry) => entry.code === 'GB')?.description).toContain('UK→GB');
  });
  it('documents date-bound group matching and the mandate_date roster selector', () => {
    expect(
      referenceEntries('mep_filters').find((entry) => entry.code === 'THE-LEFT')?.description,
    ).toContain('On mandate_date rosters a code matches only members published under it');
    const roster = referenceEntries('coverage').find((entry) => entry.code === 'meps')?.description;
    expect(roster).toContain('mandate_date');
    expect(roster).toContain('exclusive with term');
    expect(roster).toContain("A term's first sitting day can return an incomplete roster");
  });
  it.each(['PPE-DE', 'PSE', 'ALDE', '__proto__', 'constructor'])(
    'keeps unsupported historical or arbitrary group %s invalid',
    (value) => expect(() => normalizeCode(value, 'political_group')).toThrow(),
  );
  it.each([
    [
      'country',
      'BE, BG, CZ, DK, DE, EE, IE, GR, ES, FR, HR, IT, CY, LV, LT, LU, HU, MT, NL, AT, PL, PT, RO, SI, SK, FI, SE, GB',
    ],
    ['political_group', 'PPE, NI, S-D, VERTS-ALE, ECR, RENEW, THE-LEFT, ID, PFE, ESN'],
    ['gender', 'FEMALE, MALE, NAP, NKN, NST'],
  ] as const)('lists every canonical %s code in invalid-filter guidance', (family, expected) => {
    expect(() => normalizeCode('invalid', family)).toThrow(`Accepted codes: ${expected}.`);
  });
  it('exposes actual identifiers and operational coverage rather than unsupported search promises', () => {
    expect(
      referenceEntries('identifiers').find((item) => item.code === 'question')?.description,
    ).toContain('omitted term verifies canonical candidates for all overlapping terms');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'speeches')?.description,
    ).toContain('not transcripts');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'questions')?.description,
    ).toContain('Missing answer links do not prove unanswered');
  });
  it('states every collection page cap, the clamp switch and the window rule in the paging row', () => {
    const paging = referenceEntries('coverage').find((item) => item.code === 'paging')?.description;
    expect(paging).toContain(
      'Page caps: 300 procedures, 300 questions, 225 documents, 80 speeches, 300 MEPs, 225 memberships, 125 procedure section entries, 1000 voters, 100 sittings, 100 decisions, 350 reference entries, 20 organization lookups.',
    );
    expect(paging).toContain('EUPARL_CLAMP_LIMITS=false');
    expect(paging).toContain('an offset of 10000 or more is rejected');
    expect(paging).toContain(
      'A decisions page also ends at whole decisions before their rendered rows pass 92000 characters, with a notice; its first decision always returns whole, page.limit keeps the requested limit, and next_offset resumes at the first decision left out.',
    );
    expect(paging).toContain('procedures without process_type expose a 10000-result search window');
    expect(paging).toContain(
      'a process_type listing is acquired whole and paged in procedure_id order, and its snapshot is optional',
    );
  });
});
