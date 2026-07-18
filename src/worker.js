/**
 * Pesties.au MCP Server v3.2
 * Deploy: mcp.pesties.au (Cloudflare Worker)
 *
 * v3.2 changes (add-on picker + soft warnings for missing prefs):
 * - Every add-on now carries a summary field explaining what it does.
 *   Picker labels can be "Rodent Guard (+$120) — heavy-duty rat/mouse baiting"
 *   instead of just "Rodent Guard (+$120)".
 * - presentation_instructions explicitly tells agent to combine name+price+summary
 *   for add-on picker labels.
 * - Preview response includes soft warnings when contact_method or time_preference
 *   weren't explicitly set. Non-blocking — surfaces the gap so the team catches
 *   it on the confirmation call.
 *
 * v3.1 changes (branding fix from live testing):
 * - Added display.short_label and display.one_line to every treatment. Agent picker labels
 *   now include price-from, key coverage, and warranty length — no more meaningless
 *   internal marketing names like "Annual Guardian Pest Treatment" alone.
 * - list_bookable_services now returns presentation_instructions telling the agent explicitly
 *   to use display.short_label for pickers and display.one_line for follow-up explanation.
 * - check_pest_treatment includes display in each recommended package.
 *
 * v3.0 changes (external design review by Fable — structure over attestation):
 * - Signed quote tokens (HMAC-SHA256): get_quote returns quote_token, submit_booking requires it.
 *   Booking params encoded in the token are authoritative. Structurally guarantees price match.
 * - Two-phase submit_booking: first call returns status:"preview" with full summary +
 *   confirmation_token; second call with token books. Wrong email surfaces in the summary
 *   the customer reviews, so no email-assumption rule needs to be exposed to the customer.
 * - Removed email_explicitly_confirmed and addons_offered booleans (unverifiable, awkward).
 * - Replaced with addon_decisions: {addon_key: "accepted"|"declined"|"not_discussed"} —
 *   data-shaped, warning-based. not_discussed items produce warnings + admin note flags.
 * - Optional email_source enum ("stated_by_customer"|"inferred") — never rejected, just flagged.
 * - Killed silent price defaults: get_quote now REQUIRES property_type/storeys/block_size
 *   for treatments with property_prices. No more confident $249 with no property specified.
 * - Idempotency: submit_booking dedupes on hash(email + treatment + date + total) via KV, 24h TTL.
 * - Suburb alias normalisation: Mt/Mount, St/Saint, Nth/North, trailing "QLD"/postcodes.
 *   Fixes "Mount Gravatt" returning serviced:false.
 * - Postcode lookup: 4-digit query to check_service_area returns matching serviced suburbs.
 * - Added possum, flies, ticks, bees to PEST_MAPPING. Possums are protected in QLD —
 *   agents will no longer sell rodent baiting for a possum.
 * - Abuse protection: shared secret header on POST to WP; per-email daily commit cap + global
 *   daily cap via KV. Requires matching WP-side change (see WP_SHARED_SECRET below).
 * - get_quote success response includes contextual before_booking add-on nudges.
 * - Protocol hygiene: negotiate protocolVersion from initialize params; tools/call errors
 *   returned with isError:true per MCP spec.
 *
 * REQUIRED ENVIRONMENT (Cloudflare Worker → Settings → Variables and Secrets):
 *   HMAC_SECRET       — random 32+ byte string. Signs quote_token and confirmation_token.
 *   WP_SHARED_SECRET  — random string. Sent as X-Pesties-MCP-Secret header to WP endpoint.
 *                       Requires matching check in the WP admin-ajax action handler
 *                       (pesties_booking) — reject requests missing or mismatching this.
 *
 * REQUIRED KV BINDING (Cloudflare Worker → Settings → Bindings):
 *   BOOKINGS_KV — a Workers KV namespace. Stores idempotency keys and per-email/global
 *                 rate-limit counters. Create the namespace in dashboard, bind as BOOKINGS_KV.
 *
 * If HMAC_SECRET is missing, get_quote/submit_booking will error clearly rather than issue
 * meaningless tokens. If BOOKINGS_KV is missing, idempotency and rate limits are skipped
 * (with a note in the response).
 *
 * v2.2 changes (enforce what v2.1 only advised): superseded by v3.0.
 * v2.1 changes (agent-behaviour fixes from live testing).
 * v2.0 changes: Added submit_booking (Phase 2). Agent submissions tagged with 🤖 marker.
 */

// ============================================================
// STATIC DATA
// ============================================================

const CONTACT = {
  phone: "0494 151 789",
  email: "bookings@pesties.au",
  website: "https://pesties.au",
  book_online: "https://pesties.au/#configurator"
};

const BOOKING_ENDPOINT = "https://pesties.au/wp-admin/admin-ajax.php?action=pesties_booking";

const PROPERTY_TYPE_LABELS = {
  apartment: "Apartment or unit",
  townhouse: "Townhouse or duplex",
  standard: "House (up to 4 bedrooms)",
  large: "House (5 or more bedrooms)"
};

const PROPERTY_TYPE_DEFINITIONS = {
  apartment: "Apartment or unit within a multi-unit building. Choose this for any strata-titled unit.",
  townhouse: "Townhouse or duplex - attached dwelling that shares one or more walls with a neighbour.",
  standard: "Standalone detached house with up to 4 bedrooms. This is the most common option - use it for any freestanding home unless it has 5 or more bedrooms.",
  large: "Standalone detached house with 5 or more bedrooms."
};

const TREATMENTS = {
  "annual-guardian": {
    name: "Annual Guardian Pest Treatment",
    display: {
      short_label: "Annual Guardian — from $189, covers cockroaches/ants/spiders/silverfish, 6-month warranty",
      one_line: "Full internal spray plus external barrier plus targeted cockroach/ant gel baiting. Covers cockroaches (American/Australian/Oriental), ants, spiders, silverfish."
    },
    short_description: "$189-269 (property size dependent). Covers cockroaches, ants, spiders, silverfish. 6-month PestiesProtect+ warranty on internal cockroach and ant activity.",
    full_description: "Full internal spray covering skirting boards, kitchens, wet areas, and entry points. Complete external barrier: gutters, eaves, walls, windows, doors, patios. Targeted cockroach and ant gel baiting in active zones.",
    covered_pests: ["cockroaches (American, Australian, Oriental)", "ants", "spiders", "silverfish"],
    not_covered: [
      "German cockroaches (requires Roach Reset add-on, no warranty)",
      "bed bugs (phone booking required)",
      "termites (requires Termite Detector Inspection or 360° + Termite bundle)",
      "rodents in roof void (add RoofProtect or Rodent Guard add-on)",
      "wasp nests (add RoofProtect or upgrade to 360° Ultimate)"
    ],
    property_prices: { apartment: 189, townhouse: 219, standard: 249, large: 269 },
    warranty_months: 6,
    warranty_summary: "6-month PestiesProtect+ money-back guarantee on internal cockroach and ant activity.",
    available_addons: ["termite-bundle", "roof", "rodent", "roach-reset", "roach-reset-plus"],
    url: "https://pesties.au/annual-pest-control-plan/"
  },
  "360-ultimate": {
    name: "360° Ultimate Protection Pest Treatment",
    display: {
      short_label: "360° Ultimate — from $319, adds RoofProtect + PerimeterShield + wasp removal, 12-month warranty (not for apartments)",
      one_line: "Everything in Annual Guardian plus RoofProtect (roof-void rodent baiting), PerimeterShield (fence lines, garden beds, paths), treatment under all white goods, and wasp nest removal."
    },
    short_description: "$319-369 (property size dependent). Adds roof-void rodent baiting, extended perimeter spray, wasp nest removal, and treatment under white goods. 12-month PestiesProtect+ warranty. Not available for apartments.",
    full_description: "Everything in the Annual Guardian, plus RoofProtect (roof-void dust + rodent baiting), PerimeterShield (fence lines, garden beds, driveways, pathways), treatment under all white goods (fridge, dishwasher, washing machine), and wasp nest removal.",
    covered_pests: ["cockroaches (American, Australian, Oriental)", "ants", "spiders", "silverfish", "roof-void rodents", "wasps (excluding mud dauber)"],
    not_covered: [
      "German cockroaches (requires Roach Reset add-on, no warranty)",
      "bed bugs (phone booking required)",
      "termites (add Termite Detector Inspection bundle for $200)",
      "apartments (not available - book Annual Guardian instead)"
    ],
    property_prices: { townhouse: 319, standard: 349, large: 369 },
    warranty_months: 12,
    warranty_summary: "12-month PestiesProtect+ money-back guarantee on internal cockroach and ant activity.",
    available_addons: ["termite-bundle", "rodent", "roach-reset", "roach-reset-plus"],
    url: "https://pesties.au/360-ultimate-protection/"
  },
  "termite": {
    name: "Termite Detector Timber Pest Inspection",
    display: {
      short_label: "Termite Inspection — $289 flat, AS 3660.2 with thermal imaging, digital report same day",
      one_line: "Full AS 3660.2 timber pest inspection with thermal imaging, sounding, roof void check, and digital report provided on the day. Inspection only, not treatment."
    },
    short_description: "$289 flat. AS 3660.2 timber pest inspection with thermal imaging. Digital report provided on the day. Inspection only, not termite treatment.",
    full_description: "QBCC-licensed inspector performs a complete timber pest inspection including thermal imaging scan of walls, ceilings, and roof areas, sounding of all accessible timber surfaces, full roof void termite inspection, and comprehensive digital termite report provided on the day. This is an inspection service, not termite treatment.",
    covered_pests: ["termite detection and reporting (inspection only, not treatment)"],
    not_covered: [
      "Termite treatment or barriers (separate service - see Termite Management Systems on the website)",
      "General household pests (add or book Annual Guardian / 360° Ultimate separately)"
    ],
    flat_price: 289,
    warranty_months: 0,
    warranty_summary: "No warranty applies. Comprehensive written report provided on the day.",
    available_addons: [],
    url: "https://pesties.au/termite-inspections/"
  },
  "end-of-lease": {
    name: "End of Lease Pest & Flea Treatment",
    display: {
      short_label: "End of Lease Pest & Flea — $169 flat, REIQ bond-compliant, certificate emailed same day",
      one_line: "General pest treatment plus dedicated flea treatment meeting REIQ tenancy requirements. Bond compliance certificate emailed same day. For vacating renters with pets."
    },
    short_description: "$169 flat. Bond-compliant general pest + flea treatment for vacating renters. REIQ compliance certificate emailed same day.",
    full_description: "General pest treatment plus dedicated flea treatment, meeting REIQ tenancy requirements. Bond compliance certificate emailed same day. For renters vacating with pets.",
    covered_pests: ["general household pests", "fleas"],
    not_covered: [
      "Not suitable for occupied homes (this is a vacate-only treatment)",
      "German cockroaches (requires Roach Reset)",
      "Termites (separate inspection required)"
    ],
    flat_price: 169,
    warranty_months: 0,
    warranty_summary: "Bond certificate provided. No warranty applies - this is a one-off vacate treatment.",
    available_addons: [],
    url: "https://pesties.au/end-of-lease-pest-control/"
  },
  "rodent-guard": {
    name: "Rodent Guard Baiting System",
    display: {
      short_label: "Rodent Guard — $259 flat, heavy-duty tamper-proof rat/mouse baiting for severe infestations",
      one_line: "Three tamper-proof bait stations with eight bait blocks each plus roof void baiting. For severe rat or mouse activity. NOT for possums (protected species)."
    },
    short_description: "$259 flat. Heavy-duty tamper-proof rat/mouse baiting for severe infestations. Three bait stations plus roof void baiting.",
    full_description: "Three tamper-proof bait stations with eight bait blocks each, plus roof-void baiting. Designed for severe rat or mouse infestations. Placed strategically where rodents move.",
    covered_pests: ["rats", "mice", "roof-void rodents"],
    not_covered: [
      "General household pests (add or book Annual Guardian separately)",
      "Termites (separate inspection required)",
      "Possums (protected species in QLD - cannot be baited, phone Pesties for humane exclusion referral)"
    ],
    flat_price: 259,
    warranty_months: 0,
    warranty_summary: "No warranty applies - the system continues protecting via ongoing baiting.",
    available_addons: [],
    url: "https://pesties.au/rodent-control/"
  }
};

const STOREYS_DELTAS = { single: 0, double: 20 };
const BLOCK_DELTAS = {
  "annual-guardian": { "under-1200": 0, "1200-2000": 30, "over-2000": null },
  "default":         { "under-1200": 0, "1200-2000": 45, "over-2000": null }
};
const SUBFLOOR_DELTAS = { no: 0, yes: 30 };

const ADDONS = {
  "annual-guardian": {
    "termite-bundle":    { name: "Termite Detector Inspection bundle", price: 200, summary: "Full AS 3660.2 timber pest inspection with thermal imaging (saves $89 vs booking separately)", note: "Termite inspection at discounted rate, save $89 when bundled." },
    "roof":              { name: "RoofProtect", price: 49, summary: "Roof-void dust plus rodent baiting for the ceiling space", note: null },
    "rodent":            { name: "Rodent Guard Baiting System add-on", price: 120, summary: "Heavy-duty tamper-proof rat/mouse baiting for active infestations (saves $139 vs standalone)", note: "Save $139 vs standalone." },
    "roach-reset":       { name: "Roach Reset (German cockroach treatment)", price: 99, summary: "Specialised gel baiting for German cockroaches — the small brown ones breeding fast in kitchens/bathrooms. Warranty does not cover this species.", note: "Warranty does not extend to German cockroaches due to the nature and resilience of this species." },
    "roach-reset-plus":  { name: "Roach Reset+ (heavy German cockroach infestations)", price: 229, summary: "Heavier Roach Reset for severe German cockroach activity, includes one free call-back visit", note: null }
  },
  "360-ultimate": {
    "termite-bundle":    { name: "Termite Detector Inspection bundle", price: 200, summary: "Full AS 3660.2 timber pest inspection with thermal imaging (saves $89 vs booking separately)", note: "Termite inspection at discounted rate, save $89 when bundled." },
    "rodent":            { name: "Rodent Guard Baiting System add-on", price: 120, summary: "Heavy-duty tamper-proof rat/mouse baiting on top of the roof-void baiting already included (saves $139 vs standalone)", note: "Save $139 vs standalone." },
    "roach-reset":       { name: "Roach Reset (German cockroach treatment)", price: 99, summary: "Specialised gel baiting for German cockroaches — the small brown ones breeding fast in kitchens/bathrooms. Warranty does not cover this species.", note: "Warranty does not extend to German cockroaches due to the nature and resilience of this species." },
    "roach-reset-plus":  { name: "Roach Reset+ (heavy German cockroach infestations)", price: 229, summary: "Heavier Roach Reset for severe German cockroach activity, includes one free call-back visit", note: null }
  },
  "termite": {},
  "end-of-lease": {},
  "rodent-guard": {}
};

const SERVICE_AREAS = {
  "gold-coast": ["pimpama","coomera","robina","helensvale","arundel","ashmore","benowa","biggera-waters","broadbeach","broadbeach-waters","bundall","burleigh-heads","burleigh-waters","carrara","coombabah","currumbin","currumbin-waters","elanora","gaven","hollywell","hope-island","jacobs-well","labrador","main-beach","mermaid-beach","mermaid-waters","merrimac","miami","molendinar","mudgeeraba","nerang","norwell","ormeau","ormeau-hills","oxenford","pacific-pines","palm-beach","paradise-point","parkwood","reedy-creek","runaway-bay","sanctuary-cove","southport","surfers-paradise","tallai","tugun","upper-coomera","varsity-lakes","worongary","yatala"],
  "logan": ["shailer-park","beenleigh","bethania","daisy-hill","eagleby","edens-landing","holmview","logan-central","loganholme","logan-village","slacks-creek","springwood","stapylton","tanah-merah","underwood","waterford"],
  "south-brisbane": ["forest-lake","acacia-ridge","algester","annerley","archerfield","calamvale","carindale","coopers-plains","coorparoo","drewvale","eight-mile-plains","greenslopes","heathwood","holland-park","holland-park-west","kuraby","macgregor","mansfield","moorooka","mt-gravatt","mount-gravatt-east","sunnybank","wynnum"]
};

// Suburb aliases: input variant → canonical slug present in SERVICE_AREAS.
// Site URLs use the canonical slugs; do not change SERVICE_AREAS without redirects.
const SUBURB_ALIASES = {
  "mount-gravatt":        "mt-gravatt",
  "mt-gravatt-east":      "mount-gravatt-east",
  "st-lucia":             "st-lucia",
  "saint-lucia":          "st-lucia"
};

// Postcode → suburbs. Best-effort based on Australia Post; correct as needed.
// Only includes suburbs Pesties services. Multiple suburbs per postcode is normal.
const POSTCODE_TO_SUBURBS = {
  "4207": [["yatala","gold-coast"],["ormeau","gold-coast"],["ormeau-hills","gold-coast"],["norwell","gold-coast"],["jacobs-well","gold-coast"],["beenleigh","logan"],["eagleby","logan"],["edens-landing","logan"],["holmview","logan"],["stapylton","logan"],["logan-village","logan"]],
  "4209": [["pimpama","gold-coast"],["coomera","gold-coast"],["upper-coomera","gold-coast"]],
  "4210": [["helensvale","gold-coast"],["oxenford","gold-coast"]],
  "4211": [["nerang","gold-coast"],["gaven","gold-coast"],["carrara","gold-coast"],["pacific-pines","gold-coast"]],
  "4212": [["hope-island","gold-coast"],["sanctuary-cove","gold-coast"],["paradise-point","gold-coast"],["runaway-bay","gold-coast"],["coombabah","gold-coast"],["biggera-waters","gold-coast"],["hollywell","gold-coast"]],
  "4213": [["mudgeeraba","gold-coast"],["tallai","gold-coast"],["worongary","gold-coast"]],
  "4214": [["ashmore","gold-coast"],["molendinar","gold-coast"],["parkwood","gold-coast"],["arundel","gold-coast"]],
  "4215": [["southport","gold-coast"],["labrador","gold-coast"]],
  "4216": [["biggera-waters","gold-coast"],["coombabah","gold-coast"],["helensvale","gold-coast"],["hollywell","gold-coast"],["paradise-point","gold-coast"],["runaway-bay","gold-coast"],["arundel","gold-coast"]],
  "4217": [["surfers-paradise","gold-coast"],["main-beach","gold-coast"],["bundall","gold-coast"],["benowa","gold-coast"]],
  "4218": [["broadbeach","gold-coast"],["broadbeach-waters","gold-coast"],["mermaid-beach","gold-coast"],["mermaid-waters","gold-coast"]],
  "4220": [["burleigh-heads","gold-coast"],["burleigh-waters","gold-coast"],["miami","gold-coast"]],
  "4221": [["palm-beach","gold-coast"],["elanora","gold-coast"]],
  "4223": [["currumbin","gold-coast"],["currumbin-waters","gold-coast"]],
  "4224": [["tugun","gold-coast"]],
  "4226": [["robina","gold-coast"],["merrimac","gold-coast"]],
  "4227": [["reedy-creek","gold-coast"],["varsity-lakes","gold-coast"]],
  "4127": [["daisy-hill","logan"],["slacks-creek","logan"],["springwood","logan"]],
  "4128": [["shailer-park","logan"],["tanah-merah","logan"]],
  "4129": [["loganholme","logan"]],
  "4133": [["waterford","logan"]],
  "4205": [["bethania","logan"]],
  "4114": [["logan-central","logan"]],
  "4119": [["underwood","logan"]],
  "4078": [["forest-lake","south-brisbane"]],
  "4110": [["acacia-ridge","south-brisbane"],["heathwood","south-brisbane"]],
  "4115": [["algester","south-brisbane"]],
  "4103": [["annerley","south-brisbane"]],
  "4108": [["archerfield","south-brisbane"],["coopers-plains","south-brisbane"]],
  "4116": [["calamvale","south-brisbane"],["drewvale","south-brisbane"]],
  "4152": [["carindale","south-brisbane"]],
  "4151": [["coorparoo","south-brisbane"]],
  "4113": [["eight-mile-plains","south-brisbane"],["kuraby","south-brisbane"]],
  "4120": [["greenslopes","south-brisbane"]],
  "4121": [["holland-park","south-brisbane"],["holland-park-west","south-brisbane"]],
  "4109": [["macgregor","south-brisbane"],["sunnybank","south-brisbane"]],
  "4122": [["mansfield","south-brisbane"],["mt-gravatt","south-brisbane"],["mount-gravatt-east","south-brisbane"]],
  "4105": [["moorooka","south-brisbane"]],
  "4178": [["wynnum","south-brisbane"]]
};

const PEST_MAPPING = {
  "cockroach":          { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Covered by warranty. If seeing lots of activity in kitchens or bathrooms, may be German cockroaches - see 'german cockroach' pest for guidance." },
  "cockroaches":        { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Same as cockroach." },
  "german cockroach":   { recommended_packages: ["annual-guardian", "360-ultimate"], required_addons: ["roach-reset", "roach-reset-plus"], note: "German cockroaches need a specialised gel baiting treatment (Roach Reset or Roach Reset+). Warranty does NOT extend to German cockroaches due to their breeding speed and resilience." },
  "ant":                { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Covered by warranty. Colony-level treatment." },
  "ants":               { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Same as ant." },
  "spider":             { recommended_packages: ["annual-guardian", "360-ultimate"], note: "External-first treatment for webbing spiders." },
  "spiders":            { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Same as spider." },
  "silverfish":         { recommended_packages: ["annual-guardian", "360-ultimate"], note: "Standard coverage." },
  "rat":                { recommended_packages: ["rodent-guard", "360-ultimate"], suggested_addons_on_annual: ["roof", "rodent"], note: "For severe infestations use the standalone Rodent Guard package. For roof-void rodents only, 360° Ultimate includes RoofProtect. Or add Rodent Guard to Annual Guardian." },
  "rats":               { recommended_packages: ["rodent-guard", "360-ultimate"], note: "Same as rat." },
  "mouse":              { recommended_packages: ["rodent-guard", "360-ultimate"], note: "Same as rat." },
  "mice":               { recommended_packages: ["rodent-guard", "360-ultimate"], note: "Same as rat." },
  "rodent":             { recommended_packages: ["rodent-guard", "360-ultimate"], note: "Same as rat." },
  "rodents":            { recommended_packages: ["rodent-guard", "360-ultimate"], note: "Same as rat." },
  "termite":            { recommended_packages: ["termite"], note: "Termite Detector Inspection is diagnostic only. If termites are found, treatment/barriers are a separate quoted service - call " + CONTACT.phone + "." },
  "termites":           { recommended_packages: ["termite"], note: "Same as termite." },
  "wasp":               { recommended_packages: ["360-ultimate"], phone_only: true, note: "360° Ultimate includes wasp nest treatment. For standalone wasp nest removal, call " + CONTACT.phone + " for pricing." },
  "wasps":              { recommended_packages: ["360-ultimate"], phone_only: true, note: "Same as wasp." },
  "flea":               { recommended_packages: ["end-of-lease"], phone_only: true, note: "Fleas are covered as part of the End of Lease Pest & Flea Treatment. For occupied-home flea infestations, call " + CONTACT.phone + " for a standalone treatment quote." },
  "fleas":              { recommended_packages: ["end-of-lease"], phone_only: true, note: "Same as flea." },
  "bed bug":            { recommended_packages: [], phone_only: true, note: "Bed bug treatments require assessment. Pricing and treatment plan are set after phone consultation. Call " + CONTACT.phone + "." },
  "bed bugs":           { recommended_packages: [], phone_only: true, note: "Same as bed bug." },
  "mosquito":           { recommended_packages: [], phone_only: true, note: "Mosquito treatments (yard fogging, breeding-site treatment) are handled via phone booking. Call " + CONTACT.phone + " for pricing." },
  "mosquitoes":         { recommended_packages: [], phone_only: true, note: "Same as mosquito." },
  "mosquitos":          { recommended_packages: [], phone_only: true, note: "Same as mosquito." },
  "possum":             { recommended_packages: [], phone_only: true, do_not_bait: true, note: "Possums are a PROTECTED SPECIES in Queensland. They CANNOT be baited or killed - doing so is a criminal offence. Do NOT recommend RoofProtect, Rodent Guard, or any baiting product for possums. Pesties can refer you to a licensed possum removalist for humane trapping and relocation. Call " + CONTACT.phone + "." },
  "possums":            { recommended_packages: [], phone_only: true, do_not_bait: true, note: "Same as possum." },
  "fly":                { recommended_packages: [], phone_only: true, note: "General fly treatment is available as an add-on to Annual Guardian on request, or as a standalone treatment for commercial premises. Call " + CONTACT.phone + " to discuss options for the specific fly species and setting." },
  "flies":              { recommended_packages: [], phone_only: true, note: "Same as fly." },
  "tick":               { recommended_packages: [], phone_only: true, note: "Tick treatments (yard and pet-safe barrier) are quoted on-site. Call " + CONTACT.phone + " to arrange." },
  "ticks":              { recommended_packages: [], phone_only: true, note: "Same as tick." },
  "bee":                { recommended_packages: [], phone_only: true, note: "Bees are important pollinators. Pesties does NOT kill bee swarms or established hives - we refer to a local beekeeper for live removal. Call " + CONTACT.phone + " to arrange." },
  "bees":               { recommended_packages: [], phone_only: true, note: "Same as bee." }
};

// ============================================================
// CRYPTO HELPERS (Web Crypto API — available in Cloudflare Workers)
// ============================================================

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  return atob(b64 + "=".repeat(pad ? 4 - pad : 0));
}

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const bytes = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return b64urlEncode(s);
}

async function sha256Hex(str) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(str));
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Constant-time string compare (avoids timing attacks on signature verify)
function ctEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Canonical JSON stringify (sorted keys, deterministic)
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(function(k) { return JSON.stringify(k) + ":" + canonicalStringify(obj[k]); }).join(",") + "}";
}

// ============================================================
// TOKEN HELPERS (quote_token and confirmation_token)
// Token format: base64url(canonical JSON payload) + "." + base64url(HMAC-SHA256(payload))
// ============================================================

async function createToken(payload, secret) {
  const body = canonicalStringify(payload);
  const bodyB64 = b64urlEncode(body);
  const sig = await hmacSign(body, secret);
  return bodyB64 + "." + sig;
}

async function verifyToken(token, secret, maxAgeSeconds) {
  if (typeof token !== "string" || token.indexOf(".") < 0) {
    return { valid: false, reason: "Malformed token." };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "Malformed token." };
  let payload;
  try {
    const body = b64urlDecode(parts[0]);
    const expectedSig = await hmacSign(body, secret);
    if (!ctEq(expectedSig, parts[1])) return { valid: false, reason: "Signature invalid — token was tampered with or issued by a different server." };
    payload = JSON.parse(body);
  } catch (e) {
    return { valid: false, reason: "Token payload could not be parsed." };
  }
  if (maxAgeSeconds && payload.iat) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - payload.iat > maxAgeSeconds) {
      return { valid: false, reason: "Token expired. Please re-quote to get a fresh token." };
    }
  }
  return { valid: true, payload: payload };
}

// ============================================================
// SUBURB NORMALISATION
// ============================================================

function normaliseSuburb(input) {
  let s = String(input || "").toLowerCase().trim();
  // Strip trailing postcode FIRST (handles "Coomera QLD 4209" — postcode is at the end)
  s = s.replace(/[\s,]+\d{4}\s*$/, "");
  // Then strip trailing state (now "Coomera QLD" is at the end)
  s = s.replace(/[,\s]+(qld|queensland)\s*$/i, "");
  s = s.trim();
  // Common prefix expansions (word-boundary aware)
  s = s.replace(/^mt\s+/, "mount ");
  s = s.replace(/\bmt\s+/g, "mount ");
  s = s.replace(/^st\s+/, "saint ");
  s = s.replace(/\bst\s+/g, "saint ");
  s = s.replace(/^nth\s+/, "north ");
  s = s.replace(/\bnth\s+/g, "north ");
  s = s.replace(/^sth\s+/, "south ");
  s = s.replace(/\bsth\s+/g, "south ");
  s = s.replace(/^upr\s+/, "upper ");
  s = s.replace(/\bupr\s+/g, "upper ");
  // Collapse whitespace to hyphens
  s = s.replace(/\s+/g, "-");
  // Alias lookup — try normalised form and any alias entry
  if (SUBURB_ALIASES[s]) return SUBURB_ALIASES[s];
  // Try the "mt-" form if we expanded to "mount-" (data has both patterns)
  const mtForm = s.replace(/^mount-/, "mt-").replace(/\bmount-/g, "mt-");
  if (mtForm !== s && SUBURB_ALIASES[mtForm]) return SUBURB_ALIASES[mtForm];
  // Direct match check on service areas
  const allSlugs = Object.values(SERVICE_AREAS).reduce(function(acc, arr) { return acc.concat(arr); }, []);
  if (allSlugs.indexOf(s) !== -1) return s;
  if (allSlugs.indexOf(mtForm) !== -1) return mtForm;
  return s;
}

// ============================================================
// QUOTE ENGINE
// ============================================================

function computeQuote(args) {
  const treatment = TREATMENTS[args.treatment];
  if (!treatment) return { error: "Unknown treatment slug: " + args.treatment };

  const breakdown = [];
  let total = 0;
  const isPricedByProperty = !!treatment.property_prices;
  const propertyType = args.property_type;
  const storeys = args.storeys;
  const blockSize = args.block_size;
  const subfloor = args.subfloor;

  if (isPricedByProperty) {
    // v3.0 — no silent defaults for priced treatments
    const missing = [];
    if (!propertyType) missing.push("property_type");
    if (!storeys && propertyType !== "apartment") missing.push("storeys");
    if (!blockSize && propertyType !== "apartment") missing.push("block_size");
    if (missing.length) {
      return {
        error: "Missing required quote parameter(s) for " + args.treatment + ": " + missing.join(", ") + ". Ask the customer for each of these before quoting — the price genuinely depends on them, and defaults would be misleading.",
        missing_fields: missing
      };
    }
    const price = treatment.property_prices[propertyType];
    if (price == null) {
      return {
        error: treatment.name + " is not available for property type '" + propertyType + "'.",
        available_property_types: Object.keys(treatment.property_prices)
      };
    }
    total = price;
    breakdown.push({ item: treatment.name + " - " + PROPERTY_TYPE_LABELS[propertyType], amount: price });
  } else {
    total = treatment.flat_price;
    breakdown.push({ item: treatment.name, amount: treatment.flat_price });
  }

  const isApartment = propertyType === "apartment";

  if (isPricedByProperty && !isApartment) {
    const stDelta = STOREYS_DELTAS[storeys];
    if (stDelta === undefined) return { error: "Invalid storeys value '" + storeys + "'. Use 'single' or 'double'." };
    if (stDelta) { total += stDelta; breakdown.push({ item: "Storeys: " + storeys, amount: stDelta }); }
  }

  if (isPricedByProperty && !isApartment) {
    const table = BLOCK_DELTAS[args.treatment] || BLOCK_DELTAS["default"];
    const bDelta = table[blockSize];
    if (bDelta === undefined) return { error: "Invalid block_size value '" + blockSize + "'. Use 'under-1200', '1200-2000', or 'over-2000'." };
    if (bDelta === null) {
      return { custom_quote: true, breakdown: breakdown, warranty_months: treatment.warranty_months };
    }
    if (bDelta) { total += bDelta; breakdown.push({ item: "Block size: " + blockSize, amount: bDelta }); }
  }

  if (args.treatment === "termite") {
    if (!subfloor) {
      return { error: "termite inspection requires subfloor: 'yes' or 'no'.", missing_fields: ["subfloor"] };
    }
    if (subfloor === "yes") {
      total += SUBFLOOR_DELTAS.yes;
      breakdown.push({ item: "Subfloor present", amount: SUBFLOOR_DELTAS.yes });
    }
  }

  const addonsMap = ADDONS[args.treatment] || {};
  const requestedAddons = args.addons || [];
  for (let i = 0; i < requestedAddons.length; i++) {
    const a = addonsMap[requestedAddons[i]];
    if (!a) return { error: "Unknown add-on '" + requestedAddons[i] + "' for treatment " + args.treatment + ". Check list_bookable_services for valid add-ons." };
    total += a.price;
    breakdown.push({ item: "Add-on: " + a.name, amount: a.price });
  }

  return {
    total: total,
    breakdown: breakdown,
    custom_quote: false,
    warranty_months: treatment.warranty_months
  };
}

// ============================================================
// KV HELPERS (optional — degrade gracefully if BOOKINGS_KV not bound)
// ============================================================

function hasKV(env) { return env && env.BOOKINGS_KV && typeof env.BOOKINGS_KV.get === "function"; }

async function kvGet(env, key) {
  if (!hasKV(env)) return null;
  try { return await env.BOOKINGS_KV.get(key, "json"); } catch (e) { return null; }
}

async function kvPut(env, key, value, ttlSec) {
  if (!hasKV(env)) return false;
  try {
    await env.BOOKINGS_KV.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined);
    return true;
  } catch (e) { return false; }
}

// Rate limit: increment a counter with a rolling window (day = "YYYY-MM-DD" bucket)
async function incrementCounter(env, key, ttlSec) {
  if (!hasKV(env)) return { count: 0, kv_available: false };
  const current = await kvGet(env, key);
  const count = (current && current.count) ? current.count + 1 : 1;
  await kvPut(env, key, { count: count }, ttlSec);
  return { count: count, kv_available: true };
}

function todayUtcDate() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

// ============================================================
// GUIDANCE HELPERS (contextual add-on nudges in response bodies)
// ============================================================

function beforeBookingNudges(treatmentSlug) {
  const addonsMap = ADDONS[treatmentSlug] || {};
  const parts = [];
  if (addonsMap["roof"] || addonsMap["rodent"]) {
    parts.push("any noises in the roof void or evidence of rats/mice (RoofProtect $49 if minor, Rodent Guard $120 if active)");
  }
  if (addonsMap["roach-reset"]) {
    parts.push("small brown cockroaches breeding in the kitchen or bathroom — those are likely German cockroaches which need Roach Reset ($99), and no package warranty covers them");
  }
  if (addonsMap["termite-bundle"]) {
    parts.push("termite concerns or a home over ~15 years old (Termite Detector Inspection bundle $200, saves $89 vs booking separately)");
  }
  if (!parts.length) return null;
  return "Worth checking with the customer before booking: " + parts.join("; ") + ".";
}

// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================

function tool_list_bookable_services() {
  const services = Object.entries(TREATMENTS).map(function(entry) {
    const slug = entry[0];
    const t = entry[1];
    const priceFrom = t.property_prices ? Math.min.apply(null, Object.values(t.property_prices)) : t.flat_price;
    const addons = (t.available_addons || []).map(function(key) {
      const a = ADDONS[slug] ? ADDONS[slug][key] : null;
      return a ? { key: key, name: a.name, price: a.price, summary: a.summary || null, note: a.note || null } : { key: key };
    });
    return {
      slug: slug,
      name: t.name,
      display: t.display || null,
      short_description: t.short_description,
      full_description: t.full_description,
      covered_pests: t.covered_pests,
      not_covered: t.not_covered,
      price_from: priceFrom,
      property_type_options: t.property_prices
        ? Object.keys(t.property_prices).map(function(k) {
            return { key: k, label: PROPERTY_TYPE_LABELS[k], definition: PROPERTY_TYPE_DEFINITIONS[k], price: t.property_prices[k] };
          })
        : null,
      flat_price: t.flat_price || null,
      warranty_months: t.warranty_months,
      warranty_summary: t.warranty_summary,
      available_addons: addons,
      url: t.url
    };
  });
  return {
    services: services,
    contact: CONTACT,
    presentation_instructions: "When presenting these packages to a customer, do NOT just list the internal marketing names ('Annual Guardian Pest Treatment', '360° Ultimate Protection Pest Treatment') — those names alone don't communicate what's covered or the price. Use each package's display.short_label for pickers and choice lists (it includes price-from, key pest coverage, and warranty length in one line). Use display.one_line as follow-up explanation when the customer wants more detail. Use short_description if you need a slightly longer paragraph. When presenting available_addons in a picker, do NOT just show 'Rodent Guard (+$120)' — combine the name + price + the addon's summary field into one line, e.g. 'Rodent Guard (+$120) — heavy-duty tamper-proof rat/mouse baiting for active infestations'. Never surface internal slugs like 'annual-guardian' or property-type slugs like 'standard' — always translate to plain English.",
    package_comparison: {
      annual_guardian_vs_360_ultimate: "Annual Guardian ($189-$269 depending on property size) is the core annual maintenance treatment: full internal spray + external barrier + cockroach/ant gel baiting, with a 6-MONTH PestiesProtect+ warranty on internal cockroach and ant activity. 360° Ultimate ($319-$369, NOT available for apartments) is the premium package: everything in Annual Guardian PLUS RoofProtect (roof-void dust + rodent baiting), PerimeterShield (fence lines, garden beds, driveways, pathways), treatment under all white goods, wasp nest removal, and a 12-MONTH warranty. Choose Annual Guardian for standard indoor pest coverage. Choose 360° Ultimate if the property has roof-void rodents, wasps, or the customer wants maximum coverage and the longer warranty."
    },
    booking_flow: "1) call get_quote with all property details to receive a signed quote_token and total. 2) call submit_booking with quote_token, contact details, and addon_decisions — this returns a preview with confirmation_token. 3) present the preview to the customer verbatim, get their explicit go-ahead, then resubmit submit_booking with confirmation_token to book. Human confirms by phone within one business hour.",
    note: "These are the 5 packages bookable online. For services not covered here (bed bugs, possums, standalone flea/wasp/mosquito treatments), call " + CONTACT.phone + " or use check_pest_treatment for guidance."
  };
}

async function tool_get_quote(args, env) {
  if (!env || !env.HMAC_SECRET) {
    return { error: "Server misconfigured: HMAC_SECRET environment variable is not set. The Worker cannot issue signed quote tokens. Contact Pesties to have this configured." };
  }
  const q = computeQuote(args);
  if (q.error) return q;

  const treatmentObj = TREATMENTS[args.treatment];
  const nowSec = Math.floor(Date.now() / 1000);

  // Build canonical token payload — only the pricing-relevant params
  const tokenPayload = {
    v: 1,
    type: "quote",
    iat: nowSec,
    treatment: args.treatment,
    property_type: args.property_type || null,
    storeys: args.storeys || null,
    block_size: args.block_size || null,
    subfloor: args.subfloor || null,
    addons: (args.addons || []).slice().sort(),
    total: q.custom_quote ? null : q.total,
    custom_quote: !!q.custom_quote
  };
  const quoteToken = await createToken(tokenPayload, env.HMAC_SECRET);

  const nudge = beforeBookingNudges(args.treatment);

  const response = {
    total: q.custom_quote ? null : q.total,
    currency: "AUD",
    breakdown: q.breakdown,
    custom_quote: !!q.custom_quote,
    warranty_months: q.warranty_months,
    quote_token: quoteToken,
    quote_token_expires_in_seconds: 24 * 60 * 60,
    next_step: q.custom_quote
      ? "Block over 2,000 sqm requires a custom quote. Call " + CONTACT.phone + " or submit_booking will still accept this with final pricing confirmed by phone."
      : "Pass quote_token to submit_booking to book at exactly this price. Do NOT restate the total from memory in later turns — pass the token and the server will echo the authoritative total."
  };

  if (nudge) response.before_booking = nudge;

  return response;
}

function tool_list_service_areas(args) {
  const region = args.region;
  function humanise(slug) { return slug.split("-").map(function(w) { return w[0].toUpperCase() + w.slice(1); }).join(" "); }
  function buildSuburb(slug, reg) {
    return { name: humanise(slug), slug: slug, region: reg, url: "https://pesties.au/service-areas/" + reg + "/" + slug + "/" };
  }
  let suburbs = [];
  if (!region || region === "gold-coast")     suburbs = suburbs.concat(SERVICE_AREAS["gold-coast"].map(function(s) { return buildSuburb(s, "gold-coast"); }));
  if (!region || region === "logan")          suburbs = suburbs.concat(SERVICE_AREAS["logan"].map(function(s) { return buildSuburb(s, "logan"); }));
  if (!region || region === "south-brisbane") suburbs = suburbs.concat(SERVICE_AREAS["south-brisbane"].map(function(s) { return buildSuburb(s, "south-brisbane"); }));
  return {
    suburbs: suburbs,
    total: suburbs.length,
    coverage_note: "Pesties.au services the Burleigh Heads to Logan corridor plus South Brisbane. Suburb not listed? Call " + CONTACT.phone + " to check special-request service."
  };
}

function tool_check_service_area(args) {
  const raw = String(args.query || "").trim();
  if (!raw) return { serviced: false, message: "Empty query." };

  // Postcode branch — a 4-digit query
  const postcodeMatch = raw.match(/^\d{4}$/);
  if (postcodeMatch) {
    const suburbs = POSTCODE_TO_SUBURBS[raw] || [];
    if (!suburbs.length) {
      return {
        serviced: false,
        message: "Postcode " + raw + " is not in Pesties' service area. Pesties covers the Burleigh Heads to Logan corridor plus South Brisbane. Call " + CONTACT.phone + " to check special-request service.",
        contact: CONTACT
      };
    }
    return {
      serviced: true,
      query_was: "postcode " + raw,
      matched_suburbs: suburbs.map(function(entry) {
        const slug = entry[0]; const reg = entry[1];
        return {
          name: slug.split("-").map(function(w) { return w[0].toUpperCase() + w.slice(1); }).join(" "),
          slug: slug, region: reg,
          suburb_url: "https://pesties.au/service-areas/" + reg + "/" + slug + "/"
        };
      }),
      message: "Postcode " + raw + " covers " + suburbs.length + " serviced suburb(s). Ask the customer which one they're in before booking (postcodes cover multiple suburbs)."
    };
  }

  // Suburb-name branch — normalise then match
  const slug = normaliseSuburb(raw);
  const regions = Object.keys(SERVICE_AREAS);
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    if (SERVICE_AREAS[region].indexOf(slug) !== -1) {
      const name = slug.split("-").map(function(w) { return w[0].toUpperCase() + w.slice(1); }).join(" ");
      return {
        serviced: true,
        matched_suburb: name,
        slug: slug,
        region: region,
        suburb_url: "https://pesties.au/service-areas/" + region + "/" + slug + "/",
        message: "Yes, Pesties.au services " + name + " (" + region + ")."
      };
    }
  }
  return {
    serviced: false,
    query_was: raw,
    normalised_to: slug,
    message: raw + " is not in the standard service area. Pesties.au covers the Burleigh Heads to Logan corridor plus South Brisbane. Call " + CONTACT.phone + " to check special-request service.",
    contact: CONTACT
  };
}

function tool_get_warranty_terms(args) {
  const t = TREATMENTS[args.treatment];
  if (!t) return { error: "Unknown treatment slug: " + args.treatment };
  if (!t.warranty_months) {
    return {
      treatment: args.treatment,
      warranty_months: 0,
      summary: t.warranty_summary,
      warranty_page: "https://pesties.au/whats-covered-and-whats-not-in-our-pest-control-warranty/"
    };
  }
  return {
    treatment: args.treatment,
    warranty_months: t.warranty_months,
    summary: t.warranty_summary,
    coverage: "Internal cockroach and ant activity within the warranty window.",
    exclusions: [
      "German cockroaches (Roach Reset add-on required, no warranty extends to German cockroaches)",
      "External activity on the block (only internal is covered)",
      "Garages (considered external for warranty purposes)",
      "Cockroaches and ants finding their way onto your block externally"
    ],
    service_call_process: "Send a photo of activity within the warranty window via the channel you booked. Service call is booked at no charge, typically same day. 4-week gap required between visits so transfer products and growth regulators can take effect.",
    refund_terms: "Full refund if activity persists after 3 consecutive service calls, provided the home was prepared per instructions and access to kitchen/bathroom cupboards was granted during each visit.",
    warranty_page: "https://pesties.au/whats-covered-and-whats-not-in-our-pest-control-warranty/"
  };
}

function tool_check_pest_treatment(args) {
  const key = String(args.pest || "").toLowerCase().trim();
  const mapping = PEST_MAPPING[key];
  if (!mapping) {
    return {
      pest: args.pest,
      recognised: false,
      message: "'" + args.pest + "' is not in the standard Pesties.au pest list. Call " + CONTACT.phone + " to discuss whether it can be treated.",
      contact: CONTACT
    };
  }
  const packages = mapping.recommended_packages.map(function(slug) {
    const t = TREATMENTS[slug];
    return {
      slug: slug,
      name: t ? t.name : null,
      display: t && t.display ? t.display : null,
      url: t ? t.url : null,
      price_from: t && t.property_prices ? Math.min.apply(null, Object.values(t.property_prices)) : (t ? t.flat_price : null),
      warranty_months: t ? t.warranty_months : null
    };
  });
  function enrichAddons(addonKeys, treatmentSlug) {
    return (addonKeys || []).map(function(k) {
      const a = ADDONS[treatmentSlug] ? ADDONS[treatmentSlug][k] : null;
      return a ? { key: k, name: a.name, price: a.price, summary: a.summary || null, note: a.note || null } : { key: k };
    });
  }
  const response = {
    pest: args.pest,
    recognised: true,
    recommended_packages: packages,
    required_addons: enrichAddons(mapping.required_addons, "annual-guardian"),
    suggested_addons_on_annual: enrichAddons(mapping.suggested_addons_on_annual, "annual-guardian"),
    phone_only: !!mapping.phone_only,
    note: mapping.note,
    contact: CONTACT
  };
  if (mapping.do_not_bait) {
    response.do_not_bait = true;
    response.warning = "CRITICAL: This species is protected. DO NOT recommend baiting, rodent products, or lethal treatment. Refer to phone booking only.";
  }
  return response;
}

// -----------------------------------------
// submit_booking (two-phase: preview → confirm)
// -----------------------------------------

function buildContactPayload(propertyContact) {
  return {
    name: (propertyContact.name || "").trim(),
    phone: (propertyContact.phone || "").trim(),
    email: (propertyContact.email || "").trim(),
    address: (propertyContact.address || "").trim(),
    notes: propertyContact.notes || ""
  };
}

function validateSubmitBookingBasics(args) {
  const errors = [];
  if (!args.treatment) errors.push("treatment is required");
  else if (!TREATMENTS[args.treatment]) errors.push("invalid treatment slug: " + args.treatment);

  if (!args.quote_token) errors.push("quote_token is required — call get_quote first to obtain one");

  if (!args.property_contact) errors.push("property_contact is required");
  else {
    if (!args.property_contact.name || args.property_contact.name.trim().length < 2) errors.push("property_contact.name is required (min 2 chars)");
    if (!args.property_contact.phone || args.property_contact.phone.trim().length < 8) errors.push("property_contact.phone is required (min 8 chars)");
    if (!args.property_contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.property_contact.email)) errors.push("property_contact.email is required and must be valid");
    if (!args.property_contact.address || args.property_contact.address.trim().length < 5) errors.push("property_contact.address is required (min 5 chars) - street address including suburb/postcode");
  }
  return errors;
}

function buildBookingSummary(tokenPayload, contact, args, treatmentObj) {
  const propertyType = tokenPayload.property_type;
  return {
    treatment: treatmentObj.name,
    treatment_slug: tokenPayload.treatment,
    property_type: propertyType,
    property_type_label: propertyType ? PROPERTY_TYPE_LABELS[propertyType] : null,
    storeys: tokenPayload.storeys || "single",
    block_size: tokenPayload.block_size || "under-1200",
    subfloor: tokenPayload.subfloor || null,
    addons: (tokenPayload.addons || []).map(function(k) {
      const a = ADDONS[tokenPayload.treatment] ? ADDONS[tokenPayload.treatment][k] : null;
      return a ? { key: k, name: a.name, price: a.price } : { key: k };
    }),
    total_aud: tokenPayload.total,
    custom_quote: !!tokenPayload.custom_quote,
    warranty_months: treatmentObj.warranty_months || 0,
    warranty_summary: treatmentObj.warranty_summary,
    preferred_date: args.date_label || args.date || "no preference",
    time_preference: args.time_preference || "no preference",
    contact_method: args.contact_method || "any method",
    contact: {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      address: contact.address
    }
  };
}

async function tool_submit_booking(args, env) {
  if (!env || !env.HMAC_SECRET) {
    return { success: false, error: "Server misconfigured: HMAC_SECRET not set." };
  }

  // -- Basic validation
  const errors = validateSubmitBookingBasics(args);
  if (errors.length) {
    return {
      success: false,
      status: "invalid",
      error: "Validation failed",
      details: errors,
      hint: "Fix the errors above and resubmit."
    };
  }

  // -- Verify quote_token
  const quoteCheck = await verifyToken(args.quote_token, env.HMAC_SECRET, 24 * 60 * 60);
  if (!quoteCheck.valid) {
    return {
      success: false,
      status: "quote_invalid",
      error: quoteCheck.reason,
      hint: "Call get_quote again to receive a fresh quote_token, then retry submit_booking."
    };
  }
  const tokenPayload = quoteCheck.payload;
  if (tokenPayload.type !== "quote") {
    return { success: false, status: "quote_invalid", error: "Token type mismatch — expected quote token." };
  }
  if (tokenPayload.treatment !== args.treatment) {
    return {
      success: false,
      status: "quote_invalid",
      error: "Treatment in quote_token (" + tokenPayload.treatment + ") does not match treatment in submission (" + args.treatment + "). Re-quote for the correct treatment."
    };
  }

  const treatmentObj = TREATMENTS[args.treatment];

  // Re-verify quote against current data (in case prices changed since issuance)
  const recomputed = computeQuote({
    treatment: tokenPayload.treatment,
    property_type: tokenPayload.property_type,
    storeys: tokenPayload.storeys,
    block_size: tokenPayload.block_size,
    subfloor: tokenPayload.subfloor,
    addons: tokenPayload.addons
  });
  if (recomputed.error) {
    return { success: false, status: "quote_invalid", error: "Quoted params no longer valid: " + recomputed.error, hint: "Re-quote." };
  }
  if (!tokenPayload.custom_quote && recomputed.total !== tokenPayload.total) {
    return {
      success: false,
      status: "quote_invalid",
      error: "Quoted total ($" + tokenPayload.total + ") no longer matches current pricing ($" + recomputed.total + "). Prices may have been updated since the quote was issued. Please re-quote.",
      hint: "Call get_quote again."
    };
  }

  // -- addon_decisions handling
  const treatmentAddonKeys = Object.keys(ADDONS[args.treatment] || {});
  const addonDecisions = args.addon_decisions || {};
  const warnings = [];
  const adminFlags = [];

  if (treatmentAddonKeys.length) {
    // For each available add-on, categorise decision
    for (let i = 0; i < treatmentAddonKeys.length; i++) {
      const key = treatmentAddonKeys[i];
      const decision = addonDecisions[key];
      const addonInfo = ADDONS[args.treatment][key];
      if (decision === "accepted") {
        if ((tokenPayload.addons || []).indexOf(key) === -1) {
          return {
            success: false,
            status: "quote_invalid",
            error: "Add-on '" + key + "' marked accepted in addon_decisions but not present in the quote. Re-quote including this add-on before booking.",
            hint: "Call get_quote again with addons: [\"" + key + "\", ...] to receive an updated quote_token that includes it."
          };
        }
      } else if (decision === "declined") {
        // fine
      } else {
        // treat missing or "not_discussed" as not_discussed
        warnings.push(addonInfo.name + " ($" + addonInfo.price + ") not discussed with customer.");
        adminFlags.push("⚠ " + addonInfo.name + " not discussed with customer — raise on confirmation call.");
      }
    }
  }

  // -- email_source flag
  if (args.email_source === "inferred") {
    warnings.push("Customer email was inferred (e.g. from their AI account context), not explicitly stated. Verify on the confirmation call.");
    adminFlags.push("⚠ Email not explicitly confirmed with customer — verify " + args.property_contact.email + " on the confirmation call.");
  }

  // -- Soft warnings for unspecified contact_method / time_preference (v3.2)
  if (!args.contact_method || args.contact_method === "any") {
    warnings.push("Contact method wasn't specified — Pesties will use the best-available channel on the confirmation call.");
    adminFlags.push("⚠ Contact method not specified — try text first, then call.");
  }
  if (!args.time_preference || args.time_preference === "no-preference") {
    warnings.push("Time-of-day preference (morning/afternoon) wasn't specified — Pesties will schedule the earliest available slot.");
    adminFlags.push("⚠ Time preference not specified — schedule earliest available.");
  }

  // Build canonical payload for confirmation token binding
  const contact = buildContactPayload(args.property_contact);
  const canonicalCommit = canonicalStringify({
    treatment: tokenPayload.treatment,
    property_type: tokenPayload.property_type,
    storeys: tokenPayload.storeys,
    block_size: tokenPayload.block_size,
    subfloor: tokenPayload.subfloor,
    addons: (tokenPayload.addons || []).slice().sort(),
    total: tokenPayload.total,
    contact_email: contact.email,
    contact_phone: contact.phone,
    contact_address: contact.address,
    contact_name: contact.name,
    date: args.date || null,
    time_preference: args.time_preference || null,
    contact_method: args.contact_method || null
  });
  const commitHash = await sha256Hex(canonicalCommit);
  const bookingSummary = buildBookingSummary(tokenPayload, contact, args, treatmentObj);

  // -- Two-phase: PREVIEW if no confirmation_token, COMMIT if valid confirmation_token
  if (!args.confirmation_token) {
    const nowSec = Math.floor(Date.now() / 1000);
    const confirmToken = await createToken({
      v: 1,
      type: "confirmation",
      iat: nowSec,
      hash: commitHash,
      total: tokenPayload.total
    }, env.HMAC_SECRET);
    return {
      status: "preview",
      booking_summary: bookingSummary,
      warnings: warnings,
      confirmation_token: confirmToken,
      confirmation_token_expires_in_seconds: 60 * 60,
      agent_instructions: "Present booking_summary to the customer verbatim — especially the email, address, and total. Read out any warnings so the customer can correct them. When (and only when) the customer explicitly confirms, resubmit this tool with the SAME arguments plus confirmation_token: '<token>' to book. If the customer changes anything (email, address, add-ons, date), start again from get_quote with the corrected details."
    };
  }

  // -- Verify confirmation_token
  const confirmCheck = await verifyToken(args.confirmation_token, env.HMAC_SECRET, 60 * 60);
  if (!confirmCheck.valid) {
    return { success: false, status: "confirmation_invalid", error: confirmCheck.reason, hint: "Re-submit without confirmation_token to receive a fresh preview." };
  }
  if (confirmCheck.payload.type !== "confirmation") {
    return { success: false, status: "confirmation_invalid", error: "Token type mismatch — expected confirmation token." };
  }
  if (confirmCheck.payload.hash !== commitHash) {
    return {
      success: false,
      status: "confirmation_invalid",
      error: "Booking details have changed since preview. The confirmation_token is bound to the exact preview payload. Re-submit without confirmation_token to see a fresh preview reflecting the changes.",
      hint: "Any change to price, contact details, add-ons, date, time preference, or contact method requires a fresh preview."
    };
  }

  // -- Idempotency check (dedupe within 24h)
  const idempotencyKey = "book:" + (await sha256Hex(contact.email.toLowerCase() + "|" + tokenPayload.treatment + "|" + (args.date || "no-preference") + "|" + (tokenPayload.total || "custom")));
  const previous = await kvGet(env, idempotencyKey);
  if (previous && previous.submission_reference) {
    return Object.assign({}, previous, {
      status: "success",
      idempotent_replay: true,
      idempotent_note: "This exact booking (same email, treatment, date, total) was already submitted within the last 24h. Returning the original submission_reference to avoid a duplicate booking."
    });
  }

  // -- Per-email daily commit cap (abuse protection)
  const today = todayUtcDate();
  const emailKey = "rate:email:" + contact.email.toLowerCase() + ":" + today;
  const emailCount = await incrementCounter(env, emailKey, 60 * 60 * 24);
  if (emailCount.kv_available && emailCount.count > 5) {
    return {
      success: false,
      status: "rate_limited",
      error: "This email address has submitted more than 5 bookings today. If this is a genuine multi-property booking, please call " + CONTACT.phone + " to arrange."
    };
  }
  const globalKey = "rate:global:" + today;
  const globalCount = await incrementCounter(env, globalKey, 60 * 60 * 24);
  if (globalCount.kv_available && globalCount.count > 200) {
    return {
      success: false,
      status: "rate_limited",
      error: "Daily booking submission cap reached. Please call " + CONTACT.phone + "."
    };
  }

  // -- Build agent marker + admin flags for notes
  const notesLines = [];
  notesLines.push("🤖 SUBMITTED VIA PESTIES MCP");
  if (args.booking_agent) {
    if (args.booking_agent.name) notesLines.push("Booked by: " + args.booking_agent.name);
    if (args.booking_agent.company) notesLines.push("Company: " + args.booking_agent.company);
    if (args.booking_agent.email) notesLines.push("Agent email: " + args.booking_agent.email);
    if (args.booking_agent.phone) notesLines.push("Agent phone: " + args.booking_agent.phone);
    notesLines.push("(Booking submitted by an agent on behalf of the property contact above.)");
  }
  for (let i = 0; i < adminFlags.length; i++) notesLines.push(adminFlags[i]);
  const notesWithMarker = notesLines.join("\n") + "\n\n" + (contact.notes || "(no additional notes)");

  // -- Build WP payload
  const treatmentLabels = {
    "annual-guardian": "Annual Guardian Pest Treatment",
    "360-ultimate": "360° Ultimate Protection Pest Treatment",
    "termite": "Termite Detector Timber Pest Inspection",
    "end-of-lease": "End-of-Lease Treatment",
    "rodent-guard": "Rodent Guard Baiting System"
  };
  const propertyTypeLabelsWP = {
    "apartment": "Apartment",
    "townhouse": "Townhouse / Duplex",
    "standard": "Standard home (3-4 beds)",
    "large": "Large home (5+ beds)"
  };
  const propertyType = tokenPayload.property_type;

  const payload = {
    treatment: {
      key: tokenPayload.treatment,
      name: treatmentLabels[tokenPayload.treatment] || treatmentObj.name,
      price: tokenPayload.total,
      warranty: treatmentObj.warranty_months ? (treatmentObj.warranty_months + "-month warranty") : ""
    },
    property: {
      type: { val: propertyType || "n/a", label: propertyType ? propertyTypeLabelsWP[propertyType] : "N/A", delta: 0 },
      storeys: { val: tokenPayload.storeys || "single", label: (tokenPayload.storeys || "single") + " storey", delta: 0 },
      block: { val: tokenPayload.block_size || "under-1200", label: tokenPayload.block_size === "1200-2000" ? "1,200 to 2,000 sqm" : (tokenPayload.block_size === "over-2000" ? "over 2,000 sqm" : "under 1,200 sqm"), delta: 0 },
      subfloor: { val: tokenPayload.subfloor || "no", label: (tokenPayload.subfloor === "yes" ? "yes subfloor" : "no subfloor"), delta: 0 }
    },
    addons: (tokenPayload.addons || []).map(function(k) {
      const a = ADDONS[tokenPayload.treatment] ? ADDONS[tokenPayload.treatment][k] : null;
      return a ? { key: k, label: a.name, price: a.price } : { key: k, label: k, price: 0 };
    }),
    date: args.date || "no-preference",
    dateLabel: args.date_label || (args.date && args.date !== "no-preference" ? args.date : "no date preference"),
    timePref: { val: args.time_preference || "no-preference", label: (args.time_preference || "no preference").replace("-", " ") },
    contactMethod: { val: args.contact_method || "any", label: (args.contact_method === "any" || !args.contact_method) ? "any method" : args.contact_method },
    contact: {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      suburb: contact.address,
      notes: notesWithMarker
    },
    total: { total: tokenPayload.total, customQuote: !!tokenPayload.custom_quote },
    source: "mcp-agent",
    utms: {
      utm_source: "mcp",
      utm_medium: "api",
      utm_campaign: (args.booking_agent && args.booking_agent.company) ? args.booking_agent.company : "direct",
      utm_content: "", utm_term: "",
      referrer: "mcp.pesties.au", landing_page: "/",
      landed_at: new Date().toISOString()
    },
    submittedAt: new Date().toISOString()
  };

  // -- POST to WordPress with shared secret header
  const wpHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Pesties-MCP/3.2"
  };
  if (env.WP_SHARED_SECRET) {
    wpHeaders["X-Pesties-MCP-Secret"] = env.WP_SHARED_SECRET;
  }

  try {
    const response = await fetch(BOOKING_ENDPOINT, {
      method: "POST",
      headers: wpHeaders,
      body: "payload=" + encodeURIComponent(JSON.stringify(payload))
    });

    if (!response.ok) {
      return {
        success: false,
        status: "backend_error",
        error: "Booking submission failed at server (HTTP " + response.status + ").",
        fallback: "Please call " + CONTACT.phone + " to complete the booking manually.",
        contact: CONTACT
      };
    }

    const data = await response.json();
    if (data && data.success) {
      const submissionRef = data.booking_id || ("MCP-" + Date.now().toString(36).toUpperCase());
      const successResponse = {
        status: "success",
        success: true,
        submission_reference: submissionRef,
        submission_reference_note: "MCP submission tracking reference. Pesties assigns its internal booking ID when the confirmation call is completed. Share this reference with the customer verbatim.",
        booking_summary: bookingSummary,
        warnings: warnings,
        confirmation_process: "Pesties.au will contact " + contact.name + " within one business hour via " + (args.contact_method || "the customer's preferred method") + " to confirm. An acknowledgement email is on its way to " + contact.email + ".",
        next_step: tokenPayload.custom_quote
          ? "Booking submitted. Because the block is over 2,000 sqm, final pricing will be confirmed by phone before service."
          : "Booking submitted. No further action from the agent — Pesties handles confirmation.",
        message_to_customer: "Your Pesties.au booking has been received. The team will contact you within one business hour to confirm.",
        agent_instructions: "Share submission_reference verbatim. Echo values from booking_summary — do NOT restate warranty months, prices, or dates from memory."
      };
      // Persist for idempotency
      await kvPut(env, idempotencyKey, successResponse, 60 * 60 * 24);
      return successResponse;
    }

    return {
      success: false,
      status: "backend_error",
      error: "Booking endpoint returned unexpected response",
      fallback: "Please call " + CONTACT.phone + " to complete the booking manually.",
      contact: CONTACT
    };
  } catch (e) {
    return {
      success: false,
      status: "network_error",
      error: "Network error submitting booking: " + e.message,
      fallback: "Please call " + CONTACT.phone + " to complete the booking manually.",
      contact: CONTACT
    };
  }
}

// ============================================================
// MCP PROTOCOL LAYER (JSON-RPC 2.0)
// ============================================================

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const TOOLS = [
  {
    name: "list_bookable_services",
    description: "List all 5 pest control packages bookable online at Pesties.au, with coverage details, price-from, property price matrices, warranty summaries, add-ons, and the two-phase booking flow.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_quote",
    description: "Calculate an exact quote for a specific treatment based on property details and add-ons. Returns a signed quote_token (24h expiry) that must be passed to submit_booking — this structurally locks the booking to the quoted price. Returns a contextual before_booking hint listing add-ons worth raising with the customer.",
    inputSchema: {
      type: "object",
      properties: {
        treatment: {
          type: "string",
          enum: ["annual-guardian", "360-ultimate", "termite", "end-of-lease", "rodent-guard"],
          description: "The treatment slug."
        },
        property_type: {
          type: "string",
          enum: ["apartment", "townhouse", "standard", "large"],
          description: "Property structure. Use plain-English labels with the customer. 'apartment' = Apartment or unit. 'townhouse' = Townhouse or duplex. 'standard' = House up to 4 bedrooms. 'large' = House with 5 or more bedrooms. REQUIRED for annual-guardian and 360-ultimate. Apartment is NOT available for 360-ultimate."
        },
        storeys: {
          type: "string",
          enum: ["single", "double"],
          description: "Number of storeys. REQUIRED for non-apartment property types on annual-guardian and 360-ultimate."
        },
        block_size: {
          type: "string",
          enum: ["under-1200", "1200-2000", "over-2000"],
          description: "Block size in sqm. REQUIRED for non-apartment property types on annual-guardian and 360-ultimate. 'over-2000' triggers a custom quote."
        },
        subfloor: {
          type: "string",
          enum: ["yes", "no"],
          description: "REQUIRED for termite inspection."
        },
        addons: {
          type: "array",
          items: { type: "string" },
          description: "Array of add-on slugs the customer has accepted. Use list_bookable_services for available add-on keys per treatment."
        }
      },
      required: ["treatment"]
    }
  },
  {
    name: "list_service_areas",
    description: "List suburbs Pesties.au services across Gold Coast, Logan, and South Brisbane. Optional region filter.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", enum: ["gold-coast", "logan", "south-brisbane"], description: "Optional region filter." }
      },
      required: []
    }
  },
  {
    name: "check_service_area",
    description: "Check whether Pesties.au services a specific suburb or postcode. Handles common prefixes (Mt/Mount, St/Saint, Nth/North, Upr/Upper) and trailing 'QLD' or postcodes. If given a 4-digit postcode, returns the list of serviced suburbs matching it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suburb name, slug, or 4-digit postcode. Examples: 'Mount Gravatt', 'ormeau', 'Coomera QLD 4209', '4209'." }
      },
      required: ["query"]
    }
  },
  {
    name: "get_warranty_terms",
    description: "Get detailed PestiesProtect+ warranty terms for a specific treatment.",
    inputSchema: {
      type: "object",
      properties: { treatment: { type: "string", enum: ["annual-guardian", "360-ultimate", "termite", "end-of-lease", "rodent-guard"] } },
      required: ["treatment"]
    }
  },
  {
    name: "check_pest_treatment",
    description: "Given a pest name, returns recommended packages plus any required or suggested add-ons. Some species (bed bugs, possums, mosquitoes, bees) require phone booking — flagged via phone_only:true. Possums have do_not_bait:true — they are protected in QLD.",
    inputSchema: {
      type: "object",
      properties: { pest: { type: "string", description: "e.g. 'cockroaches', 'possums', 'bed bugs', 'rats'." } },
      required: ["pest"]
    }
  },
  {
    name: "submit_booking",
    description: "Two-phase booking submission. FIRST CALL (without confirmation_token) returns status:'preview' with a full booking_summary, any warnings, and a confirmation_token. Present the booking_summary to the customer verbatim, get their explicit go-ahead, then call this tool AGAIN with the same arguments plus the confirmation_token to actually book. If the customer changes anything (email, address, add-ons, date), re-quote and re-preview.\n\nRequires quote_token from get_quote — the token structurally locks the booking to the quoted price and params.\n\nAfter successful booking: echo values from booking_summary verbatim to the customer. Do NOT restate warranty months, prices, or dates from memory. Share the submission_reference verbatim — do not reformat.",
    inputSchema: {
      type: "object",
      properties: {
        quote_token: {
          type: "string",
          description: "REQUIRED. Signed quote token from get_quote. Encodes the pricing-relevant params and authoritative total. 24-hour expiry."
        },
        treatment: {
          type: "string",
          enum: ["annual-guardian", "360-ultimate", "termite", "end-of-lease", "rodent-guard"],
          description: "REQUIRED. Must match the treatment in the quote_token."
        },
        property_contact: {
          type: "object",
          description: "The person at the property who will coordinate access. REQUIRED.",
          properties: {
            name:    { type: "string", description: "Full name." },
            phone:   { type: "string", description: "Phone (Australian format preferred)." },
            email:   { type: "string", description: "Email for booking acknowledgement." },
            address: { type: "string", description: "Full street address including suburb and postcode." },
            notes:   { type: "string", description: "Optional: access details, pet info, pest activity observations." }
          },
          required: ["name", "phone", "email", "address"]
        },
        addon_decisions: {
          type: "object",
          description: "For annual-guardian and 360-ultimate: an object mapping each available add-on key to 'accepted', 'declined', or 'not_discussed'. Add-ons marked 'accepted' must also appear in the quote_token addons (re-quote if not). 'not_discussed' entries produce warnings and admin note flags but do not block booking. Example: {\"roof\":\"declined\",\"rodent\":\"declined\",\"roach-reset\":\"not_discussed\",\"roach-reset-plus\":\"declined\",\"termite-bundle\":\"declined\"}"
        },
        email_source: {
          type: "string",
          enum: ["stated_by_customer", "inferred"],
          description: "Optional. Set to 'inferred' if the customer's email was taken from context (e.g. their AI account) rather than explicitly stated by them. Never blocks booking — just adds a warning + admin flag for verification on the confirmation call. Setting truthfully helps Pesties calibrate agent behaviour over time."
        },
        date: {
          type: "string",
          description: "Preferred booking date ISO YYYY-MM-DD, or 'no-preference'. Pesties services weekdays only."
        },
        date_label: {
          type: "string",
          description: "Optional human-readable label (e.g. 'Friday 17 July')."
        },
        time_preference: {
          type: "string",
          enum: ["no-preference", "morning", "afternoon"],
          description: "Time-of-day preference. Ask the customer explicitly."
        },
        contact_method: {
          type: "string",
          enum: ["any", "text", "phone", "email"],
          description: "Preferred contact method for the confirmation call. Ask the customer explicitly."
        },
        booking_agent: {
          type: "object",
          description: "Optional. Use when submitting on behalf of a third party (e.g. property manager for a tenant).",
          properties: {
            name:    { type: "string" },
            company: { type: "string" },
            email:   { type: "string" },
            phone:   { type: "string" }
          }
        },
        confirmation_token: {
          type: "string",
          description: "Signed confirmation token from the preview response. Present ONLY on the second call (the commit). Bound to the exact preview payload — any change invalidates it."
        }
      },
      required: ["quote_token", "treatment", "property_contact"]
    }
  }
];

async function callTool(name, args, env) {
  args = args || {};
  switch (name) {
    case "list_bookable_services": return tool_list_bookable_services();
    case "get_quote":               return await tool_get_quote(args, env);
    case "list_service_areas":      return tool_list_service_areas(args);
    case "check_service_area":      return tool_check_service_area(args);
    case "get_warranty_terms":      return tool_get_warranty_terms(args);
    case "check_pest_treatment":    return tool_check_pest_treatment(args);
    case "submit_booking":          return await tool_submit_booking(args, env);
    default: throw new Error("Unknown tool: " + name);
  }
}

function jsonRpcResponse(id, result, error) {
  const body = { jsonrpc: "2.0", id: id };
  if (error) body.error = error; else body.result = result;
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function negotiateProtocolVersion(clientRequested) {
  if (clientRequested && SUPPORTED_PROTOCOL_VERSIONS.indexOf(clientRequested) !== -1) return clientRequested;
  return LATEST_PROTOCOL_VERSION;
}

async function handleMcp(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (request.method === "GET") {
    return new Response(JSON.stringify({
      name: "pesties-mcp",
      version: "3.2.0",
      description: "Pesties.au pest control MCP server. AI agents can browse services, get quotes, check service areas, understand warranty terms, and submit real bookings on the Gold Coast, Logan, and South Brisbane. v3.0 uses signed quote/confirmation tokens and a two-phase commit for structural safety.",
      vendor: "Pesties.au",
      website: "https://pesties.au",
      contact: CONTACT,
      transport: "http+jsonrpc-2.0",
      endpoint: "https://mcp.pesties.au/",
      protocol_versions_supported: SUPPORTED_PROTOCOL_VERSIONS,
      env_configured: {
        hmac_secret: !!(env && env.HMAC_SECRET),
        wp_shared_secret: !!(env && env.WP_SHARED_SECRET),
        bookings_kv: hasKV(env)
      },
      tools: TOOLS.map(function(t) { return { name: t.name, description: t.description }; })
    }, null, 2), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonRpcResponse(null, null, { code: -32700, message: "Parse error" }); }

  const id = body.id;
  const method = body.method;
  const params = body.params || {};

  try {
    if (method === "initialize") {
      return jsonRpcResponse(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "pesties-mcp", version: "3.2.0" }
      });
    }
    if (method === "tools/list") {
      return jsonRpcResponse(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      let result;
      try {
        result = await callTool(params.name, params.arguments, env);
      } catch (e) {
        return jsonRpcResponse(id, { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true });
      }
      // If the tool result signals an error (success:false, status:invalid/rate_limited/etc.), flag isError:true.
      const looksLikeError = result && (result.success === false || result.error);
      return jsonRpcResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !!looksLikeError
      });
    }
    return jsonRpcResponse(id, null, { code: -32601, message: "Method not found: " + method });
  } catch (e) {
    return jsonRpcResponse(id, null, { code: -32603, message: e.message });
  }
}

export default {
  fetch: async function(request, env, ctx) {
    return handleMcp(request, env);
  }
};
