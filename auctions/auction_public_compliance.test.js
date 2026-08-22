'use strict';

const { describe, it } = require('node:test');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('PR-04–06 — legal, privacy, UX compliance artifacts', () => {
  it('PR-03/04 privacy.html documents auctions (bids, mic, moderation)', () => {
    const html = read('backend/public/legal/privacy.html');
    assert.ok(html.includes('المزادات'));
    assert.ok(html.includes('مزايد'));
    assert.ok(html.includes('ميكروفون') || html.includes('الميكروفون'));
    assert.ok(html.includes('LiveKit') || html.includes('صوت'));
  });

  it('PR-03 terms.html §7 auctions offline settlement', () => {
    const html = read('backend/public/legal/terms.html');
    assert.ok(html.includes('مزادات الفيديو'));
    assert.ok(html.includes('خارج التطبيق'));
    assert.ok(html.includes('V1'));
  });

  it('PR-04 iOS PrivacyInfo declares audio for host broadcast', () => {
    const xml = read('app/ios/Runner/PrivacyInfo.xcprivacy');
    assert.ok(xml.includes('NSPrivacyCollectedDataTypeAudioData'));
  });

  it('PR-05 Android RECORD_AUDIO + auction mic string in Info.plist', () => {
    const manifest = read('app/android/app/src/main/AndroidManifest.xml');
    assert.ok(manifest.includes('RECORD_AUDIO'));
    const plist = read('app/ios/Runner/Info.plist');
    assert.ok(plist.includes('NSMicrophoneUsageDescription'));
    assert.ok(plist.includes('المحرّج') || plist.includes('محرّج'));
  });

  it('PR-05 auction compliance doc for store (mic/UGC/data)', () => {
    const doc = read('backend/public/legal/auction-store-impact.md');
    assert.ok(doc.includes('Microphone'));
    assert.ok(doc.includes('UGC'));
    assert.ok(doc.includes('Data Safety'));
  });

  it('PR-06 Flutter V1 policy constants present', () => {
    const dart = read('app/lib/features/auctions/constants/auction_v1_policy.dart');
    assert.ok(dart.includes('خارج التطبيق'));
    assert.ok(dart.includes('Escrow') || dart.includes('ضمان'));
  });

  it('PR-06 live screen references settlement note in bid flow', () => {
    const live = read('app/lib/features/auctions/screens/auction_live_screen.dart');
    assert.ok(live.includes('auction_v1_policy'));
    assert.ok(live.includes('auctionBidConfirmSettlementNote'));
  });
});
