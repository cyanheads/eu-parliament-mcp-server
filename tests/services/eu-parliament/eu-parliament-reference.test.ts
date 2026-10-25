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
  it('exposes actual identifiers and operational coverage rather than unsupported search promises', () => {
    expect(
      referenceEntries('identifiers').find((item) => item.code === 'question')?.description,
    ).toContain('term avoids a full year lookup');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'speeches')?.description,
    ).toContain('not transcripts');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'questions')?.description,
    ).toContain('Missing answer links do not prove unanswered');
  });
});
