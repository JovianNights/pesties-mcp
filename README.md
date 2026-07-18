# Pesties.au MCP Server

Model Context Protocol server for [Pesties.au](https://pesties.au), a pest control business serving the Gold Coast, Logan, and South Brisbane in Queensland, Australia.

Live endpoint: **`https://mcp.pesties.au`**

The first Australian home services MCP. Lets AI agents browse bookable pest treatments, generate real quotes with property-size-adjusted pricing, check service area coverage by suburb or postcode, and submit real bookings that flow into the Pesties booking system.

## Features

- **7 MCP tools** covering the full booking flow: services, quotes, service areas, warranty terms, pest treatment recommendations, and two-phase booking submit.
- **Signed quote tokens (HMAC-SHA256)**: quotes carry the price, treatment, and property parameters in a signed token. Bookings verify the token, making price manipulation structurally impossible.
- **Two-phase booking commit**: first submit returns a preview with the exact email, service address, and total. Second submit with the confirmation token books for real. Prevents wrong-detail bookings from AI agents.
- **Idempotency via Cloudflare KV**: retries within a 24-hour window return the same result, never duplicates.
- **Protected species handling**: possums, bees, and other protected native species trigger a `do_not_bait: true` flag with alternative guidance, returned at the tool-call layer before the agent generates a customer response.
- **Suburb alias normalisation**: handles Mt/Mount, St/Saint, Nth/North, and trailing "QLD"/postcode suffixes. Reduces false negatives from name variants.
- **Postcode lookup**: 4-digit query to `check_service_area` returns all matching serviced suburbs.
- **Protocol hygiene**: negotiates `protocolVersion` from client capabilities on initialize, returns tool-call errors per MCP spec with `isError: true` so clients can distinguish tool errors from transport errors.

## Use Cases

- **AI agents booking pest control on behalf of a customer**. A Claude or GPT agent handles the whole flow: identify the pest, verify the suburb is serviced, quote the price, and book the appointment.
- **Home services aggregators**. A booking aggregator app can list Pesties services alongside plumbing, electrical, HVAC, and cleaning options in a single agent interface.
- **Property manager workflows**. A strata or Airbnb host agent can quote and book routine pest treatments for multiple properties without picking up the phone.
- **Voice assistants**. Connecting a Vapi, ElevenLabs, or Retell voice agent to the MCP endpoint enables phone-booking flows for customers who prefer voice over chat.
- **Reference implementation**. A working example of production MCP patterns: signed tokens, two-phase commit, idempotency, protected species handling, and Cloudflare Workers deployment.

## Tools

The server exposes 7 MCP tools:

| Tool | What it does |
|---|---|
| `list_bookable_services` | Full catalog of pest treatments with pricing tiers, coverage, and warranty terms. |
| `get_quote` | Returns a signed quote token for a specific treatment. Property type, storeys, and block size drive the price. |
| `list_service_areas` | Every suburb Pesties services, grouped by region (Gold Coast, Logan, South Brisbane). |
| `check_service_area` | Confirms whether a suburb or 4-digit postcode is serviced. Handles common aliases. |
| `get_warranty_terms` | The PestiesProtect+ warranty terms in full: 6 months on Annual Guardian, 12 months on 360° Ultimate. |
| `check_pest_treatment` | Given a pest species, returns the recommended treatment package. Flags protected species with do-not-bait guidance. |
| `submit_booking` | Two-phase commit: first call returns a preview with a confirmation token, second call with the token submits the real booking. |

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

Requires Node.js 20+, npm, and a Cloudflare account (only for a real deploy, not for local dev).

```bash
git clone https://github.com/JovianNights/pesties-mcp.git
cd pesties-mcp
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars and fill in real secret values for HMAC_SECRET and WP_SHARED_SECRET
npx wrangler dev
```

The dev server runs at `http://127.0.0.1:8787`. `initialize` works without secrets set. `get_quote` and `submit_booking` will error with a clear message if `HMAC_SECRET` is missing.

### Docker

A `Dockerfile` is included so the server can be built and started in a sandbox (used by Glama.ai's registry check):

```bash
docker build -t pesties-mcp .
docker run -p 8787:8787 pesties-mcp
```

The container starts `wrangler dev` with dummy env vars. `initialize` responds correctly. Tools that require real secrets return their clear error path, which is what a sandbox check should verify.

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

## FAQ

### Do I need an API key to use this?

No. The hosted endpoint at `https://mcp.pesties.au` is open. Anyone can connect, browse services, and get quotes. Bookings go through a two-phase commit so customers see the full details before anything is committed.

### Can I self-host this MCP?

Yes. The source is MIT-licensed. Clone the repo, install Wrangler, and deploy to your own Cloudflare Workers account. You will need your own `HMAC_SECRET`, `WP_SHARED_SECRET`, and a KV namespace. See "Deploying" above.

### How do I connect from Claude Desktop?

Add the `pesties` server to your `claude_desktop_config.json` pointing at `https://mcp.pesties.au`. See the "Claude Desktop config" section above. No auth required.

### What areas does Pesties service?

Gold Coast, Logan, and South Brisbane in Queensland, Australia. Use `check_service_area` to verify a specific suburb, or `list_service_areas` for the full list.

### Are prices real?

Yes. `get_quote` returns a signed quote token that encodes the exact treatment, property parameters, and price. `submit_booking` requires the token and treats its contents as authoritative. The price shown in the quote is the price the customer pays.

### What happens with protected species (possums, bees)?

`check_pest_treatment` returns `do_not_bait: true` for protected species with alternative guidance. Pesties will not sell rodent-style baiting for a possum problem in Queensland. Agents should offer relocation contacts for possums and beekeeper referrals for bees.

### How is this different from other pest control booking APIs?

Two things. First, this is an MCP server, not a REST API, so any MCP-compatible AI agent can use it out of the box. Second, the signed quote token plus two-phase commit pattern means the pricing and booking flow is safe against agent hallucination and prompt injection.

### How can I contribute or report bugs?

Open a GitHub issue on this repo. For urgent business enquiries, contact Pesties directly (see Contact below).

## License

MIT. See [LICENSE](./LICENSE).

## Contact

- Business: [pesties.au](https://pesties.au) · 0494 151 789
- MCP endpoint: `https://mcp.pesties.au`
- Bug reports: open a GitHub issue on this repo
