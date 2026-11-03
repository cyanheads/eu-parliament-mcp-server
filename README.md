<div align="center">
  <h1>@cyanheads/eu-parliament-mcp-server</h1>
  <p><b>Track European Parliament procedures, MEPs, votes, documents, speeches, and questions via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eu-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eu-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eu-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eu-parliament-mcp-server/releases/latest/download/eu-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eu-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXUtcGFybGlhbWVudC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eu-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feu-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eu-parliament.caseyjhand.com/mcp](https://eu-parliament.caseyjhand.com/mcp)

</div>

---

## Overview

European Parliament records from the [Open Data API](https://data.europarl.europa.eu/): discover legislative procedures, follow their evidence, find MEPs, inspect plenary decisions and voters, and retrieve document, speech, and question metadata. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `euparl_list_reference` | Discover filter codes, identifier formats, coverage, committees, and political groups; resolve organization IDs |
| `euparl_list_procedures` | List procedure references by type |
| `euparl_get_procedure` | Read procedure identity, stage, events, participants, and document references |
| `euparl_search_documents` | Search adopted texts, list committee/plenary documents, or retrieve any canonical document |
| `euparl_search_speeches` | Search ninth- or tenth-term speech activities and retrieve metadata and recording-document links |
| `euparl_search_meps` | Find MEPs across a complete current, dated, or selected-term roster |
| `euparl_get_mep` | Read member identity and published membership history |
| `euparl_get_plenary_votes` | Discover sittings, inspect decisions, and page recorded or intended voters |
| `euparl_list_questions` | List questions by year/type or retrieve a question and answer references |

### Agent skill

[`skills/eu-parliament-guide`](skills/eu-parliament-guide/SKILL.md) is served over MCP as `skill://eu-parliament-guide/SKILL.md` and ships in the npm package, Docker image, and `.mcpb` bundle. It covers identifier chains from procedure to vote and debate, the term calendar, choosing a file's final vote, a voter's country on the vote date, and conclusions missing data cannot support.

## Capability reference

### `euparl_list_reference` <sub>tool</sub>

- Required `topic`: `committees`, `political_groups`, `organizations`, `procedure_types`, `document_types`, `question_types`, `activity_types`, `mep_filters`, `identifiers`, or `coverage`
- `committees` and `political_groups` page Parliament's corporate-body records, historical bodies included; their organization IDs are not filter codes. Published full names and dates are included when available
- `organizations` requires `organization_ids`: decimal IDs or the case-sensitive codes other tools return (`IMCO`, `S-D`, `ep-9`, `EU_PARLIAMENT`), bare, with an `org/` prefix, or as exact public organization URIs. A code in the wrong case is a `found: false` miss; labels such as `S&D` are rejected. Results retain input order and duplicates with per-item `found`; repeat the same IDs with `page.next_offset` for continuation. At most 20 IDs are looked up per call; reference pages need no snapshot

---

### `euparl_list_procedures` <sub>tool</sub>

- Optional `process_type` from `euparl_list_reference`; no keyword, year, committee, or stage filter
- With `process_type`, every procedure of that type is read in one request and paged in `procedure_id` order; follow `page.next_offset`, optionally passing `page.snapshot` back to detect a changed set
- Without `process_type`, Parliament serves pages from two orderings, so pages can repeat or omit procedures; each page says so
- Sparse rows carry `procedure_id`, source URL, and available reference/type; retrieve titles, stages, and participants with `euparl_get_procedure`

---

### `euparl_get_procedure` <sub>tool</sub>

- Required `procedure_id` accepts `YYYY-NNNN`, `YYYY/NNNN(TYPE)`, an optional letter suffix, the known path prefix, or the exact public procedure URI
- `section: "overview"` returns scalar metadata and collection counts; `events`, `participants`, and `documents` page one collection using snapshots. Events and participants come in date order (undated last), documents in ID order
- Historical participant groups stay historical. Follow document IDs with `euparl_search_documents` in get mode

---

### `euparl_search_documents` <sub>tool</sub>

- `mode: "search"` defaults to `source: "adopted_texts"`, the only family with `text`, `title`, sitting-date, and `related_process_id` filters; adopted texts take `year` and `term`, `committee` takes `term`, `plenary` takes `year`. `work_type` codes are family-specific
- `mode: "get"` takes a `document_id` from any tool (procedures, speeches, votes, questions, answers) and rejects search filters and paging
- Detail returns metadata, procedure and `parent_document_ids` references, published `adopted_document_ids` and `based_on_document_ids`, optional `public_register_ref`, and every source-file link in the selected language; bodies are linked, not extracted. A published relation does not guarantee its target is available upstream
- Adopted texts, plenary documents (reports, motions) and committee documents publish their procedure only on their family record, so their get makes one extra request for `procedure_ids`. If that read fails, the rest of the record is returned with a notice that `procedure_ids` may be incomplete

---

### `euparl_search_speeches` <sub>tool</sub>

- Search by `text`, `title`, `person_id`, `activity_type`, or sitting-date range; optional `term` selects 9 or 10, defaulting to 10. Term-9 records start in July 2021
- `mode: "get"` requires `speech_id` and rejects search filters and nondefault paging
- Returns activity metadata and participants, not transcripts. Follow `document_ids` through document get and any parent references to source files

---

### `euparl_search_meps` <sub>tool</sub>

- Omitting `term` and `mandate_date` selects members in office today; `term` selects a published roster from terms 0–10; `mandate_date` (`YYYY-MM-DD`, not after today, exclusive with `term`) selects members seated on that date. Optional country, political-group, and gender codes come from `mep_filters`
- On a `mandate_date` roster, country and group are matched and returned as published on that date, so `political_group` matches only the code in force then; for earlier groups omit it and read each member's published group. A term's first sitting day can return an incomplete roster or an upstream error; use the following day
- Equivalent query spellings include `EPP`, `Greens/EFA`, `GUE/NGL`, `Patriots`, and country `UK` → `GB`, the code Parliament publishes for United Kingdom members on historical rosters; published historical group identities remain intact
- `name_contains` matches every normalized token across the complete roster before paging, ignoring case, diacritics, and punctuation; a value with no letter or digit is rejected
- Results use snapshot continuation. Country/group describe the selected roster context, never inferred for another date

---

### `euparl_get_mep` <sub>tool</sub>

- `mep_id` accepts a decimal person ID, `person/` prefix, or exact public person URI
- Default `section: "overview"` returns identity and `membership_count`; `section: "memberships"` pages published history with snapshots
- Missing membership end dates do not establish current membership
- Resolve membership organization IDs, decimal or term codes such as `org/ep-9`, through `euparl_list_reference` with `topic: "organizations"`

---

### `euparl_get_plenary_votes` <sub>tool</sub>

- `mode: "sittings"` takes `year` (sittings data starts in 2014; earlier years return no sittings); default `decisions` takes `sitting_id` (a `YYYY-MM-DD` date or `MTG-PL-` ID) and pages summaries with labels, tallies, distinct decided-on, recording and part-of document IDs, and vote item IDs. Decisions start in 2019: 2014–2018 sittings list but return no decisions, and not every later sitting has them. Optional `document_id` filters any document relation by exact ID or hyphen-boundary descendant before paging; optional `vote_item_id` (a procedure's `PLENARY_VOTE_RESULTS` event) selects every decision of one vote item, the route to a report's final vote. A procedure event's vote date can select the sitting. Older sittings publish no vote items or report relations on decisions; there, the report citation appears only in decision labels
- `decision` adds `decision_id` and returns one rich record with commentary (an ID absent from the sitting fails `decision_not_found`). Optional `mep_id` returns separate recorded/intended positions and publication availability without a roster lookup; an empty match does not prove absence from the vote
- `mode: "voters"` adds `position`: `favor`, `against`, `abstention`, or the `intended_*` corrections, which never replace recorded votes. `available: false` means the array was not published; a published empty array has `available: true`
- `resolve_names: true` requires `roster_term` (0–10) and joins names from that term's roster only; unresolved IDs stay in the output

---

### `euparl_list_questions` <sub>tool</sub>

- Default `mode: "list"` accepts `year` and `work_type`; no keyword, author, or addressee search
- `mode: "get"` requires `question_id`: a canonical work ID, known document prefix/public URI, or human citation such as `E-000001/2025` (also P, O, and the G/K interpellation prefixes). Optional `term` resolves a citation directly; omission checks the corresponding mandate, including both candidates in election years, and requires one exact match
- Get rejects list filters and nondefault paging. Detail returns metadata, source files, and published answer references; empty `answers` does not prove the question is unanswered

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

European Parliament-specific:

- Keyless access to Parliament's public JSON-LD records, with canonical identifiers linking discovery, detail, and source evidence
- Shared request pacing, bounded retries, and one 40-second deadline per call covering every upstream request and queue wait
- Shared paging on every list tool: `offset`, `limit` (default 20), and `language` (default `en`, any of the 24 EU languages). Rosters, procedure sections, memberships, decisions, and voters are acquired whole, then paged locally with a `page.snapshot` that continuation must pass back; `snapshot_changed` means restart at offset 0. Procedure listings with `process_type` are acquired whole too, and passing their snapshot back is optional
- Each collection has its own page cap, sized from measured row bytes so a full page and its continuation fit inside the 100,000 characters Claude Code keeps of a tool result. Decision rows vary too widely for any count to bound, so a decisions page also ends at whole decisions before their rows render past 92,000 characters, with a notice, and continues from `page.next_offset`. A larger `limit` returns the cap with a notice (`EUPARL_CLAMP_LIMITS=false` rejects a `limit` above the tool's largest cap instead):

  | Collection | Cap |
  |:---|---:|
  | Procedures, questions, MEP roster | 300 |
  | Documents (all three sources), MEP memberships | 225 |
  | Procedure events, participants, documents | 125 |
  | Sittings, decisions | 100 |
  | Speeches | 80 |
  | Voters in one position | 1,000 |
  | Committees, political groups, static reference topics | 350 |
  | Organization lookups (one paced request each) | 20 |

- Speech and adopted-text searches, and procedure listings without `process_type`, expose a 10,000-result window. A page reaching past it narrows to the results left, with a notice; an offset of 10,000 or more is rejected. Narrow supported filters when the window ends; a capped upstream total is disclosed as a lower bound, and `has_more` can remain true without a reachable `next_offset`

Agent-friendly output:

- Provenance on every response: source URLs, the actual language of each text (fallback disclosed, never translated), normalized filter echo, and continuation guidance
- Missing data stays distinguishable: detail misses return `found: false`, empty lists succeed with guidance, and published zeros, unpublished arrays, and historical affiliations are never conflated
- Typed error reasons with recovery hints, and the same data on `content[]` and `structuredContent`

Data source: [European Parliament Open Data](https://data.europarl.europa.eu/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This server normalizes identifiers and record structure.

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http eu-parliament-mcp-server https://eu-parliament.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add eu-parliament-mcp-server -- npx -y @cyanheads/eu-parliament-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "eu-parliament-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/eu-parliament-mcp-server"]
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP listen host. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `EUPARL_CLAMP_LIMITS` | Clamp a `limit` above its collection's page cap with a notice; `false` rejects a `limit` above the tool's largest cap (smaller mode caps still clamp). | `true` |

No variables are required; `EUPARL_CLAMP_LIMITS` is the one optional server-specific variable. See [`.env.example`](./.env.example) for common framework overrides.

## Running the server

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). No API key or upstream account is required.

```sh
git clone https://github.com/cyanheads/eu-parliament-mcp-server.git
cd eu-parliament-mcp-server && bun install
cp .env.example .env
```

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/eu-parliament-mcp-server:latest
```

The image defaults to HTTP transport, stateless sessions, and logs to `/var/log/eu-parliament-mcp-server`. For stdio clients, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/eu-parliament-mcp-server:latest"]`. Build locally with `docker build -t eu-parliament-mcp-server .`; OpenTelemetry peers install by default, or use `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Nine read-only tool definitions (`*.tool.ts`). |
| `src/mcp-server/tools/utils` | Shared schemas, lossless rendering, and enrichment. |
| `src/config` | Server environment: the `limit` clamp switch. |
| `src/services/eu-parliament` | JSON-LD client, edge schemas, reference codes, normalization, and domain workflows. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `docs/` | Design contracts and generated project tree. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
