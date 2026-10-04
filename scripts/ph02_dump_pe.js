/**
 * One-off ops helper — print redacted ProfessionalEntity ownership summary.
 * Usage (Render job): node scripts/ph02_dump_pe.js
 */
const fs = require('fs');

const p = process.env.DATA_FILE || '/var/data/store.json';
if (!fs.existsSync(p)) {
  console.log('PE_DUMP_START');
  console.log(JSON.stringify({ error: 'NO_STORE', path: p }));
  console.log('PE_DUMP_END');
  process.exit(0);
}
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const pes = Object.values(d.professionalEntities || {});
const users = d.users || {};
console.log('PE_DUMP_START');
console.log(JSON.stringify({ count: pes.length }, null, 2));
for (const e of pes) {
  const u = users[e.ownerUserId] || {};
  console.log(
    JSON.stringify({
      entityId: e.id,
      ownerUserId: e.ownerUserId,
      publicSlug: e.publicSlug,
      displayName: e.displayName,
      publicationStatus: e.publicationStatus,
      version: e.version,
      city: e.city,
      entityType: e.entityType,
      hasLogo: Boolean(e.logoUrl),
      createdAt: e.createdAt,
      ownerMeta: {
        accountRole: u.accountRole || null,
        name: u.name || null,
        emailHint: u.email
          ? String(u.email).replace(/(.{2}).+(@.+)/, '$1***$2')
          : null,
        phoneHint: u.phone ? `***${String(u.phone).slice(-4)}` : null,
      },
    }),
  );
}
console.log('PE_DUMP_END');
