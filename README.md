# Pesties.au MCP Server

Model Context Protocol server for [Pesties.au](https://pesties.au), a pest control business serving the Gold Coast, Logan, and South Brisbane in Queensland, Australia.

Live endpoint: **`https://mcp.pesties.au`**

The first Australian home services MCP. Lets AI agents browse bookable pest treatments, generate real quotes with property-size-adjusted pricing, check service area coverage by suburb or postcode, and submit real bookings that flow into the Pesties booking system.

## Tools exposed

The server exposes 7 MCP tools:

| Tool | What it does |
|---|---|
| `list_bookable_services` | Full catalog of pest treatments with pricing tiers, coverage, and warranty terms. |
| `get_quote` | Returns a signed quote token for a specific treatment. Property type, storeys, and block size drive the price. |
| `list_service_areas` | Every suburb Pesties services, grouped by region (Gold Coast, Logan, South Brisbane). |
| `check_service_area` | Confirms whether a suburb or 4-digit postcode is serviced. Handles common aliases (Mt/Mount, St/Saint, etc.). |
| `get_warranty_terms` | The PestiesProtect+ warranty terms in full (6 months on Annual Guardian, 12 months on 360° Ultimate). |
| `check_pest_treatment` | Given a pest species, returns the recommended treatment package. Flags protected species (possums, bees) with do-not-bait guidance. |
| `submit_booking` | Two-phase commit: first call returns a preview with a confirmation token, second call with the token submits the real booking. |

## Design decisions

A few things worth calling out for anyone building a similar service-business MCP.

**Signed quote tokens (HMAC-SHA256).** `get_quote` returns a `quote_token` that encodes the exact treatment, property parameters, and price. `submit_booking` requires this token and treats its contents as authoritative. Structurally impossible for an agent to hallucinate a lower price on the booking submission.

**Two-phase submit.** `submit_booking` returns `status: "preview"` on the first call with a full summary and a `confirmation_token`. The second call with the token books for real. The customer sees the exact email address, service address, and total in the preview before it commits.

**Idempotency.** Booking submissions are deduped on a hash of email + treatment + date + total via Cloudflare KV, 24-hour TTL. Retrying the same booking within the window returns the same result, never duplicates.

**Protected species handling.** `check_pest_treatment` for possums, bees, and other protected native species returns `do_not_bait: true` with alternative guidance. Agents get told at the tool-call layer, before they generate a customer response.

**Suburb alias normalisation.** `check_service_area` handles Mt/Mount, St/Saint, Nth/North, and trailing "QLD" / postcode suffixes. Reduces false negatives from name variants.

**Postcode lookup.** A 4-digit query to `check_service_area` returns matching serviced suburbs. Useful when the agent has a customer's address but not their suburb.

**Protocol hygiene.** `initialize` negotiates `protocolVersion` from client params. `tools/call` errors return `isError: true` per the MCP spec so clients can distinguish tool errors from transport errors.

## Using the hosted endpoint

Point any MCP client at `https://mcp.pesties.au`. No authentication required, no API key.

Quick verification:

```bash
curl -s https://mcp.pesties.au/ | python3 -m json.tool
```

That hits the health endpoint and returns server metadata.

For a full MCP `initialize` handshake:

```bash
curl -s -X POST https://mcp.pesties.au/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | python3 -m json.tool
```

### Claude Desktop config

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pesties": {
      "url": "https://mcp.pesties.au"
    }
  }
}
```

## Running locally

Requires Node.js 20+, npm, and a Cloudflare account (only for real deploy, not for local dev).

```bash
git clone https://github.com/JovianNights/pesties-mcp.git
cd pesties-mcp
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars and fill in real secret values for HMAC_SECRET and WP_SHARED_SECRET
npx wrangler dev
```

The dev server runs at `http://127.0.0.1:8787`. `initialize` works without secrets set; `get_quote` and `submit_booking` will error with a clear message if `HMAC_SECRET` is missing.

### Docker

A `Dockerfile` is included so the server can be built and started in a sandbox (used by Glama.ai's registry check):

```bash
docker build -t pesties-mcp .
docker run -p 8787:8787 pesties-mcp
```

The container starts `wrangler dev` with dummy env vars. `initialize` responds correctly; tools that require secrets return their error path (which is what you want to verify in a sandbox).

## Deploying

Requires a Cloudflare Workers account and a KV namespace bound as `BOOKINGS_KV`.

```bash
npx wrangler kv:namespace create BOOKINGS_KV
# copy the id into wrangler.toml
npx wrangler secret put HMAC_SECRET
npx wrangler secret put WP_SHARED_SECRET
npx wrangler deploy
```

`HMAC_SECRET` should be a random 32+ byte string (`openssl rand -base64 32`). `WP_SHARED_SECRET` must match the `X-Pesties-MCP-Secret` header check on the WordPress admin-ajax `pesties_booking` handler.

## License

MIT. See [LICENSE](./LICENSE).

## Contact

- Business: [pesties.au](https://pesties.au) · 0494 151 789
- MCP endpoint: `https://mcp.pesties.au`
- Issues: open a GitHub issue on this repo
