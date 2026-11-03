/** @fileoverview Sparse and nested published shapes at the JSON-LD parsing edge. */
import { describe, expect, it } from 'vitest';
import {
  bodySchema,
  decisionSchema,
  documentSchema,
  mepSchema,
  procedureSchema,
  questionSchema,
  sittingSchema,
  speechSchema,
} from '../../../src/services/eu-parliament/eu-parliament-schemas.js';
import {
  decisionRecord,
  documentRecord,
  mepRecord,
  questionRecord,
  rosterRecords,
} from '../../helpers/eu-parliament-fixtures.js';

describe('Parliament noun schemas', () => {
  it('retains published full body names and sparse temporal intervals', () => {
    const body = {
      id: 'org/5144',
      label: 'DLAT',
      prefLabel: { en: 'Delegation example' },
      temporal: { startDate: '2019-07-02' },
    };
    expect(bodySchema.parse(body)).toEqual(body);
    expect(bodySchema.parse({ id: 'org/2' })).toEqual({ id: 'org/2' });
  });
  it('retains singleton and array document adoption relations and register notation', () => {
    const raw = {
      id: 'eli/dl/doc/TA-9-2024-0138',
      adopts: { id: 'eli/dl/doc/A-9-2023-0188' },
      based_on: ['RULES-9-2023-05-08-ITM-A58'],
      notation_publicRegister: 'P9_TA(2024)0138',
    };
    expect(documentSchema.parse(raw)).toEqual(raw);
  });
  it('preserves sparse historical roster identities without inventing context', () => {
    expect(mepSchema.parse(rosterRecords[1])).toEqual({
      id: 'person/900000002',
      identifier: '900000002',
      label: 'Élodie DEMO',
      givenName: 'Élodie',
      familyName: 'Demo',
    });
  });

  it('preserves camelCase membership intervals', () => {
    expect(mepSchema.parse(mepRecord).hasMembership).toEqual([
      {
        id: 'membership/900000001-m-1',
        organization: 'org/ep-10',
        role: 'def/ep-roles/MEMBER_PARLIAMENT',
        memberDuring: { startDate: '2024-07-16' },
      },
    ]);
  });

  it('retains every nested expression and manifestation', () => {
    const parsed = documentSchema.parse(documentRecord);
    expect(
      parsed.is_realized_by?.map((expression) =>
        expression.is_embodied_by?.map((file) => file.is_exemplified_by),
      ),
    ).toEqual([
      ['distribution/example/opinion_fr.pdf', 'distribution/example/opinion_fr.html'],
      ['distribution/example/opinion_en.pdf'],
    ]);
  });

  it('retains embedded answer works with their selected-language files', () => {
    const parsed = questionSchema.parse(questionRecord);
    expect(parsed.inverse_answers_to).toHaveLength(1);
    expect(parsed.inverse_answers_to?.[0]).toMatchObject({
      identifier: 'E-10-2025-900001-ASW',
      document_date: '2025-02-15',
      is_realized_by: [
        {
          is_embodied_by: [
            { is_exemplified_by: 'distribution/example/opinion_fr.pdf' },
            { is_exemplified_by: 'distribution/example/opinion_fr.html' },
          ],
        },
        { is_embodied_by: [{ is_exemplified_by: 'distribution/example/opinion_en.pdf' }] },
      ],
    });
  });

  it('preserves zero tallies and all six positions while leaving absent tallies absent', () => {
    const parsed = decisionSchema.parse(decisionRecord);
    expect(parsed.number_of_votes_abstention).toBe(0);
    expect(parsed).not.toHaveProperty('number_of_attendees');
    expect(parsed.had_voter_favor).toEqual(['person/900000001', 'person/900000002']);
    expect(parsed.had_voter_against).toEqual(['person/900000003']);
    expect(parsed.had_voter_abstention).toEqual([]);
    expect(parsed.had_voter_intended_favor).toEqual(['person/900000004']);
    expect(parsed.had_voter_intended_against).toEqual(['person/900000005']);
    expect(parsed.had_voter_intended_abstention).toEqual(['person/900000006']);
    expect(decisionSchema.parse({ id: decisionRecord.id })).not.toHaveProperty('had_voter_favor');
  });

  it.each([
    ['sitting', sittingSchema],
    ['speech', speechSchema],
    ['decision', decisionSchema],
  ] as const)(
    'reads a %s date published only as a typed literal as its written calendar day',
    (_, schema) => {
      for (const [value, date] of [
        ['2019-01-14T00:00:00+01:00', '2019-01-14'],
        ['2019-07-02T00:00:00+02:00', '2019-07-02'],
      ])
        expect(
          schema.parse({
            id: 'eli/dl/event/EXAMPLE',
            'eli-dl:activity_date': { '@value': value, type: 'xsd:dateTime' },
          }),
        ).toEqual({ id: 'eli/dl/event/EXAMPLE', activity_date: date });
    },
  );

  it('reads typed-literal dates on nested procedure events and on singleton or array participations', () => {
    const typed = (value: string) => ({ '@value': value, type: 'xsd:dateTime' });
    const procedure = procedureSchema.parse({
      id: 'eli/dl/proc/2018-0089',
      consists_of: [
        { id: 'eli/dl/event/EV-1', 'eli-dl:activity_date': typed('2018-05-02T00:00:00+02:00') },
        { id: 'eli/dl/event/EV-2', activity_date: '2020-11-24' },
      ],
      had_participation: [
        {
          id: 'eli/dl/participation/P-1',
          'eli-dl:activity_date': typed('2018-12-12T00:00:00+01:00'),
        },
      ],
    });
    expect(procedure.consists_of).toEqual([
      { id: 'eli/dl/event/EV-1', activity_date: '2018-05-02' },
      { id: 'eli/dl/event/EV-2', activity_date: '2020-11-24' },
    ]);
    expect(procedure.had_participation).toEqual([
      { id: 'eli/dl/participation/P-1', activity_date: '2018-12-12' },
    ]);
    expect(
      speechSchema.parse({
        id: 'eli/dl/event/S-1',
        had_participation: {
          id: 'p/1',
          'eli-dl:activity_date': typed('2021-07-05T00:00:00+02:00'),
        },
      }).had_participation,
    ).toEqual({ id: 'p/1', activity_date: '2021-07-05' });
  });

  it('rejects a typed-literal date that does not open with a calendar day', () => {
    expect(
      sittingSchema.safeParse({
        id: 'eli/dl/event/MTG-PL-2019-01-14',
        'eli-dl:activity_date': { '@value': 'Monday, 14 January 2019', type: 'xsd:dateTime' },
      }).success,
    ).toBe(false);
  });

  it('accepts singleton speech participation and sparse source references', () => {
    expect(
      speechSchema.parse({
        id: 'eli/dl/event/MTG-PL-2025-01-15-OTH-900001',
        had_participation: {
          id: 'eli/dl/participation/example',
          had_participant_person: ['person/900000001'],
        },
        recorded_in_a_realization_of: ['eli/dl/doc/CRE-10-2025-01-15-OTH-900001'],
      }),
    ).toMatchObject({ had_participation: { had_participant_person: ['person/900000001'] } });
  });
});
