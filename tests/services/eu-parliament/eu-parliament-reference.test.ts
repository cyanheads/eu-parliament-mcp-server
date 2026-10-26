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
  it('normalizes the historical country alias without conflating filter families', () => {
    expect(normalizeCode(' gb ', 'country')).toBe('UK');
    expect(() => normalizeCode('GB', 'political_group')).toThrow();
    expect(() => normalizeCode('EPP', 'country')).toThrow();
  });
  it.each(['PPE-DE', 'PSE', 'ALDE', '__proto__', 'constructor'])(
    'keeps unsupported historical or arbitrary group %s invalid',
    (value) => expect(() => normalizeCode(value, 'political_group')).toThrow(),
  );
  it.each([
    [
      'country',
      'BE, BG, CZ, DK, DE, EE, IE, GR, ES, FR, HR, IT, CY, LV, LT, LU, HU, MT, NL, AT, PL, PT, RO, SI, SK, FI, SE, UK',
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
});
