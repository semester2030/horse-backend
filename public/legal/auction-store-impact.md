# NOMAS — Auction Store Impact (Public Readiness)

**Last updated:** August 2026 · Applies when `ENABLE_AUCTIONS=true`

## Microphone (Apple + Google)

| Platform | Declaration | Scope |
|----------|-------------|--------|
| iOS | `NSMicrophoneUsageDescription` in Info.plist | Host-only live auction audio (optional LiveKit). Bidders do not publish audio. |
| iOS | `PrivacyInfo.xcprivacy` — `NSPrivacyCollectedDataTypeAudioData` | Host broadcast during live session; linked to account; not used for tracking. |
| Android | `RECORD_AUDIO` in AndroidManifest | Same — host publish only when auctions enabled and user is assigned host. |

## UGC / Live content moderation

- Auction listing video: existing listing/video moderation pipeline + admin review queue before go-live.
- Live host audio: listen-only for audience; admin force-end; host suspension; freeze/cancel preserves bid evidence.
- No in-app speech recording storage in V1 (LiveKit SFU transport; no server-side recording claimed).

## Data Safety (Google Play) / App Privacy (Apple)

| Data | Collected when auctions ON | Purpose | Linked to user | Shared |
|------|---------------------------|---------|--------------|--------|
| Bid amounts & history | Yes | Determine winner / final price | Yes | Render backend only |
| Auction video (UGC) | Yes | Display lot | Yes | Cloudflare Stream / CDN |
| Host live audio | Yes (host only) | Optional live commentary | Yes | LiveKit (WebRTC SFU) |
| Mic audio | Yes (host only) | Broadcast to listeners | Yes | LiveKit |

**Not collected in V1:** payment card data, escrow holds, in-app purchase for auction settlement.

## Age rating note

Live unmoderated audio may require mature rating review — host audio is moderated operationally (admin force-end, suspend host).

## Legal links

- Terms §7: `/legal/terms.html` — winner in-app; payment offline V1
- Privacy §7: `/legal/privacy.html` — bids, mic, moderation

## In-app UX (PR-06)

- `auction_v1_policy.dart` — settlement disclaimer before bid confirm and on detail screen.
