# RESEARCH.md — Phase 1: Documentation & Policy Validation

This document is the Phase-1 deliverable for the `pstn-twilio` project. It cites the
official sources used to make every Twilio / infrastructure choice in the rest of the
plan. Each entry follows the template:

- **Source title**
- **Source URL**
- **Date accessed**
- **Summary**
- **Implementation implication**
- **Compliance warning** (when applicable)

All entries were accessed and verified on **2026-05-19** unless otherwise noted.

---

## 1. Twilio AvailablePhoneNumbers — Country resource

- **Source title:** _AvailablePhoneNumber resource_ (top-level country resource)
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/api/availablephonenumber-resource>
- **Date accessed:** 2026-05-19
- **Summary:** AvailablePhoneNumbers is a hierarchical resource. `GET /2010-04-01/Accounts/{AccountSid}/AvailablePhoneNumbers.json` returns the list of countries Twilio sells in. `GET .../AvailablePhoneNumbers/{CountryCode}.json` returns that country's `subresource_uris` (`local`, `mobile`, `toll_free`, etc.).
- **Implementation implication:** The backend `GET /api/phone-number-options/countries` endpoint will proxy this list rather than hard-coding countries; the per-country sub-resource list determines which number-type options the UI offers (a country may not have, e.g., Mobile).
- **Compliance warning:** Some countries appear in the list but require regulatory bundles before purchase. See entry #13.

## 2. Twilio AvailablePhoneNumbers — Local sub-resource

- **Source title:** _AvailablePhoneNumberLocal resource_
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource>
- **Date accessed:** 2026-05-19
- **Summary:** `GET /AvailablePhoneNumbers/{CountryCode}/Local.json` supports filters: `areaCode` (US/Canada only), `contains` (digits/letters/`*`/`%`/`+`/`$`), `inRegion`, `inLocality`, `inPostalCode`, `inLata`, `inRateCenter`, `nearNumber`, `nearLatLong`, `distance`, `smsEnabled`, `voiceEnabled`, `mmsEnabled`, `faxEnabled`, `excludeAllAddressRequired`, `excludeLocalAddressRequired`, `excludeForeignAddressRequired`, `beta`. Response items expose `phoneNumber` (E.164), `friendlyName`, `locality`, `region`, `postalCode`, `isoCountry`, `lata`, `rateCenter`, `addressRequirements` (`none`/`any`/`local`/`foreign`), `beta`, and a `capabilities` object (`voice`, `sms`, `mms`, `fax`).
- **Implementation implication:** The frontend search form must expose Country, Number Type, Area Code (when NANP), Contains, and three capability toggles (Voice / SMS / MMS). The backend maps these one-to-one to the Local search params and the analogous Mobile and TollFree resources. Result rows persisted into `number_searches` for audit; `addressRequirements` is surfaced as a regulatory badge in the UI.
- **Compliance warning:** `beta` numbers can be returned by default — the UI must label them clearly.

## 3. Twilio AvailablePhoneNumbers — Mobile and TollFree sub-resources

- **Source title:** _AvailablePhoneNumber{Mobile,TollFree} resource_ (mirror of Local with type-specific carrier behavior)
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/api/availablephonenumber-resource> (root) and the Local entry above
- **Date accessed:** 2026-05-19
- **Summary:** Mobile and TollFree sub-resources accept the same filter shape as Local but return numbers whose carrier classification differs. TollFree numbers are typically NANP `8XX` numbers; Mobile is most relevant outside North America.
- **Implementation implication:** Single backend endpoint `GET /api/numbers/available` with a `type` query parameter (`local|mobile|toll_free`) selects the sub-resource. The number-type enum stored in `phone_numbers.number_type` mirrors this.
- **Compliance warning:** TollFree numbers in the US require A2P verification before they can send SMS to US destinations; surface this in the purchase confirmation modal.

## 4. Twilio IncomingPhoneNumber resource

- **Source title:** _IncomingPhoneNumber resource_
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource>
- **Date accessed:** 2026-05-19
- **Summary:** Purchase is `POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json` with **either** `phoneNumber` (E.164, taken from an AvailablePhoneNumbers result) **or** `areaCode`. Writable fields include `friendlyName`, `voiceUrl`, `voiceMethod`, `voiceFallbackUrl`, `voiceFallbackMethod`, `voiceApplicationSid`, `statusCallback`, `statusCallbackMethod`, `smsUrl`, `smsMethod`, `smsFallbackUrl`, `smsFallbackMethod`, `smsApplicationSid`, `trunkSid`, `identitySid`, `addressSid`, `emergencyAddressSid`, `bundleSid`, `voiceReceiveMode`. The response includes a `capabilities` object (`voice`/`sms`/`mms`/`fax`, booleans) determined by Twilio/the carrier. Release is `DELETE /IncomingPhoneNumbers/{Sid}.json`.
- **Implementation implication:** The `PhoneNumbersService.purchase()` method posts `phoneNumber` (specific number chosen by the user — never `areaCode`, to avoid surprise selection) plus all five webhook URLs derived from `TWILIO_WEBHOOK_BASE_URL`. The returned `sid` is persisted to `phone_numbers.twilio_incoming_phone_number_sid`; capabilities are persisted to dedicated boolean columns. Release deletes the resource and writes an audit log.
- **Compliance warning:** Twilio docs explicitly warn that a deleted number may be reassigned to another customer. The UI must require a typed-confirmation modal before calling `release`.

## 5. Twilio IncomingPhoneNumber capabilities

- **Source title:** _IncomingPhoneNumber resource — Capabilities_
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource>
- **Date accessed:** 2026-05-19
- **Summary:** `capabilities.voice`, `.sms`, `.mms`, `.fax` are set by Twilio at the carrier level and **cannot be enabled by the user**. A number without `sms=true` cannot send SMS, period — the only fix is to release the number and buy a different one with the required capability.
- **Implementation implication:** Server-side guards in the Messages and Calls modules must check the persisted capability booleans before attempting to send. The UI must not offer the "Send SMS" composer on a number with `capabilities_sms=false`.
- **Compliance warning:** N/A.

## 6. Twilio Programmable Voice — overview

- **Source title:** _Programmable Voice_
- **Source URL:** <https://www.twilio.com/docs/voice>
- **Date accessed:** 2026-05-19
- **Summary:** Programmable Voice is Twilio's PSTN-bridging product. When a Twilio number receives a call, Twilio fetches TwiML from the configured Voice URL; when a Voice SDK client calls `device.connect()`, Twilio fetches TwiML from the TwiML App's Voice URL. Status callbacks deliver lifecycle events.
- **Implementation implication:** Every inbound and outbound PSTN call in this app passes through one of two backend TwiML endpoints (`/webhooks/twilio/voice/inbound` and `/webhooks/twilio/voice/outbound`). The backend is therefore the routing brain; the frontend never decides routing.
- **Compliance warning:** Calls must use a valid `callerId` that the account owns or has verified. The backend rejects any outbound TwiML generation where the requesting user does not own the selected Twilio number.

## 7. Twilio Voice JavaScript SDK

- **Source title:** _Voice JavaScript SDK_ and _Best practices_
- **Source URLs:** <https://www.twilio.com/docs/voice/sdks/javascript>, <https://www.twilio.com/docs/voice/sdks/javascript/best-practices>
- **Date accessed:** 2026-05-19
- **Summary:** Current package is `@twilio/voice-sdk` (v2.x). The `Twilio.Device` class is constructed with an Access Token, then `device.register()` puts it online to receive inbound calls. Events of interest: `registered`, `unregistered`, `incoming`, `error`, `tokenWillExpire`, `destroyed`. Outbound calls use `device.connect({ params })`. Security: TLS for signaling, DTLS-SRTP with `AES_CM_128_HMAC_SHA1_80` for media. Supported browsers: current and N-2 versions of Chrome, Firefox, Safari, Edge on desktop; iOS/Android browser support is limited and mobile background reception is unreliable.
- **Implementation implication:** Frontend `useVoiceDevice()` hook initializes a single Device per logged-in user, refreshes the token on `tokenWillExpire`, calls `device.register()` after token retrieval, and shows registration state in the global connection indicator. Mobile users get a banner recommending desktop usage. Pre-flight `getUserMedia({audio:true})` is called on the dial/answer pages to surface permission errors early. We accept the React+Vite tooling implication that `@twilio/voice-sdk` ships ESM and works directly in modern Vite without polyfills.
- **Compliance warning:** Browser microphone permission must be obtained at the user gesture (button click). The UI must display an explicit "requesting microphone" state.

## 8. Twilio Access Tokens & Voice grants

- **Source title:** _Access Tokens_
- **Source URL:** <https://www.twilio.com/docs/iam/access-tokens>
- **Date accessed:** 2026-05-19
- **Summary:** Access Tokens are HS256-signed JWTs. Required claims: `iss` = API Key SID, `sub` = Account SID, `exp` (max 24h), `identity`, `grants`. A Voice grant carries `incoming_allow` (boolean), `outgoing_application_sid` (the TwiML App SID), and `push_credential_sid` (mobile only). Restricted API Keys cannot mint access tokens — must be Main or Standard. Tokens **must** be generated server-side; client-side generation would leak the API Key Secret.
- **Implementation implication:** Backend `POST /api/voice/token` is the only path that uses `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`. It returns a token with TTL ≤ 1 hour (well below the 24h max) plus `identity` and `expiresAt`. The frontend never sees the API Key Secret. The chosen identity scheme is `owner_main` for v1 (single-owner deployment); routed to a per-number identity in v2 if/when multi-user is enabled.
- **Compliance warning:** Tokens transmitted over HTTPS only; logged tokens are forbidden (see SECURITY.md handler).

## 9. TwiML Application (App SID)

- **Source title:** _Application resource (TwiML App)_
- **Source URL:** <https://www.twilio.com/docs/usage/api/applications>
- **Date accessed:** 2026-05-19
- **Summary:** A TwiML Application (SID prefix `AP`) is a reusable container of webhook URLs (`voice_url`, `voice_method`, `voice_fallback_url`, `voice_fallback_method`, `status_callback`, `status_callback_method`, `sms_url` and friends, `voice_caller_id_lookup`, `message_status_callback`). The App SID is referenced by Voice access tokens via `VoiceGrant.outgoing_application_sid`; when the browser calls `device.connect()`, Twilio POSTs to that App's `voice_url`. Accounts can hold up to 1000 Applications.
- **Implementation implication:** Provisioning script (`scripts/twilio-sync.ts` — Phase 10) creates one TwiML App named `pstn-twilio-${env}` whose `voice_url` is `${TWILIO_WEBHOOK_BASE_URL}/webhooks/twilio/voice/outbound`. The SID is persisted as `TWILIO_TWIML_APP_SID`. Access tokens reference it. Inbound PSTN webhooks (`/webhooks/twilio/voice/inbound`) live on the individual IncomingPhoneNumber's `voice_url`, not on the App — this is intentional so per-number routing remains direct.
- **Compliance warning:** N/A.

## 10. TwiML `<Dial>`, `<Client>`, `<Number>`

- **Source title:** _TwiML `<Dial>`_, _TwiML `<Client>`_
- **Source URLs:** <https://www.twilio.com/docs/voice/twiml/dial>, <https://www.twilio.com/docs/voice/twiml/client>
- **Date accessed:** 2026-05-19
- **Summary:** `<Dial>` connects a caller to another party. Attributes: `callerId` (must be a Twilio-owned or verified number when dialing PSTN), `timeout` (5–600, default 30, plus 5s buffer), `answerOnBridge` (caller hears ring not silence when used as first verb), `action`, `method`, `record`, `hangupOnStar`, `ringTone`. `<Client>` is nested in `<Dial>` and routes to a Voice SDK identity; supports `<Identity>` child or text-content identity, `<Parameter>` children for custom data, plus `statusCallback`, `statusCallbackEvent` (any of `initiated ringing answered completed`), `statusCallbackMethod`, `url`. `<Number>` routes to PSTN with similar status callback semantics. Up to 10 `<Client>`s can ring simultaneously.
- **Implementation implication:** Inbound TwiML for the browser softphone is `<Response><Dial answerOnBridge="true" timeout="30"><Client statusCallback="${baseUrl}/webhooks/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed">${identity}</Client></Dial></Response>`. Outbound is `<Response><Dial callerId="${selectedNumberE164}" answerOnBridge="true"><Number>${destinationE164}</Number></Dial></Response>`. The `<Number>` tag also gets a `statusCallback` attribute pointing at the status webhook.
- **Compliance warning:** `callerId` validation must happen server-side against the authenticated user's owned numbers. Spoofing protection lives in `OutboundCallGuard`.

## 11. Twilio Messaging — inbound webhook

- **Source title:** _Messaging — incoming webhook request_
- **Source URL:** <https://www.twilio.com/docs/messaging/guides/webhook-request>
- **Date accessed:** 2026-05-19
- **Summary:** Twilio POSTs `application/x-www-form-urlencoded` to the number's SMS URL. Parameters include `MessageSid`, `SmsSid`, `AccountSid`, `MessagingServiceSid`, `From`, `To`, `Body` (up to 1600 chars), `NumMedia`, `MediaUrl0..N`, `MediaContentType0..N`, `NumSegments`, `FromCity/State/Zip/Country`, `ApiVersion`, plus WhatsApp-only `ProfileName`/`WaId` when applicable. Response should be HTTP 200 with empty body or valid TwiML.
- **Implementation implication:** `MessagingWebhookController.inbound()` validates signature (entry #13), looks up `phone_numbers` by `To`, deduplicates on `MessageSid`, persists the raw payload to `webhook_events.raw_payload` and a normalized row to `sms_messages` (direction=INBOUND, status=RECEIVED), emits `sms.received` over WebSocket, then returns `200` with empty body. Twilio may add new fields without notice, so parsing uses a permissive schema that keeps unknown keys in `raw_payload`.
- **Compliance warning:** Inbound messages may contain PII / OTPs. Per the project's non-negotiable security rules, OTPs must **not** be parsed into special automation paths; they appear only in the human-readable inbox.

## 12. Twilio Messaging — outbound status callbacks

- **Source title:** _Messaging — track outbound message status_
- **Source URL:** <https://www.twilio.com/docs/messaging/guides/track-outbound-message-status>
- **Date accessed:** 2026-05-19
- **Summary:** Configured per message (`StatusCallback` field on Create Message) or per Messaging Service. Twilio POSTs to the URL with `MessageSid`, `MessageStatus`, `From`, `To`, `AccountSid`, `ErrorCode`, `ErrorMessage`, `RawDlrDoneDate` (carrier-supplied for SMS/MMS, format `YYMMDDhhmm`). Lifecycle statuses: `queued → sending → sent → delivered` (or `undelivered`/`failed`/`read`). Callbacks arrive asynchronously and may be out of order — handlers must be idempotent and tolerate evolving fields.
- **Implementation implication:** Outbound send sets `StatusCallback` to `${baseUrl}/webhooks/twilio/messaging/status`. `MessagingWebhookController.status()` updates `sms_messages.status` only if the new status is later in the lifecycle than the current one (no regressions) and emits `sms.status.updated` over WebSocket.
- **Compliance warning:** Endpoints must be on a public hostname without underscores per Twilio's requirements.

## 13. Twilio webhook signature validation

- **Source title:** _Webhook security_
- **Source URL:** <https://www.twilio.com/docs/usage/webhooks/webhooks-security>
- **Date accessed:** 2026-05-19
- **Summary:** Form-encoded webhooks: HMAC-SHA1 of `(full public URL) + (concatenation of POST params sorted by key, each as key + value with no delimiter)` keyed by the Auth Token, base64-encoded, sent in `X-Twilio-Signature`. Validate via `twilio.validateRequest()` in the Node helper SDK. JSON-body webhooks (Trust Hub, Studio) use a `bodySHA256` query param scheme — validate via `validateRequestWithBody()`. Return **403** on failure. The public URL passed to the validator must match what Twilio used; behind proxies, derive it from a trusted forwarded-host header rather than `req.headers.host`.
- **Implementation implication:** A NestJS guard `TwilioSignatureGuard` reconstructs the full URL using `PUBLIC_BASE_URL` env (not `req.host`, to defeat proxy-host spoofing) and calls `validateRequest`. The guard is applied to **every** controller in `webhooks/twilio/*`. Body parsing for those routes uses `urlencoded({ extended: false })` and preserves raw body for SHA256-mode endpoints if needed in v2. Invalid signatures → 403, audit log entry with `signature_valid=false`.
- **Compliance warning:** Auth Token must never appear in logs. The guard imports it from `ConfigService`, never reads it from `process.env` inline.

## 14. Number capabilities + number types — combined view

- **Source title:** _AvailablePhoneNumber / IncomingPhoneNumber capabilities_
- **Source URLs:** entries #2 and #5 above
- **Date accessed:** 2026-05-19
- **Summary:** Capabilities are an attribute of the **type+country** combination, not user-configurable. Local numbers most commonly carry voice + SMS (and often MMS in NANP). Mobile and TollFree availability and capability vary by country. Some countries' Local numbers are voice-only.
- **Implementation implication:** Search UI surfaces a capability badge per candidate; the purchase confirmation modal repeats the badge and warns when a requested capability is absent.
- **Compliance warning:** Toll-free SMS to US destinations requires Twilio A2P toll-free verification — gate the UI on `phone_numbers.number_type=TOLL_FREE` to show a "SMS may be limited until verification completes" notice.

## 15. Twilio regulatory compliance (international purchases)

- **Source title:** _Phone number regulatory requirements_
- **Source URL:** <https://www.twilio.com/docs/phone-numbers/regulatory>
- **Date accessed:** 2026-05-19
- **Summary:** Many jurisdictions require an identity bundle (`bundle_sid`), address (`address_sid`), and/or end-user record (`identity_sid`) before a number can be purchased. The Regulatory Compliance REST APIs (Bundles, EndUsers, SupportingDocuments, Regulations, Evaluations) manage this. The `addressRequirements` field on each AvailablePhoneNumber row (`none`/`any`/`local`/`foreign`) is the per-candidate indicator.
- **Implementation implication:** v1 will not support countries that require a Bundle; the available-list endpoint filters them out by default unless the user opts in. When `addressRequirements != "none"`, the purchase confirmation modal displays an explicit warning ("Twilio requires verification documents before this number can be activated; complete them in the Twilio Console") and a link to the Console. v2 may build a UI for Bundle creation; out of scope for v1.
- **Compliance warning:** Submitting false identity/address documents to circumvent Twilio's KYC is forbidden and would violate Twilio's AUP.

## 16. Twilio WhatsApp sender registration

- **Source title:** _Twilio WhatsApp API_
- **Source URL:** <https://www.twilio.com/docs/whatsapp/api>
- **Date accessed:** 2026-05-19
- **Summary:** WhatsApp Business sending through Twilio requires onboarding via the Self-Signup or ISV flow, registering the number with Meta Business Manager (creating a WABA). Messages are addressed as `whatsapp:<E.164>`. A 24-hour customer-care session opens when a user messages you; outside it, business-initiated messages require approved templates. Unverified Meta Business Managers cap at 2 numbers per WABA; verified accounts cap at 20.
- **Implementation implication:** v1 of this project **does not** auto-register Twilio numbers for WhatsApp. The `phone_numbers.whatsapp_compatibility_status` enum defaults to `UNKNOWN` and is only set to `APPROVED_BUSINESS_SENDER` via a manual admin action confirming the sender is live in Meta — never inferred from the number type.
- **Compliance warning:** Building automation around WhatsApp registration / OTP scraping is explicitly forbidden by Meta's Commerce / Business Messaging policies and Twilio's AUP. Hidden in the project's non-negotiables.

## 17. WhatsApp / Meta phone-number eligibility

- **Source title:** _WhatsApp Help Center — How to register your phone number_ and related FAQ
- **Source URL:** <https://faq.whatsapp.com/684051319521343/>
- **Date accessed:** 2026-05-19
- **Summary:** WhatsApp consumer accounts require a phone number that can receive SMS or a voice call to verify, and explicitly lists VoIP, toll-free, paid premium, and universal access numbers (UAN) as not supported. Landlines are unsupported on consumer WhatsApp but supported on WhatsApp Business. The same number cannot be used on multiple WhatsApp accounts simultaneously. Regional restrictions and account-standing rules apply on top.
- **Implementation implication:** The UI must display, on the number-search page and the per-number detail page, the exact copy: _"WhatsApp compatibility is not guaranteed. Some VoIP, toll-free, landline, or virtual numbers may be unsupported by WhatsApp / Meta."_ No code path treats a Twilio number as automatically WhatsApp-capable.
- **Compliance warning:** Misrepresenting Twilio Voice / VoIP numbers as guaranteed WhatsApp-compatible would be deceptive to users and may breach Meta policy. Strict no.

## 18. Cloudflare deployment constraints (NestJS + WebSockets)

- **Source title:** _Cloudflare Workers — Node.js compatibility_, _Cloudflare Pages — Vite framework guide_
- **Source URLs:** <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>, <https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/>
- **Date accessed:** 2026-05-19
- **Summary:** Cloudflare Workers with `nodejs_compat` supports most Node built-ins (assert, buffer, crypto, events, path, process, stream, util, partial net/tls/dns/fs). However Workers run a request/response model on `workerd`, not a persistent Node process — they cannot host a long-lived NestJS HTTP server, and Socket.IO is not directly supported (WebSocket via Durable Objects is supported but is a different programming model). Cloudflare Pages cleanly serves Vite output (`npm run build` → `dist/`) with per-branch preview deployments, env vars in the dashboard, custom domains, and `_redirects` for SPA routing.
- **Implementation implication:** Architecture splits as follows. **Frontend** → Cloudflare Pages at `app.webfitalchemist.online`. **Backend** (NestJS + Socket.IO + Twilio webhook handler) → a Node-compatible host (Fly.io / Render / Railway) at `api.webfitalchemist.online`, fronted by Cloudflare DNS (proxy disabled or set to "DNS only" for the `api` subdomain to keep WebSocket pings working reliably and to keep `X-Twilio-Signature` URL validation deterministic). This decision is recorded in ADR-0001.
- **Compliance warning:** Cloudflare's orange-cloud proxy can rewrite request properties; for Twilio webhooks we either disable the proxy on `api` or set explicit Page Rules to preserve the host header.

## 19. Namecheap → Cloudflare nameservers

- **Source title:** _Namecheap KB — How to change DNS for a domain_
- **Source URL:** <https://www.namecheap.com/support/knowledgebase/article.aspx/767/10/how-to-change-dns-for-a-domain/>
- **Date accessed:** 2026-05-19
- **Summary:** In the Namecheap Domain List → Manage → Nameservers panel, pick `CustomDNS` and paste the two Cloudflare-supplied nameservers (e.g. `xxxx.ns.cloudflare.com`). Propagation typically completes within a few hours; can take up to 24h.
- **Implementation implication:** Phase 10 will document this as a one-time manual step (using the project's Namecheap API credentials is also possible via `domains.dns.setCustom`, but the manual flow is simpler and auditable). After nameserver propagation, all DNS records for `webfitalchemist.online` are managed in Cloudflare via the Cloudflare API.
- **Compliance warning:** N/A.

## 20. Neon PostgreSQL connection pooling

- **Source title:** _Neon — Connection pooling_
- **Source URL:** <https://neon.com/docs/connect/connection-pooling>
- **Date accessed:** 2026-05-19
- **Summary:** Append `-pooler` to the endpoint hostname for the pooled (PgBouncer transaction-mode) URL — up to 10 000 concurrent client connections, but features that need a persistent session (`SET`/`RESET` of session vars, `LISTEN`/`NOTIFY`, temp tables, SQL-level `PREPARE`/`DEALLOCATE`) are unavailable on this URL. Use a direct (un-pooled) connection for Prisma migrations, `pg_dump`/`pg_restore`, and logical replication. SSL required; `channel_binding=require` recommended.
- **Implementation implication:** `.env.example` defines both `DATABASE_URL` (pooled, used by NestJS at runtime) and `DIRECT_DATABASE_URL` (un-pooled, used by `prisma migrate`). The Prisma schema declares both via `datasource db { url = env("DATABASE_URL")   directUrl = env("DIRECT_DATABASE_URL") }`. Health endpoint `GET /api/health/db` runs a trivial `SELECT 1` over the pooled URL.
- **Compliance warning:** Connection strings contain credentials; logs must redact them (a NestJS logger filter strips any value matching `/postgres(ql)?:\/\/[^@]+@/`).

## 21. Upstash Redis (provider choice)

- **Source title:** _Upstash Redis — Getting started_
- **Source URL:** <https://upstash.com/docs/redis/overall/getstarted>
- **Date accessed:** 2026-05-19
- **Summary:** Serverless Redis with TLS, REST + native protocol, official Node SDK, supports the full standard command set; suitable for rate limiting, pub/sub fanout, ephemeral state, and replay-protection caches.
- **Implementation implication:** `REDIS_URL` is set to the Upstash `rediss://` (TLS) endpoint. NestJS `RedisModule` is constructed with `tls: {}`. Uses: (a) `nestjs-rate-limiter` storage for login/SMS/call/token endpoints, (b) `socket.io-redis-adapter` for WebSocket fanout if we ever run >1 backend instance, (c) `voice:call:{sid}` short-lived state during ringing, (d) `webhook:dedupe:{messageSid}` 24h TTL for inbound dedup.
- **Compliance warning:** N/A.

## 22. Twilio Voice JS SDK — browser support & limitations

- **Source title:** _Voice JavaScript SDK — Best practices_
- **Source URL:** <https://www.twilio.com/docs/voice/sdks/javascript/best-practices>
- **Date accessed:** 2026-05-19
- **Summary:** Token refresh via `tokenWillExpire` (call `device.updateToken()` before expiry), call `getUserMedia({audio:true})` early and stop tracks immediately to release the indicator, listen for `registered`/`unregistered`/`error`, prefer Twilio Voice Insights for RTT/MOS/jitter/packet-loss telemetry, set `edge` for region pinning or omit for automatic latency-based routing. Mobile browsers can't reliably maintain a call in the background — recommend desktop or the dedicated iOS/Android Twilio Voice SDKs (not in v1 scope).
- **Implementation implication:** Frontend wiring captured in the Voice module design. Voice Insights enabled in production via Twilio Console; the app surfaces RTT and warning toasts but does not query Insights at runtime.
- **Compliance warning:** N/A.

---

## Summary of compliance gates enforced in the codebase

1. **No WhatsApp guarantees.** UI copy and DB enum default both reflect this (#16, #17).
2. **No bulk operations / no OTP scraping.** Inbox is read-only viewing; outbound SMS is single-recipient and rate-limited (#11, #16).
3. **Twilio signature on every webhook.** `TwilioSignatureGuard` is non-optional (#13).
4. **No caller-ID spoofing.** `OutboundCallGuard` checks owner ⟶ number ⟶ requested `callerId` (#6, #10).
5. **No automation around regulatory documents.** Restricted-country purchases route the user to the Twilio Console (#15).
6. **No long-lived NestJS on Workers** — Node backend is on a Node-friendly host, fronted by Cloudflare DNS (#18); ADR-0001 captures the rationale.
7. **Secrets never logged.** Logger redactor and `.env.example` placeholders only (#20, #21).
