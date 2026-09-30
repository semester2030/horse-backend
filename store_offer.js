'use strict';

/**
 * One publish for a video-section store offer.
 * Commercial rows reuse CatalogItem (category supplies).
 * Informational rows do not create a catalog record.
 * listingChannel video_store keeps the commercial row off the services map.
 */

const crypto = require('crypto');
const detailMedia = require('./detail_media');

const SPECIES = new Set(['horse', 'camel', 'falcon']);
/** Same cap as existing detailMedia, not a new commerce rule. */
const MAX_PRIMARY = 15;

function attempts(store) {
  if (!store.storeOfferAttempts) store.storeOfferAttempts = new Map();
  return store.storeOfferAttempts;
}

function isHttps(url) {
  return /^https:\/\//i.test(String(url || '').trim());
}

function sanitizePrimaryImages(raw) {
  if (raw == null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'primaryImages يجب أن يكون مصفوفة' };
  }
  if (raw.length > MAX_PRIMARY) {
    return { ok: false, message: `الصور الرئيسية تتجاوز ${MAX_PRIMARY}` };
  }
  const images = [];
  for (let i = 0; i < raw.length; i += 1) {
    const e = raw[i];
    const url = String((e && e.url) || '').trim();
    if (!isHttps(url)) {
      return { ok: false, message: `الصورة الرئيسية ${i + 1} بلا رابط https` };
    }
    images.push({
      id: String((e && e.id) || url).trim() || url,
      url,
      order: i,
    });
  }
  return { ok: true, images };
}

function hasPlayback(body) {
  return isHttps(body.hlsUrl);
}

function payloadHash(body, primaryImages, media) {
  const loc = body.storeLocation && typeof body.storeLocation === 'object'
    ? body.storeLocation
    : {};
  const canonical = JSON.stringify({
    name: String(body.serviceName || body.name || '').trim(),
    description: String(body.description || '').trim(),
    species: String(body.targetSpecies || '').trim().toLowerCase(),
    subCategory: String(body.subCategory || '').trim(),
    purchasable: body.purchasable === true,
    price: body.price == null ? null : Number(body.price),
    stock: body.stockQuantity == null || body.stockQuantity === ''
      ? null
      : Number(body.stockQuantity),
    images: primaryImages.map((image) => image.url),
    hls: String(body.hlsUrl || '').trim(),
    thumb: String(body.thumbnailUrl || '').trim(),
    detail: (media || []).map((item) => `${item.role}:${item.url}`),
    lat: loc.lat,
    lng: loc.lng,
    city: String(loc.city || '').trim(),
    address: String(loc.address || '').trim(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function parseStoreLocation(raw) {
  if (raw == null) return { ok: true, location: null };
  if (typeof raw !== 'object') {
    return { ok: false, message: 'موقع المتجر غير صالح' };
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: true, location: null };
  }
  if (lat < 16 || lat > 32.5 || lng < 34.5 || lng > 56) {
    return { ok: false, message: 'موقع المتجر خارج نطاق المملكة' };
  }
  return {
    ok: true,
    location: {
      lat,
      lng,
      city: String(raw.city || '').trim(),
      address: String(raw.address || '').trim(),
      source: 'store',
    },
  };
}

function cartCover(primaryImages, thumbnailUrl) {
  if (primaryImages.length > 0) return primaryImages[0].url;
  const thumb = String(thumbnailUrl || '').trim();
  return isHttps(thumb) ? thumb : '';
}

function publicVideo(video) {
  if (!video) return null;
  return video;
}

function publishStoreOffer({ store, userId, body, createId, now }) {
  const owner = String(userId || '').trim();
  if (!owner) return { ok: false, status: 401, message: 'يلزم تسجيل الدخول' };
  const key = String(body.idempotencyKey || '').trim();
  if (!key || key.length > 80) {
    return { ok: false, status: 400, message: 'مفتاح المحاولة مطلوب' };
  }
  const attemptId = `${owner}::${key}`;
  const map = attempts(store);
  const prev = map.get(attemptId);

  const name = String(body.serviceName || body.name || '').trim();
  if (!name) return { ok: false, status: 400, message: 'اسم العرض مطلوب' };
  const species = String(body.targetSpecies || '').trim().toLowerCase();
  if (!SPECIES.has(species)) {
    return { ok: false, status: 400, message: 'اختر نوع الخيل أو الإبل أو الصقور' };
  }
  const imagesResult = sanitizePrimaryImages(body.primaryImages);
  if (!imagesResult.ok) return { ok: false, status: 400, message: imagesResult.message };
  const primaryImages = imagesResult.images;
  const playback = hasPlayback(body);
  if (primaryImages.length === 0 && !playback) {
    return { ok: false, status: 400, message: 'أضف صورة رئيسية أو فيديوًا رئيسيًا' };
  }
  const mediaApplied = detailMedia.sanitizeDetailMedia(
    Object.prototype.hasOwnProperty.call(body, 'detailMedia') ? body.detailMedia : null,
  );
  if (!mediaApplied.ok) return { ok: false, status: 400, message: mediaApplied.message };
  const detailItems = mediaApplied.detailMedia || [];
  const loc = parseStoreLocation(body.storeLocation);
  if (!loc.ok) return { ok: false, status: 400, message: loc.message };
  const hash = payloadHash(body, primaryImages, detailItems);
  if (prev && prev.status === 'completed' && prev.videoId && store.videos.get(prev.videoId)) {
    if (prev.payloadHash === hash) {
      return {
        ok: true,
        status: 200,
        replay: true,
        payload: {
          replay: true,
          video: publicVideo(store.videos.get(prev.videoId)),
          catalogItem: prev.catalogItemId
            ? store.catalogItems.get(prev.catalogItemId) || null
            : null,
        },
      };
    }
    return {
      ok: false,
      status: 409,
      code: 'PAYLOAD_MISMATCH',
      message: 'هذه المحاولة اكتملت ببيانات مختلفة. ابدأ نشرًا جديدًا ليُحفظ التعديل.',
    };
  }

  const purchasable = body.purchasable === true;
  const price = Number(body.price);
  let stock = null;
  if (purchasable) {
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, status: 400, message: 'سعر البيع يجب أن يكون أكبر من صفر' };
    }
    if (body.stockQuantity == null || body.stockQuantity === '') {
      return { ok: false, status: 400, message: 'أدخل كمية المخزون. لا يُفترض رقم تلقائي' };
    }
    stock = Math.floor(Number(body.stockQuantity));
    if (!Number.isFinite(stock) || stock < 0) {
      return { ok: false, status: 400, message: 'كمية المخزون غير صالحة' };
    }
  }

  const stamp = (now ? now() : new Date()).toISOString();
  let catalogItemId = prev && prev.catalogItemId ? prev.catalogItemId : null;
  const requestedCatalogId = String(body.catalogItemId || '').trim();
  if (!catalogItemId && requestedCatalogId) {
    const requested = store.catalogItems.get(requestedCatalogId);
    if (requested && String(requested.sellerId) === owner) {
      catalogItemId = requestedCatalogId;
    } else if (requested) {
      return {
        ok: false,
        status: 403,
        code: 'CATALOG_FORBIDDEN',
        message: 'لا يمكن ربط منتج لا تملكه',
      };
    } else {
      return {
        ok: false,
        status: 404,
        code: 'CATALOG_NOT_FOUND',
        message: 'المنتج المطلوب ربطه غير موجود',
      };
    }
  }
  let catalogItem = catalogItemId ? store.catalogItems.get(catalogItemId) : null;

  if (purchasable) {
    if (!catalogItem || String(catalogItem.sellerId) !== owner) {
      catalogItemId = createId();
      catalogItem = {
        id: catalogItemId,
        sellerId: owner,
        category: 'supplies',
        listingChannel: 'video_store',
        applicableSpecies: [species],
        subCategory: String(body.subCategory || '').trim(),
        name,
        description: String(body.description || '').trim(),
        images: [cartCover(primaryImages, body.thumbnailUrl)].filter(Boolean),
        price,
        currency: 'SAR',
        stockQuantity: stock,
        inStock: stock > 0,
        status: 'draft',
        location: loc.location || {},
        createdAt: stamp,
        updatedAt: stamp,
      };
      store.catalogItems.set(catalogItemId, catalogItem);
      map.set(attemptId, {
        status: 'catalog_saved',
        catalogItemId,
        videoId: prev && prev.videoId ? prev.videoId : null,
        userId: owner,
      });
    } else {
      catalogItem.name = name;
      catalogItem.description = String(body.description || catalogItem.description || '').trim();
      catalogItem.price = price;
      catalogItem.stockQuantity = stock;
      catalogItem.inStock = stock > 0;
      catalogItem.applicableSpecies = [species];
      catalogItem.subCategory = String(body.subCategory || '').trim();
      catalogItem.images = [cartCover(primaryImages, body.thumbnailUrl)].filter(Boolean);
      catalogItem.location = loc.location || catalogItem.location || {};
      catalogItem.listingChannel = 'video_store';
      catalogItem.updatedAt = stamp;
      store.catalogItems.set(catalogItemId, catalogItem);
    }
  }

  const videoId = (prev && prev.videoId && store.videos.get(prev.videoId))
    ? prev.videoId
    : createId();
  const existingVideo = store.videos.get(videoId);
  const video = {
    ...(existingVideo || {}),
    id: videoId,
    type: 'service',
    serviceType: 'supplies',
    serviceCategory: 'supplies',
    offerChannel: 'video_store',
    serviceName: name,
    description: String(body.description || '').trim(),
    subCategory: String(body.subCategory || '').trim(),
    targetSpecies: species,
    primaryImages,
    thumbnailUrl: String(body.thumbnailUrl || '').trim() || null,
    hlsUrl: isHttps(body.hlsUrl) ? String(body.hlsUrl).trim() : null,
    cloudflareVideoId: isHttps(body.hlsUrl)
      ? (String(body.cloudflareVideoId || '').trim() || null)
      : null,
    detailMedia: detailItems,
    storeLocation: loc.location,
    city: (loc.location && loc.location.city) || '',
    userId: owner,
    offerIntent: purchasable ? 'commercial' : 'informational',
    purchasable: Boolean(purchasable && stock > 0),
    catalogItemId: purchasable ? catalogItemId : null,
    hidden: false,
    status: 'active',
    views: existingVideo ? existingVideo.views || 0 : 0,
    likes: existingVideo ? existingVideo.likes || 0 : 0,
    comments: existingVideo ? existingVideo.comments || 0 : 0,
    createdAt: existingVideo ? existingVideo.createdAt : stamp,
    updatedAt: stamp,
  };
  if (purchasable) {
    video.price = price;
    video.stockQuantity = stock;
  } else {
    delete video.price;
    delete video.stockQuantity;
  }

  store.videos.set(videoId, video);
  if (purchasable && catalogItem) {
    catalogItem.status = 'active';
    catalogItem.inStock = stock > 0;
    catalogItem.updatedAt = stamp;
    store.catalogItems.set(catalogItem.id, catalogItem);
  }
  map.set(attemptId, {
    status: 'completed',
    catalogItemId: purchasable ? catalogItemId : null,
    videoId,
    userId: owner,
    payloadHash: hash,
  });

  return {
    ok: true,
    status: prev ? 200 : 201,
    replay: false,
    payload: {
      replay: false,
      video,
      catalogItem: purchasable ? catalogItem : null,
    },
  };
}

function syncCommercialFromVideo(store, video, patch = {}) {
  if (!video || String(video.offerChannel || '') !== 'video_store') return { changed: false };
  const id = String(video.catalogItemId || '').trim();
  if (!id) return { changed: false };
  const item = store.catalogItems.get(id);
  if (!item || String(item.sellerId) !== String(video.userId)) return { changed: false };
  const touchName = Object.prototype.hasOwnProperty.call(patch, 'serviceName');
  const touchDesc = Object.prototype.hasOwnProperty.call(patch, 'description');
  const touchPrice = Object.prototype.hasOwnProperty.call(patch, 'price');
  const touchSub = Object.prototype.hasOwnProperty.call(patch, 'subCategory');
  const touchStock = Object.prototype.hasOwnProperty.call(patch, 'stockQuantity');
  const touchLoc = Object.prototype.hasOwnProperty.call(patch, 'storeLocation');
  const touchMedia = Object.prototype.hasOwnProperty.call(patch, 'primaryImages')
    || Object.prototype.hasOwnProperty.call(patch, 'thumbnailUrl');
  if (
    !touchName && !touchDesc && !touchPrice && !touchSub
    && !touchStock && !touchLoc && !touchMedia
  ) {
    return { changed: false };
  }
  if (touchName && video.serviceName) item.name = String(video.serviceName).trim();
  if (touchDesc) item.description = String(video.description || '').trim();
  if (touchSub) item.subCategory = String(video.subCategory || '').trim();
  if (touchPrice && video.price != null && Number(video.price) > 0) {
    item.price = Number(video.price);
  }
  if (touchStock && video.stockQuantity != null) {
    const stock = Math.floor(Number(video.stockQuantity));
    if (Number.isFinite(stock) && stock >= 0) {
      item.stockQuantity = stock;
      item.inStock = stock > 0;
    }
  }
  if (touchLoc) {
    if (video.storeLocation && typeof video.storeLocation === 'object') {
      item.location = {
        ...(item.location && typeof item.location === 'object' ? item.location : {}),
        ...video.storeLocation,
      };
    } else if (video.storeLocation == null) {
      item.location = {};
    }
  }
  if (touchMedia) {
    if (Array.isArray(video.primaryImages) && video.primaryImages.length > 0) {
      item.images = [video.primaryImages[0].url];
    } else if (isHttps(video.thumbnailUrl)) {
      item.images = [String(video.thumbnailUrl)];
    }
  }
  item.updatedAt = new Date().toISOString();
  store.catalogItems.set(id, item);
  return { changed: true, item };
}

module.exports = {
  sanitizePrimaryImages,
  publishStoreOffer,
  syncCommercialFromVideo,
  cartCover,
};
