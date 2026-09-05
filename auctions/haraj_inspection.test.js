'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const g11 = require('./services/haraj_inspection');
const g10 = require('./services/haraj_bidder_security');

describe('G11 inspection / acceptance domain', () => {
  it('reuses 010 terminology and does not invent a second winner or settlement', () => {
    assert.equal(g11.BUYER_OUTCOMES.ACCEPTED, 'accepted');
    assert.equal(g11.BUYER_OUTCOMES.MATERIAL_MISMATCH, 'material_mismatch');
    assert.equal(g11.BUYER_OUTCOMES.WITHDRAWN, 'withdrawn');
    assert.notEqual(g11.BUYER_OUTCOMES.ACCEPTED, g11.BUYER_OUTCOMES.WITHDRAWN);
    assert.notEqual(g11.BUYER_OUTCOMES.MATERIAL_MISMATCH, g11.BUYER_OUTCOMES.WITHDRAWN);
    assert.match(g11.SETTLEMENT_BOUNDARY, /does not insert haraj_settlements/);
    assert.match(g11.RUNNER_UP_RULE, /NEVER AUTOMATICALLY/);
    assert.match(g11.VET_BOUNDARY, /not a veterinarian/);
    assert.equal(g11.QR_PROVES, 'attendance_check_in_only');
    assert.ok(g11.QR_DOES_NOT_PROVE.includes('buyer_acceptance'));
    assert.equal(g11.WINDOW_POLICY, 'STAGING_OPERATIONAL_NOT_LEGAL');
  });

  it('keeps Arabic outcomes distinct', () => {
    assert.equal(g11.outcomeLabelAr('accepted'), 'مطابق — إتمام الشراء');
    assert.equal(g11.outcomeLabelAr('material_mismatch'), 'غير مطابق للوصف');
    assert.equal(g11.outcomeLabelAr('withdrawn'), 'عدلت عن الشراء');
    assert.equal(g11.outcomeLabelAr('expired_review_required'), 'انتهت المهلة — بانتظار مراجعة المشغّل');
  });

  it('documents exposure handoff without silent release', () => {
    assert.match(g11.EXPOSURE_BY_AWARD.accepted, /REMAINS/);
    assert.match(g11.EXPOSURE_BY_AWARD.disputed, /REMAINS/);
    assert.match(g11.EXPOSURE_BY_AWARD.withdrawn, /REMAINS/);
    assert.match(g11.EXPOSURE_BY_AWARD.inspection_pending, /REMAINS/);
    assert.match(g11.EXPOSURE_BY_AWARD.cancelled, /RELEASED/);
    assert.match(g11.BID_SECURITY_POLICY, /never releases Bid Security/);
  });

  it('rejects arbitrary evidence URLs and oversized files', () => {
    assert.throws(
      () => g11.sanitizeEvidence([{ contentType: 'image/jpeg', sizeBytes: 10, url: 'https://evil.test/x' }]),
      (e) => e.code === 'INSPECTION_EVIDENCE_URL_FORBIDDEN',
    );
    assert.throws(
      () => g11.sanitizeEvidence([{ contentType: 'image/jpeg', sizeBytes: 10, objectRef: 'https://cdn.example/x' }]),
      (e) => e.code === 'INSPECTION_EVIDENCE_REF',
    );
    assert.throws(
      () => g11.sanitizeEvidence([{ contentType: 'application/x-msdownload', sizeBytes: 10, objectRef: 'file-1' }]),
      (e) => e.code === 'INSPECTION_EVIDENCE_TYPE',
    );
    assert.throws(
      () => g11.sanitizeEvidence([{ contentType: 'image/png', sizeBytes: 26 * 1024 * 1024, objectRef: 'file-1' }]),
      (e) => e.code === 'INSPECTION_EVIDENCE_SIZE',
    );
    const ok = g11.sanitizeEvidence([
      { contentType: 'image/jpeg', sizeBytes: 1024, objectRef: 'media-obj-1', checksum: 'abc' },
    ]);
    assert.equal(ok[0].objectRef, 'media-obj-1');
    assert.equal(ok[0].checksum, 'abc');
  });

  it('snapshots material disclosure without copying binaries', () => {
    const snap = g11.buildDisclosureSnapshot({
      id: 'a1',
      lot_id: 'l1',
      species: 'horse',
      lot_title: 'حصان',
      description: 'عمر 5 سنوات',
      breed: 'عربي',
      gender: 'stallion',
      color: 'كميت',
      age_label: '5',
      starting_price: 1000,
      reserve_price: 2000,
      location_city: 'الرياض',
      media_images: ['img-1'],
      media_video_cloudflare_id: 'cf-1',
      media_video_hls_url: 'https://videodelivery.net/cf-1/manifest/video.m3u8',
    });
    assert.equal(snap.immutable, true);
    assert.equal(snap.binariesDuplicated, false);
    assert.equal(snap.description, 'عمر 5 سنوات');
    assert.deepEqual(snap.media.images, ['img-1']);
    assert.equal(snap.media.videoCloudflareId, 'cf-1');
  });

  it('authorizes only winner / seller / staff', () => {
    const auction = { owner_user_id: 'seller' };
    const award = { winner_user_id: 'winner' };
    assert.equal(g11.viewerRole({ auction, award, actorUserId: 'winner' }), 'buyer');
    assert.equal(g11.viewerRole({ auction, award, actorUserId: 'seller' }), 'seller');
    assert.equal(g11.viewerRole({ auction, award, actorUserId: 'other' }), 'none');
    assert.equal(g11.viewerRole({ auction, award, actorUserId: 'x', actorRole: 'admin' }), 'admin');
    assert.equal(g11.viewerRole({ auction, award, actorUserId: 'x', actorRole: 'auctioneer' }), 'auctioneer');
  });

  it('uses admin/system window override only; default is staging policy not a legal period', () => {
    const def = g11.inspectionWindowHours({ actorRole: 'buyer', windowHours: 0.001 });
    assert.equal(def, Number(process.env.HARAJ_INSPECTION_WINDOW_HOURS || 72));
    assert.equal(g11.inspectionWindowHours({ actorRole: 'admin', windowHours: 0 }), 0);
    assert.equal(g11.inspectionWindowHours({ actorRole: 'system', windowHours: 1 }), 1);
  });

  it('releases G10 closed-winner exposure only after G11 award cancellation', () => {
    const sold = {
      auction: {
        id: 'W',
        status: 'sold',
        currentPrice: 80000,
        winnerUserId: 'x',
        awardStatus: 'inspection_pending',
      },
      bids: [],
    };
    assert.equal(g10.obligationOnAuction(sold.auction, sold.bids, 'x'), 80000);
    assert.equal(g10.totalActiveExposure([{
      ...sold,
      auction: { ...sold.auction, awardStatus: 'accepted' },
    }], 'x'), 80000);
    assert.equal(g10.totalActiveExposure([{
      ...sold,
      auction: { ...sold.auction, awardStatus: 'withdrawn' },
    }], 'x'), 80000);
    assert.equal(g10.totalActiveExposure([{
      ...sold,
      auction: { ...sold.auction, awardStatus: 'disputed' },
    }], 'x'), 80000);
    assert.equal(g10.totalActiveExposure([{
      ...sold,
      auction: { ...sold.auction, awardStatus: 'cancelled' },
    }], 'x'), 0);
    assert.equal(g10.totalActiveExposure([{
      ...sold,
      auction: { ...sold.auction, winnerUserId: 'y' },
    }], 'x'), 0);
  });
});
