const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const MediaRequest = require('../models/mediaRequestModel');
const { MEDIA_REQUEST_TYPES, AIRING_STATUS_VALUES } = require('../models/mediaRequestModel');
const UniqueMedia = require('../models/uniqueMediaModel');
const User = require('../models/userModel');
const { isAdminUser } = require('../utils/privacy');
const { sanitizeText, sanitizeUrl } = require('../utils/sanitize');
const { IMAGE_TRANSFORMS } = require('../utils/imageTransformProfiles');
const { createNotification } = require('./notificationController');

cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

const EPISODE_TYPES = new Set(['tv', 'anime', 'web-video', 'manga']);

function normalizeName(name = '') {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ');
}

async function upsertInternalUniqueMediaFromRequest(requestDoc) {
  if (!requestDoc || requestDoc.review_status !== 'approved') return null;
  const mediaType = String(requestDoc.type || '').trim().toLowerCase();
  const mediaTitle = sanitizeText(requestDoc.title, { maxLen: 200, allowNewlines: false });
  if (!mediaType || !mediaTitle) return null;

  const mediaId = `mr_${requestDoc._id.toString()}`;
  const imageUrl = sanitizeUrl(requestDoc.image_url) || '';
  const description = sanitizeText(requestDoc.description, { maxLen: 4000, allowNewlines: true }) || '';

  return UniqueMedia.findOneAndUpdate(
    { source: 'internal', media_id: mediaId, type: mediaType },
    {
      $set: {
        source: 'internal',
        media_id: mediaId,
        type: mediaType,
        name: mediaTitle,
        normalized_name: normalizeName(mediaTitle),
        image_url: imageUrl,
        description,
        created_by: requestDoc.user_id || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

async function removeInternalUniqueMediaForRequest(requestId, mediaType) {
  const cleanType = String(mediaType || '').trim().toLowerCase();
  if (!requestId || !cleanType) return;
  const mediaId = `mr_${requestId.toString()}`;
  await UniqueMedia.deleteOne({ source: 'internal', media_id: mediaId, type: cleanType });
}

function normalizeTags(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,;\n]+/).map((s) => s.trim())
      : [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const s = sanitizeText(t, { maxLen: 40, allowNewlines: false });
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

function parseEpisodeCount(raw, mediaType) {
  if (!EPISODE_TYPES.has(mediaType)) return null;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 50000) return null;
  return n;
}

function parseYear(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1800 || n > 2100) return null;
  return n;
}

function parseAiringStatus(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (!AIRING_STATUS_VALUES.includes(s)) return undefined; // invalid signal
  return s;
}

function buildMetadataPayload(body, mediaType) {
  const payload = {};
  if (body.tags !== undefined) {
    payload.tags = normalizeTags(body.tags);
    if (payload.tags === undefined) delete payload.tags;
  }
  if (body.description !== undefined) {
    payload.description = sanitizeText(body.description, { maxLen: 4000, allowNewlines: true });
  }
  if (body.runtime !== undefined) {
    payload.runtime = sanitizeText(body.runtime, { maxLen: 80, allowNewlines: false });
  }
  if (body.age_rating !== undefined) {
    payload.age_rating = sanitizeText(body.age_rating, { maxLen: 32, allowNewlines: false });
  }
  if (body.episode_count !== undefined) {
    payload.episode_count = parseEpisodeCount(body.episode_count, mediaType);
  }
  if (body.year !== undefined) {
    payload.year = parseYear(body.year);
  }
  if (body.airing_status !== undefined) {
    const a = parseAiringStatus(body.airing_status);
    if (a === undefined && body.airing_status !== null && body.airing_status !== '') {
      return { error: 'Invalid airing status.' };
    }
    payload.airing_status = a;
  }
  return { payload };
}

function serializeRequest(doc, { userId }) {
  const id = doc._id.toString();
  const uid = doc.user_id?.toString?.() || String(doc.user_id);
  return {
    _id: id,
    user_id: uid,
    title: doc.title,
    type: doc.type,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    mine: userId && uid === userId.toString(),
    image_url: doc.image_url || '',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    description: doc.description || '',
    episode_count: doc.episode_count != null ? doc.episode_count : null,
    year: doc.year != null ? doc.year : null,
    runtime: doc.runtime || '',
    airing_status: doc.airing_status || null,
    age_rating: doc.age_rating || '',
    review_status:
      doc.review_status === 'approved' || doc.review_status === 'rejected' ? doc.review_status : 'pending',
    reviewed_at: doc.reviewed_at || null,
    reviewed_by: doc.reviewed_by ? doc.reviewed_by.toString() : null,
  };
}

function serializeRequestDetail(doc, { userId, requesterUser, reviewerUser }) {
  const base = serializeRequest(doc, { userId });
  const requester = requesterUser
    ? {
        id: requesterUser._id.toString(),
        username: requesterUser.username,
        displayName: requesterUser.displayName || '',
        icon: requesterUser.icon || null,
        is_admin_badge: isAdminUser(requesterUser),
      }
    : {
        id: base.user_id,
        username: null,
        displayName: '',
        icon: null,
        is_admin_badge: false,
      };

  const reviewer =
    reviewerUser && reviewerUser.username
      ? {
          id: reviewerUser._id.toString(),
          username: reviewerUser.username,
          displayName: reviewerUser.displayName || '',
        }
      : null;

  return {
    ...base,
    requester,
    reviewer,
  };
}

const listMediaRequests = async (req, res) => {
  try {
    const userId = req.user._id;
    const requester = await User.findById(userId)
      .select('role isAdmin is_admin is_admin_badge is_creator_badge')
      .lean();
    const canModerate = isAdminUser(requester);
    const query = canModerate ? {} : { user_id: userId };
    const rows = await MediaRequest.find(query).lean();
    const enriched = rows.map((r) => serializeRequest(r, { userId }));

    enriched.sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return res.status(200).json({ requests: enriched, can_moderate: canModerate });
  } catch (err) {
    console.error('listMediaRequests', err);
    return res.status(500).json({ error: err.message || 'Failed to load requests.' });
  }
};

const getMediaRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const doc = await MediaRequest.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    const requester = await User.findById(req.user._id)
      .select('role isAdmin is_admin is_admin_badge is_creator_badge')
      .lean();
    const canModerate = isAdminUser(requester);
    if (!canModerate && String(doc.user_id) !== String(req.user._id)) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const [requesterUser, reviewer] = await Promise.all([
      User.findById(doc.user_id).select('username displayName icon is_admin_badge is_creator_badge role isAdmin is_admin').lean(),
      doc.reviewed_by
        ? User.findById(doc.reviewed_by).select('username displayName').lean()
        : Promise.resolve(null),
    ]);

    return res.status(200).json({
      request: serializeRequestDetail(doc, {
        userId: req.user._id,
        requesterUser,
        reviewerUser: reviewer,
      }),
    });
  } catch (err) {
    console.error('getMediaRequestById', err);
    return res.status(500).json({ error: err.message || 'Failed to load request.' });
  }
};

const createMediaRequest = async (req, res) => {
  try {
    const body = req.body || {};
    const { title, type } = body;
    const safeTitle = sanitizeText(title, { maxLen: 200, allowNewlines: false });
    if (!safeTitle || safeTitle.length < 2) {
      return res.status(400).json({ error: 'Please enter a title (at least 2 characters).' });
    }
    const t = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (!MEDIA_REQUEST_TYPES.includes(t)) {
      return res.status(400).json({ error: 'Invalid media type.' });
    }

    const meta = buildMetadataPayload(body, t);
    if (meta.error) {
      return res.status(400).json({ error: meta.error });
    }
    const p = meta.payload;

    const doc = await MediaRequest.create({
      user_id: req.user._id,
      title: safeTitle,
      type: t,
      tags: p.tags !== undefined ? p.tags : [],
      description: p.description !== undefined ? p.description : '',
      episode_count: p.episode_count !== undefined ? p.episode_count : null,
      year: p.year !== undefined ? p.year : null,
      runtime: p.runtime !== undefined ? p.runtime : '',
      airing_status: p.airing_status !== undefined ? p.airing_status : null,
      age_rating: p.age_rating !== undefined ? p.age_rating : '',
    });

    const lean = doc.toObject();
    return res.status(201).json({
      request: serializeRequest(lean, { userId: req.user._id }),
    });
  } catch (err) {
    console.error('createMediaRequest', err);
    return res.status(500).json({ error: err.message || 'Failed to create request.' });
  }
};

const updateMediaRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const existing = await MediaRequest.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (!existing.user_id.equals(req.user._id)) {
      return res.status(403).json({ error: 'You can only edit your own requests.' });
    }

    const body = req.body || {};
    const updates = {};

    if (body.title !== undefined) {
      const safeTitle = sanitizeText(body.title, { maxLen: 200, allowNewlines: false });
      if (!safeTitle || safeTitle.length < 2) {
        return res.status(400).json({ error: 'Please enter a title (at least 2 characters).' });
      }
      updates.title = safeTitle;
    }

    let nextType = existing.type;
    if (body.type !== undefined) {
      const t = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
      if (!MEDIA_REQUEST_TYPES.includes(t)) {
        return res.status(400).json({ error: 'Invalid media type.' });
      }
      updates.type = t;
      nextType = t;
    }

    const meta = buildMetadataPayload(body, nextType);
    if (meta.error) {
      return res.status(400).json({ error: meta.error });
    }
    const p = meta.payload;

    if (p.tags !== undefined) updates.tags = p.tags;
    if (p.description !== undefined) updates.description = p.description;
    if (p.runtime !== undefined) updates.runtime = p.runtime;
    if (p.age_rating !== undefined) updates.age_rating = p.age_rating;
    if (p.episode_count !== undefined) updates.episode_count = p.episode_count;
    if (p.year !== undefined) updates.year = p.year;
    if (p.airing_status !== undefined) updates.airing_status = p.airing_status;

    if (body.clear_cover === true) {
      updates.image_url = '';
    }

    if (!EPISODE_TYPES.has(nextType) && (body.type !== undefined || body.episode_count !== undefined)) {
      updates.episode_count = null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const doc = await MediaRequest.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
    return res.status(200).json({
      request: serializeRequest(doc, { userId: req.user._id }),
    });
  } catch (err) {
    console.error('updateMediaRequest', err);
    return res.status(500).json({ error: err.message || 'Failed to update request.' });
  }
};

const uploadMediaRequestCover = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Image file is required.' });
  }
  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image files are allowed.' });
  }

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ error: 'Request not found.' });
  }

  try {
    const userId = String(req.user?._id || '').trim();
    if (!userId) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    const row = await MediaRequest.findOne({ _id: id, user_id: req.user._id }).select('_id');
    if (!row) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const publicId = `media-request-covers/${userId}/${id}`;

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            public_id: publicId,
            overwrite: true,
            format: 'webp',
            transformation: IMAGE_TRANSFORMS.mediaCover,
          },
          (error, uploadResult) => {
            if (error) reject(error);
            else resolve(uploadResult);
          }
        )
        .end(req.file.buffer);
    });

    const imageUrl = result.secure_url;
    const doc = await MediaRequest.findByIdAndUpdate(
      id,
      { $set: { image_url: imageUrl } },
      { new: true }
    ).lean();

    return res.status(200).json({
      image_url: imageUrl,
      request: serializeRequest(doc, { userId: req.user._id }),
    });
  } catch (error) {
    console.error('uploadMediaRequestCover', error);
    return res.status(500).json({ error: 'Failed to upload image.' });
  }
};

const setReviewStatus = async (req, res, status) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const doc = await MediaRequest.findByIdAndUpdate(
      id,
      {
        $set: {
          review_status: status,
          reviewed_by: req.user._id,
          reviewed_at: new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    if (status === 'approved') {
      await upsertInternalUniqueMediaFromRequest(doc);
    } else if (status === 'rejected') {
      await removeInternalUniqueMediaForRequest(doc._id, doc.type);
    }

    await createNotification({
      recipientId: doc.user_id,
      actorId: req.user._id,
      type: status === 'approved' ? 'media_request_approved' : 'media_request_rejected',
      entityType: 'media_request',
      entityId: doc._id,
    });

    return res.status(200).json({
      request: serializeRequest(doc, { userId: req.user._id }),
    });
  } catch (err) {
    console.error('setReviewStatus', err);
    return res.status(500).json({ error: err.message || 'Failed to update review status.' });
  }
};

const approveMediaRequest = async (req, res) => setReviewStatus(req, res, 'approved');
const rejectMediaRequest = async (req, res) => setReviewStatus(req, res, 'rejected');

module.exports = {
  listMediaRequests,
  getMediaRequestById,
  createMediaRequest,
  updateMediaRequest,
  uploadMediaRequestCover,
  approveMediaRequest,
  rejectMediaRequest,
  MEDIA_REQUEST_TYPES,
  AIRING_STATUS_VALUES,
};
