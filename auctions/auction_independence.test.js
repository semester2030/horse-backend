'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateIndependentAuctionCreate,
  validateAuctionAssetOwnership,
  isPlayableAuctionHlsUrl,
} = require('./services/ownership_validation');
const {
  requireAuctionOwnerLocation,
} = require('./services/location_snapshot');
const { optionalListingRef } = require('./domain/species');

describe('auction media independence', () => {
  it('accepts independent create with playable HLS', () => {
    const r = validateIndependentAuctionCreate({
      ownerUserId: 'u1',
      species: 'horse',
      mediaVideoHlsUrl: 'https://videodelivery.net/abc/manifest/video.m3u8',
      mediaVideoCloudflareId: 'abc',
      mediaImages: ['https://imagedelivery.net/x/public'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.media.mediaImages.length, 1);
    assert.equal(r.media.mediaVideoHlsUrl.includes('m3u8'), true);
  });

  it('rejects Cloudflare id alone without playable HLS', () => {
    const r = validateIndependentAuctionCreate({
      ownerUserId: 'u1',
      species: 'camel',
      mediaVideoCloudflareId: 'cf-only-id',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUCTION_VIDEO_PLAYBACK_REQUIRED');
  });

  it('rejects independent create without auction video', () => {
    const r = validateIndependentAuctionCreate({
      ownerUserId: 'u1',
      species: 'camel',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUCTION_MEDIA_VIDEO_REQUIRED');
  });

  it('isPlayableAuctionHlsUrl accepts Cloudflare manifest URLs', () => {
    assert.equal(
      isPlayableAuctionHlsUrl(
        'https://customer-x.cloudflarestream.com/uid/manifest/video.m3u8',
      ),
      true,
    );
    assert.equal(isPlayableAuctionHlsUrl('https://example.com/video.mp4'), false);
    assert.equal(isPlayableAuctionHlsUrl(''), false);
  });

  it('requires owner location with Saudi bounds', () => {
    const bad = requireAuctionOwnerLocation({ city: 'الرياض' });
    assert.equal(bad.ok, false);
    const ok = requireAuctionOwnerLocation({
      city: 'الرياض',
      lat: 24.7136,
      lng: 46.6753,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.snapshot.sourceListingId, null);
  });

  it('optionalListingRef allows null legacy refs', () => {
    const r = optionalListingRef('', '');
    assert.equal(r.listingId, null);
    assert.equal(r.videoId, null);
  });

  it('legacy ownership still requires listing+video', () => {
    const store = {
      horses: new Map([
        [
          'l1',
          {
            id: 'l1',
            sellerId: 'u1',
            species: 'horse',
            location: { latitude: 24.7, longitude: 46.6 },
            city: 'الرياض',
          },
        ],
      ]),
      videos: new Map([
        ['v1', { id: 'v1', userId: 'u1', type: 'horse', horseId: 'l1' }],
      ]),
    };
    const miss = validateAuctionAssetOwnership(store, {
      listingId: '',
      videoId: 'v1',
      ownerUserId: 'u1',
      species: 'horse',
    });
    assert.equal(miss.ok, false);
    const ok = validateAuctionAssetOwnership(store, {
      listingId: 'l1',
      videoId: 'v1',
      ownerUserId: 'u1',
      species: 'horse',
    });
    assert.equal(ok.ok, true);
  });
});
