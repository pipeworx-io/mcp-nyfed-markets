# @pipeworx/nyfed-markets

The New York Fed's Markets Data APIs — operation-level repo/reverse repo (ON RRP) auction results, securities lending operations, SOMA portfolio holdings, the Desk's reference rates (SOFR, EFFR, OBFR, TGCR, BGCR), and primary dealer survey statistics. This is the operation- and security-level data underneath FRED's daily rate aggregates, not a duplicate of them.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `nyfed_repo_operations(operation_type, start_date, end_date, term, limit)` — repo/reverse repo (ON RRP) auction results: totals, counterparty counts, award rates, by-security-type breakdown.
- `nyfed_seclending_operations(operation, start_date, end_date, cusips, limit)` — securities lending operation results (daily program + extended-term).
- `nyfed_soma_holdings(view, holding_type, as_of_date, cusip, limit)` — SOMA portfolio: summary by asset bucket over time, or full CUSIP-level Treasury/Agency snapshots by date, or one CUSIP's full holdings history.
- `nyfed_reference_rates(rate_type, number)` — SOFR/SOFRAI/TGCR/BGCR (secured) and EFFR/OBFR (unsecured), latest or recent history with percentile bands and volume.
- `nyfed_primary_dealer_stats(mode, keyid_filter, seriesbreak, limit)` — FR 2004 weekly primary dealer positioning/transaction survey; `mode=list_series` browses the keyid catalog, `mode=latest` returns current values.

## Auth

Keyless. No registration, no API key, no rate-limit headers observed.

## Data sources

- `https://markets.newyorkfed.org/api/rp/...` — repo/reverse repo operations.
- `https://markets.newyorkfed.org/api/seclending/...` — securities lending operations.
- `https://markets.newyorkfed.org/api/soma/...` — SOMA holdings (summary, Treasury, Agency).
- `https://markets.newyorkfed.org/api/rates/...` — reference rates.
- `https://markets.newyorkfed.org/api/pd/...` — primary dealer statistics.
- Swagger spec: `https://markets.newyorkfed.org/static/docs/markets-api.yml` (the `.html` doc page is a JS SPA that renders this file — fetch the `.yml` directly, the `.html` is useless to scrape).

### Traps

- **`/api/rp/results/search.json`'s `operationTypes` query parameter is a confirmed SILENT NO-OP.** Querying with `operationTypes=Reverse Repo` still returns `Repo` rows mixed in (verified live: 21 rows for a 9-day window that should have been ~7 RRP-only rows). `method` and `term` on that endpoint are unverified and not trusted either. This pack always filters `operationType`/`term` client-side after fetching. The path-based filter on the `latest` endpoint (`/api/rp/{reverserepo|repo|all}/all/results/latest.json`) DOES work correctly and is used for same-day queries instead.
- **SOMA holdings publish on a ~1 week lag.** `/api/soma/asofdates/latest.json` returned `2026-09-16` when probed on `2026-09-23` — normal, not a bug. `as_of_date` defaults to this latest published date.
- **The agency holding-type path segment `agency debts` contains a literal space** (`/api/soma/agency/get/agency debts/asof/{date}.json`). The tool accepts the friendly `agency_debts` and URL-encodes the space for you.
- **`holding_type=all` on the treasury/agency SOMA endpoints returns EVERY CUSIP at that date** — hundreds of rows. This pack truncates to `limit` (default 20) and always reports `total_holdings` so the truncation is visible rather than silent.
- **Primary dealer keyids are opaque codes** (e.g. `PDPOSMBS-TOT`) grouped into "series break" windows whose definitions can change over time (`/api/pd/list/seriesbreaks.json` is authoritative). This pack resolves "current" as the window whose `enddate` is `9999-12-31` rather than hardcoding a window id, so it keeps working across the next series break without a code change.
- **Reference rates for a given `effectiveDate` are published the NEXT business day** — EFFR/OBFR/TGCR/BGCR "today" have not been observed yet; only SOFR/SOFRAI sometimes show same-day. Not a lag bug.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nyfed-markets": {
      "url": "https://gateway.pipeworx.io/nyfed-markets/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nyfed-markets/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nyfed_repo_operations \
  -H 'Content-Type: application/json' \
  -d '{"operation_type":"reverserepo"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nyfed_repo_operations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nyfed-markets": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nyfed-markets"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nyfed-markets
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nyfed Markets data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
