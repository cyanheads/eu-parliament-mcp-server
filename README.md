<div align="center">
  <h1>@cyanheads/eu-parliament-mcp-server</h1>
  <p><b>Track European Parliament procedures, MEPs, votes, documents, speeches, and questions via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eu-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eu-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eu-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `euparl_search_meps` | Find MEPs across a complete current or selected-term roster |
| `euparl_get_mep` | Read member identity and published membership history |
| `euparl_get_plenary_votes` | Discover sittings, inspect decisions, and page recorded or intended voters |
| `euparl_list_questions` | List questions by year/type or retrieve a question and answer references |

## Capability reference

### `euparl_list_reference` <sub>tool</sub>

- Required `topic`: `committees`, `political_groups`, `organizations`, `procedure_types`, `document_types`, `question_types`, `activity_types`, `mep_filters`, `identifiers`, or `coverage`
- `committees` and `political_groups` page Parliament's corporate-body records, historical bodies included; their organization IDs are not filter codes. Published full names and dates are included when available
- `organizations` requires `organization_ids`: decimal IDs, `org/` prefixes, or exact public organization URIs. Results retain input order and duplicates with per-item `found`; repeat the same IDs with `page.next_offset` for continuation. At most 20 IDs are looked up per call; reference pages need no snapshot

---

### `euparl_list_procedures` <sub>tool</sub>

- Optional `process_type` from `euparl_list_reference`; no keyword, year, committee, or stage filter
- Sparse rows carry `procedure_id`, source URL, and available reference/type; retrieve titles, stages, and participants with `euparl_get_procedure`

---

### `euparl_get_procedure` <sub>tool</sub>

- Required `procedure_id` accepts `YYYY-NNNN`, `YYYY/NNNN(TYPE)`, an optional letter suffix, the known path prefix, or the exact public procedure URI
- `section: "overview"` returns scalar metadata and collection counts; `events`, `participants`, and `documents` page one collection using snapshots
- Historical participant groups stay historical. Follow document IDs with `euparl_search_documents` in get mode

---

### `euparl_search_documents` <sub>tool</sub>

- `mode: "search"` defaults to `source: "adopted_texts"`, the only family with `text`, `title`, sitting-date, and `related_process_id` filters; adopted texts take `year` and `term`, `committee` takes `term`, `plenary` takes `year`. `work_type` codes are family-specific
- `mode: "get"` takes a `document_id` from any tool (procedures, speeches, votes, questions, answers) and rejects search filters and paging
- Detail returns metadata, procedure and `parent_document_ids` references, published `adopted_document_ids` and `based_on_document_ids`, optional `public_register_ref`, and every source-file link in the selected language; bodies are linked, not extracted. A published relation does not guarantee its target is available upstream

---

### `euparl_search_speeches` <sub>tool</sub>

- Search by `text`, `title`, `person_id`, `activity_type`, or sitting-date range; optional `term` selects 9 or 10, defaulting to 10
- `mode: "get"` requires `speech_id` and rejects search filters and nondefault paging
- Returns activity metadata and participants, not transcripts. Follow `document_ids` through document get and any parent references to source files

---

### `euparl_search_meps` <sub>tool</sub>

- Omitted `term` selects members in office today; explicit `term` selects a published roster from terms 0–10. Optional country, political-group, and gender codes come from `mep_filters`
- Equivalent query spellings include `EPP`, `Greens/EFA`, `GUE/NGL`, `Patriots`, and historical country `GB` → `UK`; published historical group identities remain intact
- `name_contains` matches every normalized token across the complete roster before paging, ignoring case, diacritics, and punctuation
- Results use snapshot continuation. Country/group describe the selected roster context, not voting-date affiliation

---

### `euparl_get_mep` <sub>tool</sub>

- `mep_id` accepts a decimal person ID, `person/` prefix, or exact public person URI
- Default `section: "overview"` returns identity and `membership_count`; `section: "memberships"` pages published history with snapshots
- Missing membership end dates do not establish current membership
- Resolve supported membership organization IDs through `euparl_list_reference` with `topic: "organizations"`

---

### `euparl_get_plenary_votes` <sub>tool</sub>

- `mode: "sittings"` takes `year`; default `decisions` takes `sitting_id` (a `YYYY-MM-DD` date or `MTG-PL-` ID) and pages summaries with labels, tallies, and distinct decided-on/recording document IDs. Optional `document_id` filters either relation by exact ID or hyphen-boundary descendant before paging; a procedure event's vote date can select the sitting
- `decision` adds `decision_id` and returns one rich record with commentary (an ID absent from the sitting fails `decision_not_found`). Optional `mep_id` returns separate recorded/intended positions and publication availability without a roster lookup; an empty match does not prove absence from the vote
- `mode: "voters"` adds `position`: `favor`, `against`, `abstention`, or the `intended_*` corrections, which never replace recorded votes. `available: false` means the array was not published; a published empty array has `available: true`
- `resolve_names: true` requires `roster_term` (0–10) and joins names from that term's roster only; unresolved IDs stay in the output

---

### `euparl_list_questions` <sub>tool</sub>

- Default `mode: "list"` accepts `year` and `work_type`; no keyword, author, or addressee search
- `mode: "get"` requires `question_id`: a canonical work ID, known document prefix/public URI, or human citation such as `E-000001/2025` (also P/O prefixes). Optional `term` resolves a citation directly; omission checks the corresponding mandate, including both candidates in election years, and requires one exact match
- Get rejects list filters and nondefault paging. Detail returns metadata, source files, and published answer references; empty `answers` does not prove the question is unanswered

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

European Parliament-specific:

- Keyless access to Parliament's public JSON-LD records, with canonical identifiers linking discovery, detail, and source evidence
- Shared request pacing, bounded retries, and one 40-second deadline per call covering every upstream request and queue wait
- Shared paging on every list tool: `offset`, `limit` (default 20, effective maximum 100; larger requests up to 1000 are normalized with a notice), and `language` (default `en`, any of the 24 EU languages). Rosters, procedure sections, memberships, decisions, and voters are acquired whole, then paged locally with a `page.snapshot` that continuation must pass back; `snapshot_changed` means restart at offset 0
- Procedure, speech, and adopted-text searches expose a 10,000-result window. Narrow supported filters when the window ends; a capped upstream total is disclosed as a lower bound, and `has_more` can remain true without a reachable `next_offset`

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

No server-specific environment variables are required. See [`.env.example`](./.env.example) for common framework overrides.

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
