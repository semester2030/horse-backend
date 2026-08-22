'use strict';

/**
 * Auction developer exemption — admin review bypass only.
 * Configure via AUCTION_DEVELOPER_USER_ID (no hardcoded phone/UID in source).
 * If unset, no exemption applies.
 */
function getAuctionDeveloperUserId() {
  return String(process.env.AUCTION_DEVELOPER_USER_ID || '').trim();
}

function isAuctionDeveloperUserId(userId) {
  const devId = getAuctionDeveloperUserId();
  if (!devId) return false;
  return String(userId || '').trim() === devId;
}

module.exports = {
  getAuctionDeveloperUserId,
  isAuctionDeveloperUserId,
};
