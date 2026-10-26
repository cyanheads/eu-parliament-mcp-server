/**
 * @fileoverview Edge schemas for verified Parliament JSON-LD nouns.
 * @module services/eu-parliament/eu-parliament-schemas
 */
import { z } from 'zod';

/** Published language maps are source text, never translated. */
const localizedSchema = z.record(z.string(), z.string());
const referenceSchema = z.union([z.string(), z.object({ id: z.string() })]);
const referencesSchema = z.union([referenceSchema, z.array(referenceSchema)]).optional();
/** Participation may be a singleton object on speech records. */
const participationSchema = z.object({
  id: z.string(),
  had_participant_person: referencesSchema,
  had_participant_organization: referencesSchema,
  participation_role: z.string().optional(),
  activity_date: z.string().optional(),
  occured_at_stage: z.string().optional(),
  politicalGroup: z.string().optional(),
  participation_in_name_of: z.string().optional(),
  parliamentary_term: z.string().optional(),
});
const participationsSchema = z
  .union([participationSchema, z.array(participationSchema)])
  .optional();
/** Source files are linked rather than fetched. */
const manifestationSchema = z.object({
  id: z.string(),
  is_exemplified_by: referencesSchema,
  media_type: z.string().optional(),
  issued: z.string().optional(),
  byteSize: z.string().optional(),
});
/** Every manifestation in the selected published language is preserved. */
const expressionSchema = z.object({
  id: z.string(),
  language: z.string().optional(),
  title: localizedSchema.optional(),
  is_embodied_by: z.array(manifestationSchema).optional(),
});
const documentFields = {
  id: z.string(),
  identifier: z.string().optional(),
  label: z.string().optional(),
  work_type: z.string().optional(),
  title_dcterms: localizedSchema.optional(),
  document_date: z.string().optional(),
  parliamentary_term: z.string().optional(),
  creator: referencesSchema,
  is_part_of: referencesSchema,
  is_realized_by: z.array(expressionSchema).optional(),
  refers_to: referencesSchema,
  is_about: referencesSchema,
  adopts: referencesSchema,
  based_on: referencesSchema,
  notation_publicRegister: z.string().optional(),
};
/** Generic works include sparse speech subdivisions and embedded answers. */
export const documentSchema = z.object(documentFields);
/** Question detail embeds answer work records. */
export const questionSchema = z.object({
  ...documentFields,
  inverse_answers_to: z.array(z.union([z.string(), documentSchema])).optional(),
});
/** Event relationships vary by activity type. */
const eventSchema = z.object({
  id: z.string(),
  activity_id: z.string().optional(),
  activity_date: z.string().optional(),
  had_activity_type: z.string().optional(),
  occured_at_stage: z.string().optional(),
  decided_on_a_realization_of: referencesSchema,
  based_on_a_realization_of: referencesSchema,
  recorded_in_a_realization_of: referencesSchema,
  created_a_realization_of: referencesSchema,
  documented_by_a_realization_of: referencesSchema,
  was_scheduled_in: referencesSchema,
});
/** Procedure detail and sparse catalogue entries share one validated noun. */
export const procedureSchema = z.object({
  id: z.string(),
  process_id: z.string().optional(),
  label: z.string().optional(),
  process_type: z.string().optional(),
  process_title: localizedSchema.optional(),
  current_stage: z.string().optional(),
  consists_of: z.array(eventSchema).optional(),
  had_participation: participationsSchema,
  created_a_realization_of: referencesSchema,
});
/** Memberships deliberately omit contact details. */
const membershipSchema = z.object({
  id: z.string(),
  organization: z.string().optional(),
  membershipClassification: z.string().optional(),
  role: z.string().optional(),
  memberDuring: z
    .object({ startDate: z.string().optional(), endDate: z.string().optional() })
    .optional(),
});
/** Roster context is optional on historical term records. */
export const mepSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  label: z.string().optional(),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  sortLabel: z.string().optional(),
  'api:country-of-representation': z.string().optional(),
  'api:political-group': z.string().optional(),
  citizenship: z.string().optional(),
  placeOfBirth: z.string().optional(),
  hasMembership: z.array(membershipSchema).optional(),
});
const activityFields = {
  id: z.string(),
  activity_id: z.string().optional(),
  activity_date: z.string().optional(),
  activity_start_date: z.string().optional(),
  activity_end_date: z.string().optional(),
  activity_label: localizedSchema.optional(),
  had_activity_type: z.string().optional(),
};
/** Speech labels and document references do not imply a transcript. */
export const speechSchema = z.object({
  ...activityFields,
  had_participation: participationsSchema,
  recorded_in_a_realization_of: referencesSchema,
});
/** Sitting discovery uses the source activity identity. */
export const sittingSchema = z.object(activityFields);
/** Recorded and intended arrays remain separately optional. */
export const decisionSchema = z.object({
  ...activityFields,
  activity_order: z.string().optional(),
  decision_method: z.string().optional(),
  decision_outcome: z.string().optional(),
  number_of_attendees: z.number().optional(),
  number_of_votes_favor: z.number().optional(),
  number_of_votes_against: z.number().optional(),
  number_of_votes_abstention: z.number().optional(),
  had_voter_favor: z.array(z.string()).optional(),
  had_voter_against: z.array(z.string()).optional(),
  had_voter_abstention: z.array(z.string()).optional(),
  had_voter_intended_favor: z.array(z.string()).optional(),
  had_voter_intended_against: z.array(z.string()).optional(),
  had_voter_intended_abstention: z.array(z.string()).optional(),
  decided_on_a_realization_of: referencesSchema,
  recorded_in_a_realization_of: referencesSchema,
  referenceText: localizedSchema.optional(),
  comment: localizedSchema.optional(),
});
/** Live reference bodies carry classification rather than filter-code guesses. */
export const bodySchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  label: z.union([z.string(), localizedSchema]).optional(),
  classification: z.string().optional(),
  prefLabel: localizedSchema.optional(),
  temporal: z
    .object({ startDate: z.string().optional(), endDate: z.string().optional() })
    .optional(),
});

/** Parsed upstream record types. */
export type RawDocument = z.infer<typeof documentSchema>;
export type RawQuestion = z.infer<typeof questionSchema>;
export type RawProcedure = z.infer<typeof procedureSchema>;
export type RawMep = z.infer<typeof mepSchema>;
export type RawSpeech = z.infer<typeof speechSchema>;
export type RawDecision = z.infer<typeof decisionSchema>;
export type RawParticipation = z.infer<typeof participationSchema>;
export type RawBody = z.infer<typeof bodySchema>;
