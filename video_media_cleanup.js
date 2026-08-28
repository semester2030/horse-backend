'use strict';

/**
 * Durable Cloudflare Stream cleanup for replaced / soft-deleted Haraj videos.
 *
 * Queue lives on each video as:
 *   pendingCleanupCloudflareVideoIds: string[]
 *
 * Never deletes the currently canonical cloudflareVideoId.
 * Never deletes UIDs that are not on the video's cleanup queue.
 * Delete failure leaves UID on the queue for retry; canonical media untouched.
 */

function normalizeUid(uid) {
  return String(uid || '').trim();
}

function readCleanupQueue(video) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const uid = normalizeUid(raw);
    if (!uid || seen.has(uid)) return;
    seen.add(uid);
    out.push(uid);
  };
  if (Array.isArray(video?.pendingCleanupCloudflareVideoIds)) {
    for (const u of video.pendingCleanupCloudflareVideoIds) push(u);
  }
  // Migrate legacy single-field design so Replacement B cannot drop UID A.
  push(video?.pendingCleanupCloudflareVideoId);
  return out;
}

function enqueueCleanupUid(video, uid) {
  const queue = readCleanupQueue(video);
  const next = normalizeUid(uid);
  const current = normalizeUid(video?.cloudflareVideoId);
  if (!next) return queue;
  // Never schedule deletion of the live canonical UID.
  if (current && next === current) return queue;
  if (!queue.includes(next)) queue.push(next);
  return queue;
}

/**
 * After a successful media switch: append old UID; preserve prior queue entries.
 */
function applyMediaSwitchWithCleanupQueue(existing, media) {
  const oldUid = normalizeUid(existing.cloudflareVideoId) || null;
  const switched = {
    ...existing,
    cloudflareVideoId: media.cloudflareVideoId,
    hlsUrl: media.hlsUrl,
    ...(media.thumbnailUrl ? { thumbnailUrl: media.thumbnailUrl } : {}),
    previousCloudflareVideoId: oldUid,
    mediaReplacedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Build queue from *existing* then enqueue old after switch so current≠old.
  let queue = readCleanupQueue(existing);
  const nextCurrent = normalizeUid(media.cloudflareVideoId);
  queue = queue.filter((u) => u !== nextCurrent);
  if (oldUid && oldUid !== nextCurrent && !queue.includes(oldUid)) {
    queue.push(oldUid);
  }
  switched.pendingCleanupCloudflareVideoIds = queue;
  delete switched.pendingCleanupCloudflareVideoId;
  return switched;
}

/**
 * Soft-delete: retain listing soft state and enqueue physical Stream UID.
 */
function applySoftDeleteWithCleanup(existing) {
  const base = {
    ...existing,
    hidden: true,
    status: 'removed',
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // After soft-delete the Stream asset is no longer needed for public play.
  // Enqueue current UID (canonical is still stored for reference until cleaned).
  const uid = normalizeUid(existing.cloudflareVideoId);
  const queue = readCleanupQueue(existing);
  // Allow cleanup of the soft-deleted video's own Stream asset.
  if (uid && !queue.includes(uid)) queue.push(uid);
  base.pendingCleanupCloudflareVideoIds = queue;
  delete base.pendingCleanupCloudflareVideoId;
  // Mark that CF may delete this UID even if it matches stored cloudflareVideoId.
  base.mediaCleanupAllowCurrentUid = true;
  return base;
}

/**
 * @param {{ ok: boolean, notFound?: boolean, retryable?: boolean, error?: string }} result
 */
function applyCleanupResult(video, uid, result) {
  const queue = readCleanupQueue(video);
  const target = normalizeUid(uid);
  if (!target) return { video, changed: false };

  if (result.ok || result.notFound) {
    const next = queue.filter((u) => u !== target);
    if (next.length === queue.length) {
      return { video, changed: false };
    }
    const updated = {
      ...video,
      pendingCleanupCloudflareVideoIds: next,
      updatedAt: new Date().toISOString(),
    };
    delete updated.pendingCleanupCloudflareVideoId;
    if (next.length === 0) {
      delete updated.mediaCleanupAllowCurrentUid;
    }
    return { video: updated, changed: true };
  }

  // Failure: keep UID on queue for retry; never mutate canonical media.
  return { video, changed: false };
}

function shouldSkipDeleteForLiveUid(video, uid) {
  const current = normalizeUid(video.cloudflareVideoId);
  const target = normalizeUid(uid);
  if (!current || !target) return false;
  if (current !== target) return false;
  // Soft-deleted videos explicitly allow cleaning their last Stream UID.
  return video.mediaCleanupAllowCurrentUid !== true;
}

/**
 * One cleanup tick over all videos. Inject deleteStreamUid for tests.
 * deleteStreamUid(uid) → { ok, notFound?, retryable?, error? }
 */
async function runVideoMediaCleanupTick({
  store,
  saveStore,
  deleteStreamUid,
  limitPerTick = 20,
} = {}) {
  if (!store?.videos || typeof deleteStreamUid !== 'function') {
    return { processed: 0, deleted: 0, failed: 0, skipped: 0 };
  }
  let processed = 0;
  let deleted = 0;
  let failed = 0;
  let skipped = 0;

  for (const video of store.videos.values()) {
    if (processed >= limitPerTick) break;
    const queue = readCleanupQueue(video);
    if (queue.length === 0) continue;

    let working = video;
    let dirty = false;

    for (const uid of [...queue]) {
      if (processed >= limitPerTick) break;
      processed += 1;

      if (shouldSkipDeleteForLiveUid(working, uid)) {
        skipped += 1;
        continue;
      }

      let result;
      try {
        result = await deleteStreamUid(uid);
      } catch (e) {
        result = {
          ok: false,
          retryable: true,
          error: e?.message || String(e),
        };
      }

      const applied = applyCleanupResult(working, uid, result);
      working = applied.video;
      if (applied.changed) {
        dirty = true;
        deleted += 1;
      } else if (!result.ok && !result.notFound) {
        failed += 1;
      }
    }

    if (dirty) {
      store.videos.set(working.id, working);
      if (typeof saveStore === 'function') saveStore();
    }
  }

  return { processed, deleted, failed, skipped };
}

function createVideoMediaCleanupWorker({
  store,
  saveStore,
  deleteStreamUid,
  intervalMs = 60_000,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      return await runVideoMediaCleanupTick({
        store,
        saveStore,
        deleteStreamUid,
      });
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((e) =>
        console.error('[video-media-cleanup]', e?.message || e),
      );
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}

/**
 * Cloudflare Stream DELETE helper factory.
 * 404 / already gone → notFound (idempotent success).
 */
function createCloudflareStreamDeleter({
  accountId,
  apiToken,
  fetchImpl = fetch,
} = {}) {
  return async function deleteStreamUid(uid) {
    const id = normalizeUid(uid);
    if (!id) return { ok: false, retryable: false, error: 'empty_uid' };
    if (!accountId || !apiToken) {
      return { ok: false, retryable: true, error: 'cf_not_configured' };
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${id}`;
    try {
      const r = await fetchImpl(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (r.status === 404) {
        return { ok: true, notFound: true };
      }
      const text = await r.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* ignore */
      }
      if (r.ok && data?.success !== false) {
        return { ok: true };
      }
      // CF sometimes returns errors array with code 10004 not found
      const errCode = data?.errors?.[0]?.code;
      if (r.status === 404 || errCode === 10004 || errCode === 404) {
        return { ok: true, notFound: true };
      }
      return {
        ok: false,
        retryable: r.status >= 500 || r.status === 429,
        error: data?.errors?.[0]?.message || `HTTP ${r.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        retryable: true,
        error: e?.message || String(e),
      };
    }
  };
}

module.exports = {
  normalizeUid,
  readCleanupQueue,
  enqueueCleanupUid,
  applyMediaSwitchWithCleanupQueue,
  applySoftDeleteWithCleanup,
  applyCleanupResult,
  shouldSkipDeleteForLiveUid,
  runVideoMediaCleanupTick,
  createVideoMediaCleanupWorker,
  createCloudflareStreamDeleter,
};
