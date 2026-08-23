# Advanced Auction Experience — Privacy / RBAC Matrix (STEP 12)

**Date:** 2026-08-23 · **No Deploy**

## Public consumer (Flutter / public REST / WS)

| Field | Allowed | Notes |
|-------|---------|-------|
| bidderLabel (sanitized) | ✅ | `مزايد ···xxxx` |
| bid amount / timestamp / version | ✅ | |
| public location (city/district/display/address/lat/lng) | ✅ | map UX; no sourceListingId |
| public host display + audio label | ✅ | |
| viewCount / uniqueViewers / liveViewers / uniqueBidders / bidCount | ✅ | thin metrics |
| bidderUserId / phone / email / IP / device | ❌ | |
| risk details / admin notes / audit | ❌ | |
| peakLiveViewers as financial truth | ❌ | soft gauge only |

## Admin (role-gated)

| Permission | Roles | Access |
|------------|-------|--------|
| `auctions:read` | super_admin, moderator | list/detail/timeline/risk/hosts |
| `auctions:moderate` | super_admin, moderator | review, risk evaluate/ack, audio force-end, host verify/suspend |
| `auctions:ops` | super_admin, moderator | freeze / resume / cancel |
| `auctions:disputes` | super_admin, moderator | dispute lifecycle |
| *(none)* | support, analyst, verifier | **HTTP 403** on auction admin routes |

Admin may see: bidderUserId, sourceListingId, capturedAt, risk payloads, dispute notes, peakLiveViewers.

## Presence semantics

- liveViewers = unique `userId` in WS room `auction:{id}`
- multi-device same user = 1
- reconnect ≠ new qualified view
- presence events are **not** sequenced and **not** financial SoT
- unknown presence → Flutter shows `—`

## Pagination bounds (admin)

| Dataset | Cap |
|---------|-----|
| Bids in detail | 50 (+ cursor flag) |
| Timeline merged | 100 newest |
| Risk / Disputes | 50 each |
| Bidder aggregates | 100 |
| Admin list | ≤ 100 |

## Indexes relied on (no blind over-index)

- `bids_auction_created_id_idx` (007) — bid cursor
- `idx_bids_bidder` (001)
- `idx_auction_events_auction` (001)
- `auction_view_sessions` UNIQUE + auction idx (007)
- auctions status/start indexes (001)
