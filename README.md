<div align="center">
  <h1>@cyanheads/eu-parliament-mcp-server</h1>
  <p><b>Track European Parliament procedures, MEPs, votes, documents, speeches, and questions via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eu-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eu-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eu-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eu-parliament-mcp-server/releases/latest/download/eu-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eu-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXUtcGFybGlhbWVudC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eu-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feu-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

European Parliament records from the [Open Data API](https://data.europarl.europa.eu/): discover legislative procedures, follow their evidence, find MEPs, inspect plenary decisions and voters, and retrieve document, speech, and question metadata. Runs as a stdio process or a local Streamable HTTP server. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `euparl_list_reference` | Discover filter codes, identifier formats, coverage, committees, and political groups |
| `euparl_list_procedures` | List procedure references by type |
| `euparl_get_procedure` | Read procedure identity, stage, events, participants, and document references |
| `euparl_search_documents` | Search adopted texts, list committee/plenary documents, or retrieve any canonical document |
| `euparl_search_speeches` | Search tenth-term speech activities and retrieve metadata and recording-document links |
| `euparl_search_meps` | Find MEPs across a complete current or selected-term roster |
| `euparl_get_mep` | Read member identity and published membership history |
| `euparl_get_plenary_votes` | Discover sittings, inspect decisions, and page recorded or intended voters |
| `euparl_list_questions` | List questions by year/type or retrieve a question and answer references |

## Capability reference

All list tools accept `offset` (default 0), `limit` (default 20, accepted 1–1000, effective maximum 100 with notice), and `language` (default `en`, one of the 24 EU language codes). Follow `page.next_offset`; for local collections, also pass the returned `page.snapshot`. A `snapshot_changed` error requires restarting at offset 0 without a snapshot. Local snapshots detect changes on a fresh lookup; they do not retain historical data.

Localized text includes its actual source language; fallback is disclosed and text is never translated. Missing detail normally returns `found: false`; empty lists succeed with guidance. Rich decision lookup uses `decision_not_found` instead.

### `euparl_list_reference` <sub>tool</sub>

- Required `topic`: `committees`, `political_groups`, `procedure_types`, `document_types`, `question_types`, `activity_types`, `mep_filters`, `identifiers`, or `coverage`
- Committees and political groups are live corporate bodies; organization identifiers do not imply accepted filter codes. Reference pages need no snapshot

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

- `mode: "search"` defaults to `source: "adopted_texts"`; only that family accepts `text`, `title`, sitting dates, and `related_process_id`. Adopted texts accept year and term; committee accepts term, plenary accepts year
- `work_type` uses family-specific codes from `euparl_list_reference`. Committee/plenary discovery has no keyword filter
- `mode: "get"` requires `document_id` and rejects source, search filters, and nondefault paging. IDs from procedures, speeches, votes, questions, and answers all use this same lookup
- Detail includes metadata, procedure/parent references, and every source-file link in the selected language. Follow `parent_document_ids` when a subdivision lacks files; document bodies are not downloaded or extracted

---

### `euparl_search_speeches` <sub>tool</sub>

- Search by `text`, `title`, `person_id`, `activity_type`, or sitting-date range; coverage is limited to parliamentary term 10
- `mode: "get"` requires `speech_id` and rejects search filters and nondefault paging
- Returns activity metadata and participants, not transcripts. Follow `document_ids` through document get and any parent references to source files

---

### `euparl_search_meps` <sub>tool</sub>

- Omitted `term` selects members in office today; explicit `term` selects a published roster from terms 0–10. Optional country, political-group, and gender codes come from `mep_filters`
- `name_contains` matches every normalized token across the complete roster before paging, ignoring case, diacritics, and punctuation
- Results use snapshot continuation. Country/group describe the selected roster context, not voting-date affiliation

---

### `euparl_get_mep` <sub>tool</sub>

- `mep_id` accepts a decimal person ID, `person/` prefix, or exact public person URI
- Default `section: "overview"` returns identity and `membership_count`; `section: "memberships"` pages published history with snapshots
- Missing membership end dates do not establish current membership

---

### `euparl_get_plenary_votes` <sub>tool</sub>

- `mode: "sittings"` requires `year`; default `decisions` requires `sitting_id` and pages compact summaries. Sitting IDs accept a real `YYYY-MM-DD` date, `MTG-PL-` form, known event prefix, or public URI
- `mode: "decision"` requires sitting and decision IDs and returns one rich record with whole labels, commentary, and document references; it rejects paging and snapshots
- `mode: "voters"` also requires `position`: `favor`, `against`, `abstention`, `intended_favor`, `intended_against`, or `intended_abstention`. Decisions and voter positions page independently with snapshots
- `resolve_names: true` is voters-only and requires `roster_term` (0–10); unresolved IDs remain in output. Names come from that published term roster, with no voting-date affiliations
- Published tallies remain separate from voter-array counts. `available: false` means an array was absent; published empty arrays have `available: true`. Intended corrections never replace recorded votes

---

### `euparl_list_questions` <sub>tool</sub>

- Default `mode: "list"` accepts `year` and `work_type`; no keyword, author, or addressee search
- `mode: "get"` requires `question_id`: a canonical work ID, known document prefix/public URI, or human citation such as `E-000001/2025` (also P/O prefixes). Optional `term` resolves a citation directly; omission searches the full citation year and requires one exact match
- Get rejects list filters and nondefault paging. Detail returns metadata, source files, and published answer references; empty `answers` does not prove the question is unanswered

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

European Parliament-specific:

- Keyless access to Parliament's public JSON-LD records, with canonical identifiers linking discovery, detail, and source evidence
- Shared request pacing, bounded retries, and one 40-second operation deadline covering acquisition and queue waits
- Complete-roster name filtering and separate paging for procedure evidence, membership history, decision summaries, and voters

Agent-friendly output:

- Source URLs, actual language labels, normalized filters, exact totals when available, and continuation guidance
- Missing fields retain their uncertainty; published zero values, absent arrays, and historical affiliations remain distinct
- Matching data on `content[]` and `structuredContent`, with usable source links and typed error reasons

Data source: [European Parliament Open Data](https://data.europarl.europa.eu/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This server normalizes identifiers and record structure. Parliament records do not establish enacted-law completeness or a member's lifetime voting history.

## Getting started

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "eu-parliament-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/eu-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "eu-parliament-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/eu-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "eu-parliament-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/eu-parliament-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or upstream account is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/eu-parliament-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd eu-parliament-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override framework settings as needed
```

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
