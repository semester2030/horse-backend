'use strict';

const { mapHostRow } = require('./host_service');

async function discoverHosts(pool, {
  species,
  city,
  windowStart,
  windowEnd,
  limit = 20,
} = {}) {
  const params = [];
  const clauses = [`h.status = 'active'`, `h.verified_at IS NOT NULL`];

  if (species) {
    params.push(species);
    clauses.push(`$${params.length} = ANY(h.specialties)`);
  }
  if (city) {
    params.push(`%${city}%`);
    clauses.push(`h.city ILIKE $${params.length}`);
  }

  let availabilitySql = '';
  if (windowStart && windowEnd) {
    params.push(windowStart, windowEnd);
    const a = params.length - 1;
    const b = params.length;
    availabilitySql = `
      AND EXISTS (
        SELECT 1 FROM host_availability ha
        WHERE ha.host_id = h.id AND ha.slot_type = 'available'
          AND ha.start_at <= $${a}::timestamptz AND ha.end_at >= $${b}::timestamptz
      )
      AND NOT EXISTS (
        SELECT 1 FROM host_bookings hb
        WHERE hb.host_id = h.id AND hb.status IN ('requested','scheduled')
          AND hb.scheduled_start_at IS NOT NULL
          AND tstzrange(hb.scheduled_start_at, hb.scheduled_end_at, '[)') &&
              tstzrange($${a}::timestamptz, $${b}::timestamptz, '[)')
      )`;
  }

  params.push(Math.min(Number(limit) || 20, 50));
  const sql = `
    SELECT h.*,
      (SELECT COUNT(*)::int FROM host_bookings hb
       JOIN auctions a ON a.id = hb.auction_id
       WHERE hb.host_id = h.id AND hb.status = 'scheduled'
         AND a.status IN ('ended','sold','unsold')) AS completed_auctions_count
    FROM auction_hosts h
    WHERE ${clauses.join(' AND ')}${availabilitySql}
    ORDER BY h.verified_at DESC NULLS LAST
    LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows.map(mapHostRow);
}

module.exports = { discoverHosts };
