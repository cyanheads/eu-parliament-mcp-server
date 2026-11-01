---
name: eu-parliament-guide
description: Use euparl_* tools to trace a European Parliament file to its plenary votes and debate, establish how members or a national delegation voted, or read members, documents and questions for a past term. Covers procedure, document, sitting and question identifiers, the term calendar, final-vote selection, and the conclusions missing data cannot support.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this guide when an answer needs more than one Parliament record: a file's path from report to vote, a member's or delegation's recorded position, the debate on a file, or membership at a past date. The server reads European Parliament Open Data without a key: procedures, Parliament documents (metadata and file links), plenary sittings, decisions and roll-call voters, speech metadata for terms 9 and 10, members and their membership history, and parliamentary questions.

It does not read the text of any document, speech or answer; files are linked, not opened. Commission and Council records are outside it, and so is the enacted act: a procedure records its Official Journal publication date but links no published act.

## Identifiers

| Identifier | Form | Comes from | Goes to |
|:--|:--|:--|:--|
| Procedure | reference `2021/0106(COD)`, canonical `2021-0106` | euparl_list_procedures, or the user | euparl_get_procedure; the adopted-text procedure filter of euparl_search_documents |
| Document | `TA-9-2024-0138`; its `label` is the citation `T9-0138/2024` | document search, procedure events and documents, decisions, speeches, question answers | euparl_search_documents get; the decisions document filter |
| Person | decimal `197394`; `person/197394` in creator lists | euparl_search_meps, voters, speech and procedure participants, creator lists | euparl_get_mep, speech search, decision member lookup |
| Sitting | a date `2024-03-13` or `MTG-PL-2024-03-13` | procedure event dates, sittings mode | euparl_get_plenary_votes |
| Decision | `MTG-PL-2024-03-13-DEC-166051` | decisions mode only | decision and voters modes, with its sitting |
| Organization | decimal `org/5154` | membership history | euparl_list_reference organizations |
| Question | `E-9-2023-000003`, citation `E-000003/2023`; answer `E-9-2023-000003-ASW` | euparl_list_questions | question get; answers go to document get |

Document identifiers name their family:

| Prefix | Record |
|:--|:--|
| `TA-` | text adopted in plenary |
| `A-` | committee report tabled for plenary; `A-…-AM-808` is its amendment 808 |
| `B-` | motion for a resolution |
| `C-` | proposal as referred to Parliament; detail is usually unpublished (found false) |
| `ENVI-PA-`, `ENVI-AD-` | a committee's draft opinion, adopted opinion (the prefix is the committee code) |
| `CJ40-PR-`, `CJ40-AG-` | draft report, provisional agreement (`CJnn` is a joint committee) |
| `CRE-9-2024-03-12` | verbatim report of a sitting day; `-ITM-012` one agenda item, `-OTH-…` one speech |
| `PV-9-2024-03-13` | minutes; `-VOT-ITM-` vote results, `-RCV-ITM-` one roll-call record |
| `E-` `P-` `O-` `G-` `K-` | written, priority written, oral question; major, minor interpellation |

Procedure participants name committees and political groups by code (`org/IMCO`, `org/S-D`), and document creator lists name committees the same way. The organizations topic rejects these codes; the committees topic labels several undated decimal IDs with each code, one per period of the committee, and the organizations topic dates each ID. A term field of `org/ep-9` means term 9.

Terms are five-year mandates numbered from the first direct election: term 1 began 1979-07-17. Term 8 ran 2014-07-01 to 2019-07-01, term 9 2019-07-02 to 2024-07-15, and term 10 began 2024-07-16.

## Gates

- **Set the term from the date before** naming voters, searching speeches, or reading a past roster. A wrong roster term is not rejected: it silently leaves voters unresolved, as when a March 2024 vote is looked up against term 10. Speech search defaults to term 10, so a term-9 date returns nothing with a generic no-match notice.
- **Get the procedure reference before procedure work.** No tool maps a topic or a document to its procedure: document detail lists no procedure on adopted texts or reports, and the procedure list has no keyword filter. Ask the user or another source for the `YYYY/NNNN(TYPE)` reference. Without one, work from the adopted text: its adopted documents name the report, and the report citation finds the votes.
- **Do not rely on the decisions document filter to find a final vote.** It matches only decisions whose `document_ids` name the report or one of its parts, and final votes often list none. When the filtered page lacks the vote you need, page the sitting's decisions and match the report citation (the document `label`, e.g. `A9-0188/2023`) inside decision labels; the separator between label parts varies.
- **Name what was voted.** A label runs from the report citation and rapporteur (sometimes after a title) to the item voted, and some hand-vote labels carry the item alone. The item is an amendment (`Am 220-223`, `§ 25/2`, `Recital I`), `Provisional agreement – Am 808`, `Commission proposal`, `Motion for a resolution (as a whole)`, `Decision to enter into interinstitutional negotiations`. Report that item. One file can be voted at several sittings (amendments and a referral back for negotiations, then the provisional agreement months later), so match the sitting to the stage asked about.
- **Check voter_counts before a member-level answer.** Only a decision whose voter_counts lists a position has voters to page. Hand votes typically carry an outcome only, and electronic or secret votes tallies only. Without arrays, report the outcome or tally and say member positions were not recorded.
- **Take a voter's country from a roster of the vote's date, never from today's.** Voter rows carry IDs and optional names only. The dated roster (euparl_search_meps with a mandate date) lists who held a seat that day. A term roster filtered by country lists everyone who sat for it during the term (seven for Malta in term 9, one of whom left in 2020); confirm a candidate's seat on the vote date from their `org/ep-N` membership with role `MEMBER_PARLIAMENT`. Today's roster (omitted term) fits only votes held now.
- **Read affiliation at a date from membership history.** The `EU_POLITICAL_GROUP` membership interval gives the group on a date; resolve its decimal ID with the organizations topic. Group organization IDs change each term (S&D is `org/4284` in term 8, `org/5154` in term 9).
- **Do not enumerate a member's questions.** Questions have no author, addressee or keyword filter, list rows carry no author, and the list reports no total. Ask for the citation; a question's `person/` creators open with euparl_get_mep (committee and group creators are corporate-body URIs it rejects).
- **Missing is not negative.** A `C-` proposal returning found false, an empty answers list, an empty member position, or an event without documents describes what was published, not what happened.

## Core chain

1. euparl_get_procedure overview gives section counts; read the events section next.
2. Events seldom carry sitting relations, so their dates route onward. The `PLENARY_VOTE_RESULTS` event names the procedure's own report (`A-…`) and the vote date. `PLENARY_VOTE` events can list every report voted under one agenda item, so do not take the report from them. `PLENARY_DEBATE` gives the debate date and its `CRE-…-ITM-…` item. Committee events carry the opinions and draft reports.
3. Pass the vote date as the sitting to euparl_get_plenary_votes and find the decision (gates above). For a few named members, a member ID in decision mode answers in one call each; for a delegation or the whole chamber, page voters by position.
4. The adopted-text filter on the procedure reference returns the file's adopted texts; an adopted text's adopted documents name the report it adopts.
5. For the debate, search speeches with the debate date, the term for that date, and title words from the debate's `CRE` item; results also carry written statements and procedural records, so count speeches by `activity_type`. A speech belongs to the procedure's debate when its recording document's parent is that event's `CRE-…-ITM-…` item. One debate item can cover several files (a joint debate lists each file's report on its event).
6. For files, read the document; when it has no links, follow parent documents. A speech's recording document reaches files in two parent hops, the agenda item and then the sitting day, whose files are multilingual (`mul`). Roll-call records reach the day's `PV-…-RCV` document the same way.

## Workflows

### Committee and rapporteurs on a file

The participants section of euparl_get_procedure carries roles such as `COMMITTEE_LEAD`, `COMMITTEE_OPINION`, `COMMITTEE_OPINION_ASSOCIATED`, `RAPPORTEUR_CO`, `RAPPORTEUR_OPINION` and `RAPPORTEUR_SHADOW`. A rapporteur's represented organization is the committee they act for, and the political group is the one recorded with that participation. Open people with euparl_get_mep.

### Who sat for a country on a date

For today, filter the current roster by country. For a past date, pass it as the mandate date with the country filter. A term's first sitting day is unreliable upstream (an error, or a partial roster), so use the following day when the term boundary is not the question. To cross-check, filter the term roster and read each candidate's `MEMBER_PARLIAMENT` interval in their membership history; the term roster alone overcounts members who left or arrived mid-term.
