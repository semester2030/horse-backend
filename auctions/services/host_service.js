'use strict';

const { appendEvent, transitionAuction, mapAuctionRow } = require('./auction_service');
const {
  canTransitionHost,
  canHostAcceptBookings,
  hostIsActiveAndVerified,
} = require('../domain/host');

function mapHostRow(row) {
  if (!row) return null;
  const ratingCount = Number(row.rating_count || 0);
  const ratingSum = Number(row.rating_sum || 0);
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    displayName: row.display_name,
    profileImageUrl: row.profile_image_url,
    city: row.city,
    bio: row.bio,
    experience: row.experience,
    specialties: row.specialties || [],
    verifiedAt: row.verified_at,
    verifiedByAdminId: row.verified_by_admin_id,
    rejectionReason: row.rejection_reason,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    ratingCount,
    ratingAverage: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    completedAuctionsCount: row.completed_auctions_count != null
      ? Number(row.completed_auctions_count)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBookingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    auctionId: row.auction_id,
    hostId: row.host_id,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    ownerConsentRef: row.owner_consent_ref,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAvailabilityRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    hostId: row.host_id,
    startAt: row.start_at,
    endAt: row.end_at,
    slotType: row.slot_type || 'available',
  };
}

async function getHostById(client, hostId) {
  const { rows } = await client.query(
    `SELECT h.*,
      (SELECT COUNT(*)::int FROM host_bookings hb
       JOIN auctions a ON a.id = hb.auction_id
       WHERE hb.host_id = h.id AND hb.status = 'scheduled'
         AND a.status IN ('ended','sold','unsold')) AS completed_auctions_count
     FROM auction_hosts h WHERE h.id = $1`,
    [hostId],
  );
  return mapHostRow(rows[0]);
}

async function getHostByUserId(client, userId) {
  const { rows } = await client.query(
    `SELECT h.*,
      (SELECT COUNT(*)::int FROM host_bookings hb
       JOIN auctions a ON a.id = hb.auction_id
       WHERE hb.host_id = h.id AND hb.status = 'scheduled'
         AND a.status IN ('ended','sold','unsold')) AS completed_auctions_count
     FROM auction_hosts h WHERE h.user_id = $1`,
    [String(userId)],
  );
  return mapHostRow(rows[0]);
}

async function registerHost(client, input) {
  const existing = await getHostByUserId(client, input.userId);
  if (existing) return existing;

  const { rows } = await client.query(
    `INSERT INTO auction_hosts (
      user_id, status, display_name, profile_image_url, city, bio, experience, specialties
    ) VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      String(input.userId),
      input.displayName || null,
      input.profileImageUrl || null,
      input.city || null,
      input.bio || null,
      input.experience || null,
      input.specialties || [],
    ],
  );
  return mapHostRow(rows[0]);
}

async function updateHostProfile(client, hostId, userId, patch) {
  const host = await getHostById(client, hostId);
  if (!host || String(host.userId) !== String(userId)) {
    const err = new Error('Host not found or forbidden');
    err.code = 'HOST_FORBIDDEN';
    err.status = 403;
    throw err;
  }
  const { rows } = await client.query(
    `UPDATE auction_hosts SET
      display_name = COALESCE($2, display_name),
      profile_image_url = COALESCE($3, profile_image_url),
      city = COALESCE($4, city),
      bio = COALESCE($5, bio),
      experience = COALESCE($6, experience),
      specialties = COALESCE($7, specialties),
      updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      hostId,
      patch.displayName,
      patch.profileImageUrl,
      patch.city,
      patch.bio,
      patch.experience,
      patch.specialties,
    ],
  );
  return mapHostRow(rows[0]);
}

async function verifyHost(client, hostId, adminId) {
  const { rows } = await client.query(
    `UPDATE auction_hosts
     SET status = 'verified', verified_at = NOW(), verified_by_admin_id = $2,
         rejection_reason = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [hostId, adminId],
  );
  if (!rows[0]) {
    const err = new Error('Host not found or not pending');
    err.code = 'HOST_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return mapHostRow(rows[0]);
}

async function activateHost(client, hostId, adminId) {
  const { rows } = await client.query(
    `UPDATE auction_hosts
     SET status = 'active', verified_at = COALESCE(verified_at, NOW()),
         verified_by_admin_id = COALESCE(verified_by_admin_id, $2), updated_at = NOW()
     WHERE id = $1 AND status IN ('verified', 'pending')
     RETURNING *`,
    [hostId, adminId],
  );
  if (!rows[0]) {
    const err = new Error('Host cannot be activated');
    err.code = 'HOST_ACTIVATE_INVALID';
    err.status = 409;
    throw err;
  }
  return mapHostRow(rows[0]);
}

async function rejectHost(client, hostId, adminId, reason) {
  const { rows } = await client.query(
    `UPDATE auction_hosts
     SET status = 'suspended', rejection_reason = $2, suspended_at = NOW(),
         suspended_reason = $2, verified_by_admin_id = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [hostId, reason || 'rejected', adminId],
  );
  if (!rows[0]) {
    const err = new Error('Host not rejectable');
    err.code = 'HOST_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return mapHostRow(rows[0]);
}

async function suspendHost(client, hostId, adminId, reason) {
  const host = await getHostById(client, hostId);
  if (!host || !canTransitionHost(host.status, 'suspended')) {
    const err = new Error('Host cannot be suspended');
    err.code = 'HOST_SUSPEND_INVALID';
    err.status = 409;
    throw err;
  }
  const { rows } = await client.query(
    `UPDATE auction_hosts SET status = 'suspended', suspended_at = NOW(),
      suspended_reason = $2, verified_by_admin_id = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [hostId, reason || 'suspended', adminId],
  );
  return mapHostRow(rows[0]);
}

async function reactivateHost(client, hostId, adminId) {
  const host = await getHostById(client, hostId);
  if (!host || host.status !== 'suspended') {
    const err = new Error('Host not suspended');
    err.code = 'HOST_REACTIVATE_INVALID';
    err.status = 409;
    throw err;
  }
  const next = host.verifiedAt ? 'active' : 'pending';
  const { rows } = await client.query(
    `UPDATE auction_hosts SET status = $2, suspended_at = NULL, suspended_reason = NULL,
      updated_at = NOW(), verified_by_admin_id = $3
     WHERE id = $1 RETURNING *`,
    [hostId, next, adminId],
  );
  return mapHostRow(rows[0]);
}

async function listHosts(client, { status, species, city, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let n = 1;
  if (status) {
    clauses.push(`h.status = $${n++}`);
    params.push(status);
  }
  if (city) {
    clauses.push(`h.city ILIKE $${n++}`);
    params.push(`%${city}%`);
  }
  if (species) {
    clauses.push(`$${n++} = ANY(h.specialties)`);
    params.push(species);
  }
  params.push(Math.min(Number(limit) || 50, 100));
  const sql = `
    SELECT h.*,
      (SELECT COUNT(*)::int FROM host_bookings hb
       JOIN auctions a ON a.id = hb.auction_id
       WHERE hb.host_id = h.id AND hb.status = 'scheduled'
         AND a.status IN ('ended','sold','unsold')) AS completed_auctions_count
    FROM auction_hosts h
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY h.created_at DESC
    LIMIT $${n}`;
  const { rows } = await client.query(sql, params);
  return rows.map(mapHostRow);
}

async function addAvailability(client, input) {
  const slotType = input.slotType === 'unavailable' ? 'unavailable' : 'available';
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  if (!(start < end)) {
    const err = new Error('Invalid availability window');
    err.code = 'HOST_AVAILABILITY_INVALID';
    err.status = 400;
    throw err;
  }

  const host = await getHostById(client, input.hostId);
  if (!host) {
    const err = new Error('Host not found');
    err.code = 'HOST_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const conflict = await client.query(
    `SELECT id FROM host_availability
     WHERE host_id = $1 AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [input.hostId, start.toISOString(), end.toISOString()],
  );
  if (conflict.rows.length) {
    const err = new Error('Host availability conflict');
    err.code = 'HOST_AVAILABILITY_CONFLICT';
    err.status = 409;
    throw err;
  }

  const { rows } = await client.query(
    `INSERT INTO host_availability (host_id, start_at, end_at, slot_type)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.hostId, start.toISOString(), end.toISOString(), slotType],
  );
  return mapAvailabilityRow(rows[0]);
}

async function listAvailability(client, hostId) {
  const { rows } = await client.query(
    `SELECT * FROM host_availability WHERE host_id = $1 ORDER BY start_at ASC`,
    [hostId],
  );
  return rows.map(mapAvailabilityRow);
}

async function getHostCalendar(client, hostId, { from, to } = {}) {
  const availability = await listAvailability(client, hostId);
  const { rows: bookings } = await client.query(
    `SELECT hb.*, a.status AS auction_status, a.start_at AS auction_start, a.end_at AS auction_end
     FROM host_bookings hb
     JOIN auctions a ON a.id = hb.auction_id
     WHERE hb.host_id = $1 AND hb.status IN ('requested','scheduled')
     ORDER BY hb.scheduled_start_at ASC`,
    [hostId],
  );

  const entries = [];

  for (const slot of availability) {
    entries.push({
      kind: slot.slotType === 'unavailable' ? 'unavailable' : 'available',
      startAt: slot.startAt,
      endAt: slot.endAt,
      availabilityId: slot.id,
    });
  }

  for (const b of bookings) {
    let kind = 'reserved';
    if (b.status === 'scheduled') {
      if (['live', 'extended'].includes(b.auction_status)) kind = 'live';
      else if (['ended', 'sold', 'unsold'].includes(b.auction_status)) kind = 'completed';
      else kind = 'scheduled_auction';
    } else if (b.status === 'requested') {
      kind = 'reserved';
    }
    entries.push({
      kind,
      bookingId: b.id,
      auctionId: b.auction_id,
      startAt: b.scheduled_start_at,
      endAt: b.scheduled_end_at,
      status: b.status,
      auctionStatus: b.auction_status,
    });
  }

  return entries.sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  );
}

async function assertHostAvailableForWindow(client, hostId, start, end) {
  const unavailable = await client.query(
    `SELECT id FROM host_availability
     WHERE host_id = $1 AND slot_type = 'unavailable'
       AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [hostId, start.toISOString(), end.toISOString()],
  );
  if (unavailable.rows.length) {
    const err = new Error('Host marked unavailable');
    err.code = 'HOST_MARKED_UNAVAILABLE';
    err.status = 409;
    throw err;
  }

  const avail = await client.query(
    `SELECT id FROM host_availability
     WHERE host_id = $1 AND slot_type = 'available'
       AND start_at <= $2 AND end_at >= $3`,
    [hostId, start.toISOString(), end.toISOString()],
  );
  if (!avail.rows.length) {
    const err = new Error('Host not available in requested window');
    err.code = 'HOST_NOT_AVAILABLE';
    err.status = 409;
    throw err;
  }
}

async function requestHostBooking(client, input) {
  const { rows: hostRows } = await client.query(
    `SELECT * FROM auction_hosts WHERE id = $1 FOR UPDATE`,
    [input.hostId],
  );
  const host = hostRows[0];
  if (!hostIsActiveAndVerified(host)) {
    const err = new Error('Host not active and verified');
    err.code = 'HOST_NOT_ACTIVE';
    err.status = 409;
    throw err;
  }

  const { rows: auctionRows } = await client.query(
    `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
    [input.auctionId],
  );
  const auction = auctionRows[0];
  if (!auction) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (String(auction.owner_user_id) !== String(input.requestedByUserId)) {
    const err = new Error('Only auction owner may request host');
    err.code = 'HOST_BOOKING_OWNER_FORBIDDEN';
    err.status = 403;
    throw err;
  }
  if (!['draft', 'review'].includes(auction.status)) {
    const err = new Error('Auction not eligible for host booking');
    err.code = 'HOST_AUCTION_STATE_INVALID';
    err.status = 409;
    throw err;
  }

  const start = new Date(input.scheduledStartAt);
  const end = new Date(input.scheduledEndAt);
  if (!(start < end)) {
    const err = new Error('Invalid booking window');
    err.code = 'HOST_BOOKING_TIME_INVALID';
    err.status = 400;
    throw err;
  }

  if (start < new Date(auction.start_at) || end > new Date(auction.end_at)) {
    const err = new Error('Booking window must fit auction schedule');
    err.code = 'HOST_BOOKING_AUCTION_TIME_MISMATCH';
    err.status = 409;
    throw err;
  }

  const bookingConflict = await client.query(
    `SELECT id FROM host_bookings
     WHERE host_id = $1 AND status IN ('requested','accepted','scheduled')
       AND scheduled_start_at IS NOT NULL
       AND tstzrange(scheduled_start_at, scheduled_end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [input.hostId, start.toISOString(), end.toISOString()],
  );
  if (bookingConflict.rows.length) {
    const err = new Error('Host schedule conflict');
    err.code = 'HOST_SCHEDULE_CONFLICT';
    err.status = 409;
    throw err;
  }

  await assertHostAvailableForWindow(client, input.hostId, start, end);

  const { rows } = await client.query(
    `INSERT INTO host_bookings (
      auction_id, host_id, status, requested_by_user_id, owner_consent_ref,
      scheduled_start_at, scheduled_end_at
    ) VALUES ($1,$2,'requested',$3,$4,$5,$6)
    RETURNING *`,
    [
      input.auctionId,
      input.hostId,
      String(input.requestedByUserId),
      input.ownerConsentRef || null,
      start.toISOString(),
      end.toISOString(),
    ],
  );

  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: 'host.booking_requested',
    payload: { hostId: input.hostId, bookingId: rows[0].id },
    actorUserId: input.requestedByUserId,
  });

  return mapBookingRow(rows[0]);
}

async function respondHostBooking(client, bookingId, accept, { actorUserId, rejectReason }) {
  const { rows } = await client.query(
    `SELECT hb.*, ah.user_id AS host_user_id
     FROM host_bookings hb
     JOIN auction_hosts ah ON ah.id = hb.host_id
     WHERE hb.id = $1 FOR UPDATE`,
    [bookingId],
  );
  const booking = rows[0];
  if (!booking || booking.status !== 'requested') {
    const err = new Error('Booking not in requested state');
    err.code = 'HOST_BOOKING_INVALID';
    err.status = 409;
    throw err;
  }
  if (String(booking.host_user_id) !== String(actorUserId)) {
    const err = new Error('Only assigned host may respond');
    err.code = 'HOST_BOOKING_FORBIDDEN';
    err.status = 403;
    throw err;
  }

  if (!accept) {
    const { rows: updated } = await client.query(
      `UPDATE host_bookings SET status = 'rejected', reject_reason = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [bookingId, rejectReason || 'rejected'],
    );
    await appendEvent(client, {
      auctionId: booking.auction_id,
      eventType: 'host.booking_rejected',
      payload: { bookingId },
      actorUserId,
    });
    return mapBookingRow(updated[0]);
  }

  const { rows: auctionRows } = await client.query(
    `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
    [booking.auction_id],
  );
  const auction = auctionRows[0];
  if (!['review', 'scheduled'].includes(auction.status)) {
    const err = new Error('Auction must be admin-approved (review) before host accept schedules it');
    err.code = 'HOST_AUCTION_NOT_APPROVED';
    err.status = 409;
    throw err;
  }

  const { rows: updated } = await client.query(
    `UPDATE host_bookings SET status = 'scheduled', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [bookingId],
  );

  if (auction.status === 'review') {
    await transitionAuction(client, auction.id, 'scheduled', { actorUserId });
  }

  await client.query(
    `UPDATE auctions SET host_booking_id = $1, updated_at = NOW() WHERE id = $2`,
    [bookingId, booking.auction_id],
  );

  await appendEvent(client, {
    auctionId: booking.auction_id,
    eventType: 'host.booking_accepted',
    payload: { bookingId },
    actorUserId,
  });

  return mapBookingRow(updated[0]);
}

async function listBookingsForHost(client, hostUserId, { status } = {}) {
  const host = await getHostByUserId(client, hostUserId);
  if (!host) return [];
  const params = [host.id];
  let clause = '';
  if (status) {
    clause = ' AND hb.status = $2';
    params.push(status);
  }
  const { rows } = await client.query(
    `SELECT hb.* FROM host_bookings hb
     WHERE hb.host_id = $1${clause}
     ORDER BY hb.created_at DESC`,
    params,
  );
  return rows.map(mapBookingRow);
}

async function listBookingsForUser(client, userId) {
  const { rows } = await client.query(
    `SELECT hb.* FROM host_bookings hb
     JOIN auctions a ON a.id = hb.auction_id
     WHERE hb.requested_by_user_id = $1 OR a.owner_user_id = $1
     ORDER BY hb.created_at DESC`,
    [String(userId)],
  );
  return rows.map(mapBookingRow);
}

module.exports = {
  registerHost,
  updateHostProfile,
  verifyHost,
  activateHost,
  rejectHost,
  suspendHost,
  reactivateHost,
  getHostById,
  getHostByUserId,
  listHosts,
  addAvailability,
  listAvailability,
  getHostCalendar,
  requestHostBooking,
  respondHostBooking,
  listBookingsForHost,
  listBookingsForUser,
  mapHostRow,
  mapBookingRow,
  mapAvailabilityRow,
  hostIsActiveAndVerified,
};
