/** فلاتر وترقيم صفحات مشتركة للوحة الإدارة */

function paginate(list, page = 1, limit = 50) {
  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));
  const total = list.length;
  const start = (p - 1) * l;
  return {
    items: list.slice(start, start + l),
    page: p,
    limit: l,
    total,
    totalPages: Math.ceil(total / l) || 1,
  };
}

function matchQuery(text, q) {
  if (!q) return true;
  return String(text || '').toLowerCase().includes(String(q).toLowerCase());
}

function filterByDate(list, field, from, to) {
  let out = list;
  if (from) {
    const t = new Date(from).getTime();
    out = out.filter((x) => new Date(x[field] || x.createdAt || 0).getTime() >= t);
  }
  if (to) {
    const t = new Date(to).getTime();
    out = out.filter((x) => new Date(x[field] || x.createdAt || 0).getTime() <= t);
  }
  return out;
}

function neighborhoodFromItem(item) {
  return (
    item.neighborhood ||
    item.district ||
    item.area ||
    item.hay ||
    item.location?.neighborhood ||
    ''
  );
}

function cityFromItem(item) {
  return item.city || item.location?.city || '';
}

function estimateMediaSize(item) {
  if (item.sizeBytes != null) return Number(item.sizeBytes) || 0;
  if (item.fileSizeBytes != null) return Number(item.fileSizeBytes) || 0;
  if (item.videoSizeBytes != null) return Number(item.videoSizeBytes) || 0;
  return 0;
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

module.exports = {
  paginate,
  matchQuery,
  filterByDate,
  neighborhoodFromItem,
  cityFromItem,
  estimateMediaSize,
  formatBytes,
};
