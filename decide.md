# Call recording: which option to take

Decision notes for `recording-with-no-storage-restrictions.txt`, checked against how this softphone actually works (2026-10-07).

## TL;DR

**None of the 8 tools in the file fit your setup as-is.** All of them assume you own the SIP/RTP path: your own PBX, SIP proxy, or a network where call audio travels unencrypted. Your softphone is the Twilio Voice JS SDK. Audio goes from the browser to Twilio over encrypted WebRTC, then out to the phone network, so you never handle SIP or plain RTP.

**Recommendation: a hybrid in two steps.**

1. **Archive-and-delete (do this first).** Keep the Twilio dual-channel recording you already have. When a recording completes, the API copies it to Cloudflare R2 and deletes it from Twilio. That removes the storage cap and keeps Twilio storage near zero. You still pay Twilio's $0.0025/min to create each recording.
2. **In-browser recorder (the free part).** This is the idea behind OBS, built into the app. During each call the app records your mic and the prospect's audio into one stereo file and uploads it to the same bucket. It costs $0/min and works on Android Chrome too. Run it next to Twilio recording for about 2 weeks. If its files hold up, turn Twilio recording off by default and keep it as an optional backup.

**Rejected:** Asterisk, FreeSWITCH, OpenSIPS, Drachtio (each needs a self-hosted SIP server in the call path), SIP3, Oreka, VoIPmonitor (they listen to network traffic and can't decrypt WebRTC), and OBS (desktop only, and it records everything the PC plays). Reasons for each are below.

---

## 1. What you have today

| Piece            | How it works now                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound calls   | `<Dial record="record-from-answer-dual">` when the Dial page's **Record call** toggle is on (default on). Left channel = you (browser), right channel = prospect (PSTN).                |
| Inbound calls    | The same `<Dial>` recording when the number's `recordInboundCalls` tag is on.                                                                                                           |
| Voicemail        | `<Record>`, then Deepgram transcribes it (`voicemail-transcriber.service.ts` fetches the MP3 **from Twilio by recording SID**).                                                         |
| Where files live | **Only at Twilio.** The database keeps `CallRecording` rows (SID, status, duration). The API streams the MP3 from Twilio for the Calls page (`calls.service.ts` → `getRecordingMedia`). |
| Local copy       | The Dial page downloads the MP3 to your disk automatically after each recorded call (`apps/web/src/lib/recording-downloads.ts`).                                                        |

**What it costs (from `YOURCOSTS.md` and Twilio's price page):**

- Creating a recording: **$0.0025/min**. Your last measured period had 112 recorded minutes, which cost **$0.28**.
- Storage: free up to **10,000 stored minutes**, then **$0.0005 per stored minute per month**, every month, for as long as the recordings stay at Twilio.

So your "storage restriction" is two things: the 10,000-minute free tier, and Twilio holding the only server-side copy.

**Example with heavy calling.** Say you record 150 minutes a day for 22 days a month, about 3,300 minutes a month. You pass 10,000 stored minutes in about 3 months. If you never delete anything, after a year you hold about 39,600 minutes at Twilio. That's roughly **$15/month in storage alone**, and it keeps growing, on top of about $8/month to create new recordings.

---

## 2. Why your call path rules out most of the list

```
 Your browser (Twilio Voice JS SDK)
      │  signaling: Twilio's own protocol over TLS WebSocket
      │  audio:     WebRTC, DTLS-SRTP encrypted
      ▼
 Twilio edge / media servers   ← <Dial record> captures here
      │
      ▼
 PSTN  ──────────►  prospect's phone
```

Only two places ever hear the decrypted audio: **your browser** and **Twilio**. Every workable option has to record in one of those two places. Each option in the file either needs a third place you don't have (your own PBX or SIP proxy), or tries to listen on the network, where all it would see is encrypted packets.

ADR-0001 (`docs/adr/0001-telephony-architecture.md`) already ruled out putting Asterisk, FreeSWITCH, or a VPS PBX in front of Twilio. Nothing in a recording requirement changes that.

---

## 3. Verdict on each of the 8 options

| #   | Option                   | What it needs                                      | Fits your setup?                      | Verdict                      |
| --- | ------------------------ | -------------------------------------------------- | ------------------------------------- | ---------------------------- |
| 1   | Asterisk (MixMonitor)    | Calls routed through your own PBX                  | No: requires rebuilding the softphone | ❌                           |
| 2   | FreeSWITCH               | Calls routed through your own media server         | No: same as Asterisk                  | ❌                           |
| 3   | OBS Studio               | Desktop audio capture on the calling device        | Partly: Windows only                  | ❌ as a tool, ✅ as an idea  |
| 4   | SIP3                     | Unencrypted SIP and RTP on a network you can sniff | No: traffic is encrypted WebRTC       | ❌                           |
| 5   | Oreka / OrkAudio         | Unencrypted SIP and RTP on a network you can sniff | No: same as SIP3                      | ❌                           |
| 6   | VoIPmonitor              | Decrypted media at your own SBC or media server    | No: you don't run one                 | ❌                           |
| 7   | OpenSIPS (SIPREC client) | Calls routed through your own SIP proxy            | No                                    | ❌                           |
| 8   | Drachtio SIPREC server   | Something that sends it SIPREC                     | Technically yes (Twilio `<Siprec>`)   | ❌ costs more, gains nothing |

### 1. Asterisk: no

Recording with MixMonitor is free, but getting calls into Asterisk is not. You would have to do one of two things:

- Replace the Twilio Voice SDK with SIP.js/JsSIP, talking to Asterisk over WebRTC, which then dials out through a Twilio Elastic SIP Trunk.
- Bounce every call Twilio → SIP → Asterisk → Twilio.

Either way you take on:

- An always-on server with public SIP and RTP ports, plus TURN.
- A rewrite of the softphone.
- Losing what the SDK gives you today: `answerOnBridge`, the call-quality panel, the incoming-call popup and push, the 667 "ring the app, then the AI agent" flow, and the /voice app.

That's a lot of new infrastructure to save $0.0025/min. ADR-0001 rejected this for the same reasons.

### 2. FreeSWITCH: no

Same problem as Asterisk. Its strength, hundreds of concurrent recordings, doesn't matter here: you're one person making one call at a time.

### 3. OBS Studio: no as a tool, but the idea is right

It needs no app changes on Windows and can put your mic and the desktop audio on separate tracks. Why it still doesn't fit:

- **You also call from Android Chrome**, and OBS doesn't run there.
- It records **everything the PC plays**: notification sounds, other tabs, the ringtone, Windows sounds.
- You get one long file per session unless you script start/stop through obs-websocket. Files don't line up with calls.
- Files stay on one PC, with no link to the call log or the spreadsheet row.

**The idea is the right one:** record on the device that's already hearing both sides. Step 2 below does this inside the app, limited to the call itself, with one file per call, and on Android too.

### 4. SIP3: no

SIP3 rebuilds audio from SIP signaling and RTP packets it sniffs off the network. Your signaling is Twilio's own protocol inside a TLS WebSocket, not SIP. Your audio is DTLS-SRTP encrypted between the browser and Twilio. A sniffer on your network sees encrypted packets it has no keys for, so there's nothing to rebuild.

### 5. Oreka (OrkAudio): no

Same passive-capture approach as SIP3 (it matches RTP streams to SIP Call-IDs), so it hits the same wall.

### 6. VoIPmonitor: no

Its WebRTC decoding only works where it can see decrypted media, which means sitting on your own SBC or media server. You don't run one, and Twilio isn't going to install it for you.

### 7. OpenSIPS (SIPREC client): no

It's a SIP proxy that copies media to a recorder, so your calls would have to pass through it, and they don't. Twilio can play the same role itself with `<Start><Siprec>`, which is the only way option 8 can work.

### 8. Drachtio SIPREC server: technically possible, still no

This is the one option that can plug in without rebuilding the softphone. Twilio's `<Start><Siprec>` sends a copy of the call's audio through a SIPREC Connector to your Drachtio + rtpengine server. But:

- **It isn't free.** Twilio bills each forked audio stream per minute (see Twilio's "Forked Audio Streams" pricing), and both sides of the call means two forks.
- You need another always-on server with public SIP and RTP ports.
- The audio is still 8 kHz phone quality, the same as `record-from-answer-dual`.
- You'd still have to build storage and playback.

You'd pay for the fork **and** a server to get what you already have. The same goes for Twilio Media Streams (`<Start><Stream>` to your API over a WebSocket), which isn't on the list but often gets suggested: it's billed per fork-minute, the audio is 8 kHz μ-law, and your Fly API would have to hold a WebSocket open and write audio for every call.

---

## 4. Recommendation: the hybrid

### Step 1: Archive-and-delete (removes the storage cap)

**What it does:**

1. When `handleRecording` (`apps/api/src/webhooks/voice.service.ts`) gets `completed`, the API queues a job.
2. The job streams `twilio.fetchRecordingMedia(sid)` into **Cloudflare R2** under a key like `calls/2026/10/{CallSid}/{RecordingSid}.mp3`.
3. It checks the upload (object exists and the size matches), then saves a new `storageKey` column on `CallRecording`.
4. Then it calls `DELETE /Recordings/{sid}` at Twilio.

Playback (`getRecordingMedia` / `getVoicemailMedia`) reads from R2 when `storageKey` is set and from Twilio otherwise, so old rows keep working. A one-off backfill script moves the recordings already at Twilio.

**Why it comes first:**

- **It's the smallest change.** It reuses the recording callback, the `CallRecording` table, the streaming proxy, and their tests.
- **It removes the cap for good.** Twilio storage stays near zero, so the 10,000-minute tier and the $0.0005/min/month charge stop mattering.
- **The recording stays authoritative.** It's captured server-side, from what the network actually carried, so it survives a closed tab, a crashed browser, or a dead phone battery.

**Voicemail:** as decided on 2026-10-07, voicemail is no longer transcribed, so nothing else reads the Twilio copy before the archiver moves it.

**Why R2 over the alternatives:**

| Storage                                   | Free allowance           | After that                       | Notes                                                                                                                                                      |
| ----------------------------------------- | ------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare R2** (recommended)           | 10 GB                    | ~$0.015/GB-month, no egress fees | You're already on Cloudflare. No download fees, so playing recordings costs nothing. Lifecycle rules can auto-delete after N months if you ever want that. |
| Google Drive (your existing Google OAuth) | 15 GB, shared with Gmail | Google One plans                 | Could put a link to the recording in the Sheets row. But it eats into your Gmail space, and the cold-email sequences run from that account.                |
| Your PC only (already happening)          | Your disk                | n/a                              | Free and unlimited, but it's one copy, it isn't reachable from Android, and it isn't linked from the Calls page.                                           |

A Twilio dual-channel MP3 is roughly 0.25–0.5 MB per minute (check one of your files to pin this down). At the upper end, R2's free 10 GB holds about 20,000 minutes. A full year of the heavy example (about 40,000 minutes, about 20 GB) would cost **under $0.20/month**.

**Cost after step 1:** $0.0025/min to create recordings, plus close to nothing for storage.

### Step 2: In-browser recorder (removes the per-minute fee)

**What it does:**

1. When a call is answered (an outbound call from the Dial page, or an incoming call answered in the popup, on the Answer page or in the /voice app), the app takes the SDK's own streams: `call.getLocalStream()` is your mic, `call.getRemoteStream()` is the prospect. Both are available in the installed `@twilio/voice-sdk` 2.18.5 (`call.d.ts` lines 201 and 205).
2. A Web Audio `ChannelMergerNode` puts you on the left and the prospect on the right, the same layout as the Twilio dual file, so the diagnostics in your notes still apply.
3. `MediaRecorder` records it as `audio/webm;codecs=opus` at about 24–32 kbps, saving a chunk every 5 seconds to IndexedDB. If the tab crashes, you lose at most the last 5 seconds.
4. On hangup the app assembles the file and, **if the call lasted 90 seconds or more**, uploads it through the API (shorter ones stay on disk only; the Twilio copy of an outbound call is archived to R2 whatever its length), which checks the call is yours, stores it in R2, and attaches it to the call row as a `source: 'browser'` recording. The browser never sees R2 credentials, and the bucket needs no CORS setup. If an upload fails, it waits in IndexedDB and retries every minute and whenever the app loads.
5. The existing auto-download to disk keeps working as your local copy.

`MediaRecorder` is already used in the codebase (`apps/web/src/voice/lib/greeting.ts`), so this isn't a new pattern.

**Why:**

- **$0/min.** No Twilio recording fee at all.
- **It works on Android Chrome**, your other calling device, which OBS can't do.
- **Your side sounds better.** Your voice is captured before it goes over the network, as 48 kHz Opus, instead of 8 kHz phone audio. The prospect's side is 8 kHz either way, because that's the phone network.
- **Small files.** 24 kbps Opus is about 180 KB/min, so R2's free 10 GB holds about **55,000 minutes**. That's over a year of the heavy example.

**Why it's step 2 and not the only recorder (the real limitations):**

- **It only lasts as long as the tab.** A reload mid-call, a crashed tab, or Android killing Chrome in the background loses everything after the last saved chunk. Android behavior (screen off, switching apps mid-call) **has to be tested**; I can't promise it from the spec.
- **It records what your device heard, not what the network carried.** If your connection drops audio, the gap is in the file. In Twilio's dual file, the prospect's channel would still be complete. That's fine for reviewing your pitch; for a dispute, the Twilio copy is stronger.
- **Muting records silence on your channel.** That's expected.
- **One Chrome quirk to test:** remote WebRTC audio sent into Web Audio can come out silent unless it's also playing through an audio element. The SDK already plays it that way, so it should be fine, but verify with a real call.
- **Voicemail can't use it.** When you miss a call, no browser is involved, so Twilio's `<Record>` captures the message. The archiver (step 1) then moves it to R2 and deletes it from Twilio, like every other recording.

### Step 3: Rollout

1. **Ship step 1.** Backfill the existing Twilio recordings to R2, confirm playback on the Calls page, then delete them from Twilio.
2. **Ship step 2 with Twilio recording still on.** For about 2 weeks every recorded call has both copies. Compare them on purpose: some calls on the PC, some on Android, some where you switch apps mid-call, and at least one long call.
3. **If the browser copies are complete,** change the Dial page so the browser recorder is always on and the Twilio **Record call** toggle defaults to off. Rename the toggle to something like "Also record on Twilio (backup)". Inbound calls are already browser-recorded by default (2026-10-07); Twilio only records them when the answering browser can't.
4. **Optional:** add a "Back up this call" button. Twilio can start recording a call already in progress (`POST /Calls/{CallSid}/Recordings` with dual channels), so when a call is going well, like a demo being booked, one tap adds an authoritative copy. You'd pay only for those minutes.

---

## 5. Cost comparison

Heavy example: 3,300 recorded minutes a month, month 12 (about 39,600 minutes stored in total).

| Setup                                              | Recording fee | Storage fee in month 12                  | Monthly total in month 12 |
| -------------------------------------------------- | ------------- | ---------------------------------------- | ------------------------- |
| Today (Twilio, never delete)                       | ~$8.25        | ~$14.80 (29,600 billable min × $0.0005)  | **~$23 and rising**       |
| Step 1 (archive to R2, delete from Twilio)         | ~$8.25        | < $0.20                                  | **~$8.40**                |
| Steps 1 + 2, Twilio off by default                 | $0            | $0 (≈7 GB of Opus, inside the free tier) | **$0**                    |
| Steps 1 + 2, Twilio backup on about 10% of minutes | ~$0.83        | $0                                       | **< $1**                  |

At your current volume (112 recorded minutes in the last measured period) every row costs pennies. The difference only shows up once you're calling at full volume for months.

---

## 6. Consent

Nothing here changes what you already have to do. Whichever recorder runs, it starts when the call is answered, and the disclosure at the start of the call is what makes it legitimate. This matters for US states that require every party's consent and for UK calls. The browser recorder can also show the same red "Recording" badge the Dial page already shows for Twilio recordings.

---

## 7. Decisions left for you

1. **Storage:** R2 (recommended), Google Drive, or the PC only?
2. **Retention:** keep everything forever (cheap on R2), or auto-delete after N months with an R2 lifecycle rule?
3. **Twilio as backup:** after the 2-week comparison, turn Twilio recording fully off, keep it as an opt-in toggle (recommended), or keep it on for inbound only?
4. **Spreadsheet link:** do you want each call's recording URL pushed into its Sheets row next to the status? It's an easy addition once files live in R2.
