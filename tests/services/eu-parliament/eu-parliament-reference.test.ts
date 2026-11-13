/** @fileoverview Input code aliases and discoverable coverage constraints. */
import { describe, expect, it } from 'vitest';
import {
  normalizeCode,
  politicalGroupNotice,
  referenceEntries,
} from '../../../src/services/eu-parliament/eu-parliament-reference.js';

/** Every EU_POLITICAL_GROUP code record with a published version, as of 2026-11-13 (PATRIOTS has none). */
const groupCodes =
  'ALDE, ARC, ARE, AUCUN, C, CD, CDI, CG, COM, CTDI, DE, DEP, DR, ECR, ED, EDD, EDN, EFD, EFDD, ELDR, ENF, ESN, FE, GUE, GUE-NGL, I-EDN, ID, IND-DEM, ITS, L, LDR, NI, PFE, PPE, PPE-DE, PSE, RDE, RENEW, S, S-D, TDI, THE-LEFT, UEN, UPE, V, VERTS-ALE';

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
  it.each([
    ['PPE-DE', 'PPE-DE'],
    [' pse ', 'PSE'],
    ['ALDE', 'ALDE'],
    ['enf', 'ENF'],
    ['IND/DEM', 'IND-DEM'],
    [' ind/dem ', 'IND-DEM'],
    ['Aucun', 'AUCUN'],
    ['gue-ngl', 'GUE-NGL'],
  ])('accepts historical group code or label %j as %s on any roster', (value, expected) => {
    for (const roster of [{}, { term: 6 }, { mandate_date: '2016-03-09' }])
      expect(normalizeCode(value, 'political_group', roster)).toBe(expected);
  });
  it.each(['__proto__', 'constructor', 'bogus', 'GUE%2FNGL', 'S%26D', '4281', 'org/GUE-NGL'])(
    'keeps arbitrary group %s invalid',
    (value) => expect(() => normalizeCode(value, 'political_group')).toThrow(),
  );
  it.each([
    [{}, 'THE-LEFT'],
    [{ term: 0 }, 'GUE-NGL'],
    [{ term: 8 }, 'GUE-NGL'],
    [{ term: 9 }, 'THE-LEFT'],
    [{ term: 10 }, 'THE-LEFT'],
    [{ mandate_date: '2016-03-09' }, 'GUE-NGL'],
    [{ mandate_date: '2020-12-17' }, 'GUE-NGL'],
    [{ mandate_date: '2020-12-18' }, 'GUE-NGL'],
    [{ mandate_date: '2020-12-19' }, 'THE-LEFT'],
    [{ mandate_date: '2021-01-18' }, 'THE-LEFT'],
  ] as const)('sends GUE/NGL on roster %j as %s, and each code as itself', (roster, expected) => {
    expect(normalizeCode(' Gue/Ngl ', 'political_group', roster)).toBe(expected);
    expect(normalizeCode('GUE-NGL', 'political_group', roster)).toBe('GUE-NGL');
    expect(normalizeCode('The Left', 'political_group', roster)).toBe('THE-LEFT');
  });
  const twoCodes =
    'GUE/NGL names two group codes: GUE-NGL (label GUE/NGL, 1995-01-06 to 2020-12-17) and THE-LEFT (The Left, from 2020-12-18, whose published name ends in GUE/NGL).';
  const leftDays =
    'from 2020-12-19 (the dated roster runs a day later than the published versions)';
  const gueDays =
    'from 1995-01-07 through 2020-12-18 (the dated roster runs a day later than the published versions)';
  const leftSent = `${twoCodes} This call sent THE-LEFT; to select the other group, pass political_group GUE-NGL.`;
  const gueOnTerm = `${twoCodes} This call sent GUE-NGL; to select the other group, pass political_group THE-LEFT with term 9, whose roster holds both codes, or with a mandate_date ${leftDays}.`;
  const leftOnTerm = `${twoCodes} This call sent THE-LEFT; to select the other group, pass political_group GUE-NGL with term 9, whose roster holds both codes, or with a mandate_date ${gueDays}.`;
  const gueOnDay = `${twoCodes} This call sent GUE-NGL. A mandate_date or current roster matches only the code in force that day, so THE-LEFT matches no member here; to select it, pass political_group THE-LEFT with a mandate_date ${leftDays} or with term 9.`;
  const leftOnDay = `${twoCodes} This call sent THE-LEFT. A mandate_date or current roster matches only the code in force that day, so GUE-NGL matches no member here; to select it, pass political_group GUE-NGL with a mandate_date ${gueDays} or with term 9.`;
  it.each([
    [{ term: 9 }, 'THE-LEFT', leftSent],
    [{ term: 8 }, 'GUE-NGL', gueOnTerm],
    [{ term: 0 }, 'GUE-NGL', gueOnTerm],
    [{ term: 10 }, 'THE-LEFT', leftOnTerm],
    [{ mandate_date: '2020-12-17' }, 'GUE-NGL', gueOnDay],
    [{ mandate_date: '2020-12-18' }, 'GUE-NGL', gueOnDay],
    [{ mandate_date: '2021-01-18' }, 'THE-LEFT', leftOnDay],
    [{}, 'THE-LEFT', leftOnDay],
  ] as const)(
    'routes the other code of GUE/NGL on roster %j, sent as %s, to a roster that matches it',
    (roster, code, notice) => {
      expect(politicalGroupNotice(' gue/ngl ', code, roster)).toBe(notice);
    },
  );
  it.each([
    ['GUE-NGL', 'GUE-NGL'],
    ['The Left', 'THE-LEFT'],
    [undefined, undefined],
  ])('adds no two-code notice for %j', (value, code) => {
    expect(politicalGroupNotice(value, code)).toBeUndefined();
  });
  it('rejects an unknown group naming the parameter, the value, every code and the listing call', () => {
    let error: unknown;
    try {
      normalizeCode(' bogus ', 'political_group');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Unsupported political_group filter "bogus". Accepted codes: ${groupCodes}. Published labels (Aucun, GUE/NGL, IND/DEM, PfE, Renew, S&D, The Left, Verts/ALE) and the aliases EPP, Greens/EFA, and Patriots are accepted too, in any case.`,
    );
    expect(error).toMatchObject({
      data: {
        reason: 'invalid_filter',
        recovery: {
          hint: 'Call euparl_list_reference with topic mep_filters for each group code with its label and periods, then retry with one of them.',
        },
      },
    });
  });
  it('lists each published group code once with its label and merged version periods', () => {
    const groups = referenceEntries('mep_filters').filter((entry) =>
      entry.description?.startsWith('political_group;'),
    );
    expect(groups.map((entry) => entry.code).join(', ')).toBe(groupCodes);
    const row = (code: string) => groups.find((entry) => entry.code === code);
    expect(row('GUE-NGL')?.label).toEqual({ value: 'GUE/NGL', language: 'mul' });
    expect(row('GUE-NGL')?.description).toContain('versions 1995-01-06 to 2020-12-17;');
    expect(row('PPE')?.description).toContain(
      'versions 1979-07-17 to 1999-07-19 and from 2009-07-14;',
    );
    expect(row('EFDD')?.description).toContain(
      'versions 2014-07-01 to 2014-10-15 and 2014-10-20 to 2019-07-01;',
    );
    expect(row('NI')?.description).toContain('versions from 1953-06-23;');
    expect(row('IND-DEM')?.label).toEqual({ value: 'IND/DEM', language: 'mul' });
    expect(row('PFE')?.description).toContain('also PfE and Patriots');
    expect(row('VERTS-ALE')?.description).toContain('also Verts/ALE and Greens/EFA');
    expect(row('THE-LEFT')?.description).toContain(
      'GUE/NGL selects it on term 9 and later, the current roster and dates after 2020-12-18;',
    );
    expect(row('GUE-NGL')?.description).toContain(
      'GUE/NGL selects it on terms 0–8 and dates through 2020-12-18;',
    );
    for (const code of ['GUE-NGL', 'THE-LEFT'])
      expect(row(code)?.description).toContain(
        'the dated roster switches from GUE-NGL to THE-LEFT after 2020-12-18, a day later than the published versions.',
      );
    expect(groups.map((entry) => entry.code)).not.toContain('PATRIOTS');
  });
  it.each([
    [
      'country',
      'BE, BG, CZ, DK, DE, EE, IE, GR, ES, FR, HR, IT, CY, LV, LT, LU, HU, MT, NL, AT, PL, PT, RO, SI, SK, FI, SE, GB',
    ],
    ['political_group', groupCodes],
    ['gender', 'FEMALE, MALE, NAP, NKN, NST'],
  ] as const)('lists every canonical %s code in invalid-filter guidance', (family, expected) => {
    expect(() => normalizeCode('invalid', family)).toThrow(`Accepted codes: ${expected}.`);
  });
  /** The thrown rejection, for message and data assertions. */
  function rejection(run: () => unknown): { message: string; data: unknown } {
    try {
      run();
    } catch (caught) {
      return caught as { message: string; data: unknown };
    }
    throw new Error('expected a rejection');
  }
  it.each([
    [
      'language',
      ' xx ',
      'Unsupported language filter "xx". Accepted codes: bg, es, cs, da, de, et, el, en, fr, ga, hr, it, lv, lt, hu, mt, nl, pl, pt, ro, sk, sl, fi, sv.',
      'Call euparl_list_reference with topic identifiers for every accepted code, then retry language with one of them.',
    ],
    [
      'process_type',
      'XYZ',
      'Unsupported process_type filter "XYZ". Accepted codes: ACI, APP, AVC, BUD, CNS, COD, DEC, NLE, SYN, BUI, COS, DEA, DCE, IMM, INI, INL, INS, REG, RPS, RSO, RSP, GBD.',
      'Call euparl_list_reference with topic procedure_types for every accepted code, then retry process_type with one of them.',
    ],
    [
      'adopted_texts',
      'UNKNOWN',
      'Unsupported work_type filter "UNKNOWN" for source adopted_texts. Accepted codes: TEXT_ADOPTED, AMENDMENT_BUDGET_EU_DRAFT, BUDGET_EP_DRAFT.',
      'Call euparl_list_reference with topic document_types for every accepted code, then retry work_type with one of them.',
    ],
    [
      'question',
      'UNKNOWN',
      'Unsupported work_type filter "UNKNOWN". Accepted codes: QUESTION_WRITTEN_PRIORITY, QUESTION_WRITTEN, QUESTION_ORAL, INTERPELLATION_MAJOR, INTERPELLATION_MINOR, QUESTION_TIME.',
      'Call euparl_list_reference with topic question_types for every accepted code, then retry work_type with one of them.',
    ],
    [
      'activity_type',
      'speech',
      'Unsupported activity_type filter "speech". Accepted codes: MEETING_NAME_CHAIR, PROCEEDING_ACTIVITY, PLENARY_DEBATE_SPEECH, PLENARY_DEBATE_WRITTEN_STATEMENT, VOTE_EXPLANATION_ORAL.',
      'Call euparl_list_reference with topic activity_types for every accepted code, then retry activity_type with one of them.',
    ],
    [
      'country',
      'XX',
      'Unsupported country filter "XX". Accepted codes: BE, BG, CZ, DK, DE, EE, IE, GR, ES, FR, HR, IT, CY, LV, LT, LU, HU, MT, NL, AT, PL, PT, RO, SI, SK, FI, SE, GB.',
      'Call euparl_list_reference with topic mep_filters for every accepted code, then retry country with one of them.',
    ],
    [
      'gender',
      'other',
      'Unsupported gender filter "other". Accepted codes: FEMALE, MALE, NAP, NKN, NST.',
      'Call euparl_list_reference with topic mep_filters for every accepted code, then retry gender with one of them.',
    ],
  ] as const)(
    'rejects an unsupported %s code naming the parameter, the value, every code and the topic',
    (family, value, message, hint) => {
      const error = rejection(() => normalizeCode(value, family));
      expect(error.message).toBe(message);
      expect(error.data).toEqual({ reason: 'invalid_filter', field: family, recovery: { hint } });
    },
  );
  it.each([
    [
      'adopted_texts',
      ' report_plenary ',
      'Unsupported work_type filter "report_plenary" for source adopted_texts. Accepted codes: TEXT_ADOPTED, AMENDMENT_BUDGET_EU_DRAFT, BUDGET_EP_DRAFT. REPORT_PLENARY is a document work type accepted with source "plenary".',
      'Retry with source "plenary" and work_type REPORT_PLENARY, or call euparl_list_reference with topic document_types for each work type and its source.',
    ],
    [
      'committee',
      'TEXT_ADOPTED',
      'Unsupported work_type filter "TEXT_ADOPTED" for source committee. Accepted codes: OPINION_PARLIAMENTARY_COMMITTEE_DRAFT, OPINION_PARLIAMENTARY_COMMITTEE, OPINION_LETTER_PARLIAMENTARY_COMMITTEE, REPORT_PARLIAMENTARY_COMMITTEE_DRAFT, AGREEMENT_PROVISIONAL. TEXT_ADOPTED is a document work type accepted with source "adopted_texts".',
      'Retry with source "adopted_texts" and work_type TEXT_ADOPTED, or call euparl_list_reference with topic document_types for each work type and its source.',
    ],
    [
      'plenary',
      'question_written',
      'Unsupported work_type filter "question_written" for source plenary. Accepted codes: REPORT_PLENARY, RESOLUTION_MOTION, RESOLUTION_MOTION_JOINT, QUESTION_RESOLUTION_MOTION. QUESTION_WRITTEN is a question work type accepted by euparl_list_questions.',
      'Call euparl_list_questions with work_type QUESTION_WRITTEN, or call euparl_list_reference with topic document_types for each document work type and its source.',
    ],
    [
      'question',
      'REPORT_PLENARY',
      'Unsupported work_type filter "REPORT_PLENARY". Accepted codes: QUESTION_WRITTEN_PRIORITY, QUESTION_WRITTEN, QUESTION_ORAL, INTERPELLATION_MAJOR, INTERPELLATION_MINOR, QUESTION_TIME. REPORT_PLENARY is a document work type accepted by euparl_search_documents with source "plenary".',
      'Call euparl_search_documents with source "plenary" and work_type REPORT_PLENARY, or call euparl_list_reference with topic question_types for each question work type.',
    ],
  ] as const)(
    'rejects %s work type %j naming the source or tool that takes it',
    (family, value, message, hint) => {
      const error = rejection(() => normalizeCode(value, family));
      expect(error.message).toBe(message);
      expect(error.data).toEqual({ reason: 'invalid_filter', field: family, recovery: { hint } });
    },
  );
  it('exposes actual identifiers and operational coverage rather than unsupported search promises', () => {
    expect(
      referenceEntries('identifiers').find((item) => item.code === 'question')?.description,
    ).toContain('Omitted term verifies canonical candidates for all overlapping terms');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'speeches')?.description,
    ).toContain('not transcripts');
    expect(
      referenceEntries('coverage').find((item) => item.code === 'questions')?.description,
    ).toContain('Missing answer links do not prove unanswered');
  });
  it('keeps question addressees and EU authority URIs away from topic organizations', () => {
    const organization = referenceEntries('identifiers').find(
      (item) => item.code === 'organization',
    )?.description;
    expect(organization).toContain(
      'EU authority URIs (http://publications.europa.eu/resource/authority/corporate-body/…) are not accepted, and question addressee_ids do not resolve here: COM is the Communist and Allies Group, and EU_COMMISSION, EU_COUNCIL and HRVP return no name.',
    );
  });
  it('states acquisition bounds, local sizing, snapshots and stable search geometry', () => {
    const paging = referenceEntries('coverage').find((item) => item.code === 'paging')?.description;
    for (const expected of [
      '1000 procedures',
      '1000 questions',
      '1000 documents',
      '1000 sittings',
      '1000 reference entries',
      '20 organization lookups',
      'without an output-size cap',
      'EUPARL_CLAMP_LIMITS=false',
      'adopted texts counting their 10000-result search window as that bound while still returning 100-row pages',
      'aligned 100-row pages',
      'relevance order',
      'offsets of 10000 or more fail',
      'optional snapshot',
      'snapshot_changed before slicing',
    ])
      expect(paging).toContain(expected);
    expect(paging).not.toContain('92000');
  });
});
