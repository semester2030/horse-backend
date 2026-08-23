# Advanced Auction Experience — Design + Status

**Date:** 2026-08-23  
**Mode:** Controlled implementation · **No Deploy**  
**Phase:** STEP 10–12 COMPLETE (Verdict A)

## Frozen product decisions

1. **Custom Bid:** `amount >= currentPrice + minimumIncrement` (money-rounded). No multiple-of-increment rule. ✅
2. **Location:** Authoritative server snapshot from listing at create. Mandatory for **new** auctions only; existing `location=null` OK. ✅
3. **Metrics:** Thin auction metrics only — not an analytics platform. ✅
4. **liveViewers:** Ephemeral presence only. Never financial/domain authority. Never persisted as canonical truth. ✅
5. **viewCount:** Qualified-view policy only — no increment on rebuild / pull-refresh / WS reconnect / repeat viewer_key. ✅
6. **Video-first overlay:** Always-visible LEVEL 1 only; heavy info in Bottom Sheets. Overlay footprint ≤ baseline. ✅

## STEP 10 — Realtime Metrics Polish

Post-COMMIT `bid.accepted` now carries PG aggregates:
`bidCount` · `uniqueBidders` · `extensionsCount` · `nextMinimumBid` (+ existing price/version/endAt).

Presence: `auction.presence` (ephemeral, **no seq**) on auction room join/leave.
Multi-device same `userId` = 1 live viewer. Reconnect ≠ qualified view.

Flutter `applyAuctionWsEvent` patches metrics from events; video `ValueKey('auction-{id}')` stable.

Recovery: WS gap → REST refresh (unchanged).

## STEP 11 — Admin Command Center

`AuctionsCommandCenter` tabbed workspace: Overview · Live Metrics · Bids · Bidders · Viewers · Host · Location · Media · Timeline · Risk · Disputes · Ops.

API `sections` enriched: full overview, bidder aggregates, host section, bounded bids (50) + timeline (100).

## STEP 12 — Privacy / RBAC / Performance

Matrix: `backend/auctions/PRIVACY_RBAC_MATRIX.md`

- Public: no `bidderUserId` / phone / email / risk notes
- Admin RBAC: support/analyst → **403**; moderator → allowed (HTTP proofs 11/11)
- Pagination caps on admin unbounded sets
- Indexes: reuse 001/007 — EXPLAIN evidence `evidence/explain_bids_cursor_s1012.txt`
- **No new migration** (no evidence for additional indexes)

## Next

STEP 13+14 — Full Final Acceptance + SSOT/Evidence Closure. **No Deploy until approved.**
