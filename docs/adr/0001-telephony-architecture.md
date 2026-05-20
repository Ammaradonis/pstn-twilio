# ADR-0001: Telephony architecture for pstn-twilio

- **Status:** Accepted
- **Date:** 2026-05-19
- **Deciders:** Project owner (single-owner deployment for v1)
- **Sources:** See [RESEARCH.md](../RESEARCH.md) entries cited inline below.

## Context

The product is a single-owner web app that provisions Twilio phone numbers,
shows their SMS inbox and call log, and lets the owner answer inbound PSTN
calls in the browser and place outbound PSTN calls from the browser using a
selected Twilio caller ID. Phase 1 of the project plan requires a written
architecture decision record covering the five questions below.

## Decision

### 1. Why Twilio Voice JavaScript SDK instead of SIP.js / JsSIP

The Twilio Voice JS SDK (`@twilio/voice-sdk` v2) is the supported way to register
a WebRTC client against Twilio's media/signaling infrastructure (RESEARCH.md #7).
It transparently:

- Negotiates DTLS-SRTP media (`AES_CM_128_HMAC_SHA1_80`) and TLS-over-WSS signaling.
- Authenticates with short-lived Access Tokens carrying a `VoiceGrant`
  (`outgoing_application_sid` pointing to our TwiML App, `identity` for inbound
  routing — RESEARCH.md #8, #9).
- Emits a clean event surface (`registered`, `unregistered`, `incoming`,
  `tokenWillExpire`, `error`) that maps directly onto React hooks.
- Handles edge selection / latency-based routing so we don't run a media relay.
- Is supported by Twilio for the current and N-2 desktop browser versions
  (RESEARCH.md #22).

A raw SIP.js / JsSIP integration would force us to:

- Run or rent a SIP trunk and credentials separate from the Twilio account.
- Implement our own ICE / STUN / TURN logic and DTLS-SRTP negotiation.
- Re-implement authentication, registration, ringback, mute, hold, edge
  selection, and reconnection.
- Maintain a parallel signaling channel for app-level state.

That work is large, error-prone, and gains us nothing the Voice SDK doesn't
already deliver against Twilio's network. The Voice SDK is the right level of
abstraction for "softphone in the browser, terminated by Twilio".

**Decision:** Use `@twilio/voice-sdk`. SIP.js / JsSIP are out of scope.

### 2. Why backend TwiML webhooks control call routing

Twilio decides what to do with a call by fetching TwiML from a URL we host
(RESEARCH.md #6, #10). That URL is the single point where call routing is
expressed, which means:

- Authorization lives on the server. The outbound webhook
  (`/webhooks/twilio/voice/outbound`) inspects the authenticated identity's
  ownership of the requested caller-ID Twilio number before emitting
  `<Dial callerId="...">`. If we let the browser construct the TwiML or call
  the Twilio REST API directly, a compromised browser session would be able to
  dial from any number on the account.
- Identity-to-number mapping for inbound is deterministic and auditable. The
  inbound webhook (`/webhooks/twilio/voice/inbound`) maps `To` to a stored
  identity and returns `<Dial><Client>{identity}</Client></Dial>`.
- All status callbacks land on the same backend, which is the only place that
  can update the `calls` table and emit WebSocket events.
- Twilio signature validation (RESEARCH.md #13) is enforced once, in a single
  NestJS guard, on every webhook controller. The frontend never sees raw
  Twilio requests and never needs to.

**Decision:** Twilio's Voice URL (for the TwiML App) and each IncomingPhoneNumber's
Voice URL both point at backend NestJS controllers. The browser only ever calls
our typed REST API (`POST /api/voice/token`, `GET /api/numbers/...`); it never
calls Twilio's REST API directly.

### 3. Why no FreePBX, Zoiper, or VPS PBX

These tools solve a different problem — running your own PBX that terminates
SIP trunks from upstream carriers. In our architecture Twilio **is** the carrier
and PBX combined, exposed to us via the Voice SDK and TwiML. Layering FreePBX
or a VPS SIP server in front of Twilio would:

- Add an extra hop with its own outages, scaling, and security posture.
- Force us to operate Asterisk / FreeSWITCH / a TURN server in production.
- Duplicate features (recording, IVR, call routing) that TwiML expresses cleanly.
- Make the X-Twilio-Signature URL validation harder (the public URL Twilio uses
  must match what we validate — RESEARCH.md #13 — and PBX-in-the-middle
  rewrites make that brittle).
- Increase the attack surface enormously.

Zoiper is a desktop softphone. The project requirement is a _browser_ softphone
on the owner's account, integrated with the SMS inbox and call log UI. A native
softphone is not a substitute.

**Decision:** No FreePBX, no Asterisk/FreeSWITCH, no VPS PBX, no Zoiper. The
browser is the softphone, Twilio is the network. If a future requirement needs
features the Voice SDK genuinely cannot express, this ADR will be revisited.

### 4. Why WhatsApp compatibility cannot be guaranteed

Three independent reasons (RESEARCH.md #16, #17):

1. **Meta controls eligibility, not Twilio.** WhatsApp's own help center lists
   VoIP, toll-free, paid premium, and universal access numbers as not supported
   on consumer WhatsApp. Landlines are unsupported on consumer WhatsApp but
   permitted on WhatsApp Business with caveats. Twilio numbers are issued from
   carrier pools whose underlying classification (geographic / mobile / VoIP /
   toll-free) varies by country and even by area code, and Meta's matching of
   number → eligibility is not a public, deterministic function.
2. **WhatsApp Business sender registration is a separate KYC flow** via a Meta
   Business Manager + WABA. Owning a number on Twilio does not register it
   with Meta; sending business messages requires onboarding, optional Meta
   Business verification, and template approval. Unverified business managers
   are capped at 2 numbers per WABA. None of that happens automatically when
   we purchase a Twilio number.
3. **Account standing and policy change.** Even an eligible number can be
   blocked by Meta for spam / policy reasons, and WhatsApp's policy surface
   (consumer vs Business, supported regions, supported number types) shifts
   over time.

Consequently the codebase treats WhatsApp compatibility as **never inferred**.
The `phone_numbers.whatsapp_compatibility_status` enum defaults to `UNKNOWN`,
the only way to reach `APPROVED_BUSINESS_SENDER` is a manual admin action
confirming the sender is live in Meta, and the UI displays this exact copy on
the number-search and number-detail pages:

> WhatsApp compatibility is not guaranteed. Some VoIP, toll-free, landline, or
> virtual numbers may be unsupported by WhatsApp / Meta.

The codebase explicitly does **not** implement WhatsApp account auto-creation,
OTP scraping, or any tooling that would suggest the app circumvents
WhatsApp/Meta verification — both because such tooling would violate Meta's
policies and Twilio's AUP, and because it is outside the scope of a
legitimate Twilio PSTN/messaging app.

### 5. Number types supported by the first release

Based on RESEARCH.md #2, #3, #5, #15:

- **Supported in v1:**
  - **Local** numbers in countries whose AvailablePhoneNumbers Local sub-resource
    returns numbers with `addressRequirements="none"`. Empirically that
    covers most NANP (US, CA), GB, NL, SE, DK, AU, and similar
    light-regulation jurisdictions — the available-list endpoint is the
    source of truth, not a hard-coded country list.
  - **Mobile** numbers in countries where the Mobile sub-resource returns
    numbers with `addressRequirements="none"` (e.g. UK mobile prefixes).
  - **TollFree** numbers in NANP, with a UI warning that toll-free SMS to US
    destinations requires Twilio's A2P verification before delivery is
    reliable.
- **Not supported in v1:**
  - Numbers with `addressRequirements != "none"` (typical for DE, FR, IT, JP,
    and similar strict-regulation jurisdictions). These require a Twilio
    Regulatory Bundle which the v1 UI does not build. The search response
    excludes them by default; the user can opt in via a toggle that surfaces a
    "complete the regulatory bundle in the Twilio Console" notice and disables
    the purchase button.
  - Short codes, alphanumeric sender IDs, SIP trunks, Hosted SMS, and the
    Bundle/EndUser/SupportingDocument creation flows. All are deferred to a
    future release.
- **WhatsApp:** treated as an out-of-band, manually-confirmed property of an
  already-purchased number, never an inferred capability. See section 4 above.

## Consequences

- The backend is the only authorization gate for outbound calls and SMS.
- Cloudflare Pages hosts the frontend; the backend runs on a Node-friendly
  host (Fly.io / Render / Railway) at `api.webfitalchemist.online` fronted by
  Cloudflare DNS only, because Cloudflare Workers cannot host a persistent
  NestJS + Socket.IO server (RESEARCH.md #18). This split is recorded here
  as a knock-on of the "backend controls routing" decision and will be
  finalized operationally in Phase 10.
- The Voice JS SDK's mobile-browser caveat means the owner is expected to
  answer browser calls on a desktop; the UI surfaces a banner on mobile.
- We accept Twilio vendor lock-in. Migrating away from Twilio would require
  replacing both the routing surface (TwiML) and the browser SDK; that risk
  is acknowledged and is a deliberate consequence of using the SDK rather
  than rolling our own SIP stack.

## Alternatives considered

- **SIP.js / JsSIP directly against Twilio SIP Domains:** technically possible
  but loses the SDK's edge selection, automatic ICE handling, and supported
  event API. Not chosen — see section 1.
- **Cloudflare Workers + Durable Objects for the backend:** ruled out because
  NestJS expects a long-lived Node process and Socket.IO is not supported on
  Workers. Durable-Objects-only WebSockets would mean rewriting the realtime
  layer in a Workers-native style; out of scope for v1.
- **Direct Twilio REST calls from the browser using restricted API Keys:**
  rejected because authorization (which Twilio number is the caller allowed
  to dial from) must be enforced on a trusted server. Restricted API Keys
  also cannot mint Access Tokens (RESEARCH.md #8).
- **Treating WhatsApp as a Twilio number capability:** rejected — Meta, not
  Twilio, controls eligibility, and v1 does not register WABAs. See section 4.
