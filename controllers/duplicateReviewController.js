const UniqueMedia = require('../models/uniqueMediaModel');
const {
  previewDuplicateMerge,
  applyDuplicateMerge,
} = require('../services/duplicateMergeService');

function parsePositiveInt(value, fallback, max) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * GET /api/duplicate-review/groups
 * Query: type (optional filter), limit, skip
 * Manga groups require at least one row with source mal.
 * Movie groups require at least one row with source tmdb.
 * Book groups require at least one row with source googlebooks.
 */
async function listDuplicateGroups(req, res) {
  try {
    const typeFilter = String(req.query.type || '').trim().toLowerCase();
    const limit = parsePositiveInt(req.query.limit, 200, 500);
    const skip = Math.max(0, parseInt(String(req.query.skip || '0'), 10) || 0);

    const matchStage = {};
    if (typeFilter) {
      matchStage.type = typeFilter;
    }

    const pipeline = [
      ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
      { $sort: { updatedAt: -1 } },
      {
        $group: {
          _id: { type: '$type', normalized_name: '$normalized_name' },
          count: { $sum: 1 },
          display_name: { $first: '$name' },
          mal_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'mal'] },
                1,
                0,
              ],
            },
          },
          tmdb_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'tmdb'] },
                1,
                0,
              ],
            },
          },
          googlebooks_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'googlebooks'] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      {
        $match: {
          $and: [
            { $or: [{ '_id.type': { $ne: 'manga' } }, { mal_count: { $gt: 0 } }] },
            { $or: [{ '_id.type': { $ne: 'movie' } }, { tmdb_count: { $gt: 0 } }] },
            { $or: [{ '_id.type': { $ne: 'book' } }, { googlebooks_count: { $gt: 0 } }] },
          ],
        },
      },
      { $sort: { count: -1, '_id.normalized_name': 1 } },
      {
        $project: {
          _id: 0,
          type: '$_id.type',
          normalized_name: '$_id.normalized_name',
          display_name: 1,
          count: 1,
        },
      },
      { $skip: skip },
      { $limit: limit },
    ];

    const groups = await UniqueMedia.aggregate(pipeline);

    const countPipeline = [
      ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: { type: '$type', normalized_name: '$normalized_name' },
          count: { $sum: 1 },
          mal_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'mal'] },
                1,
                0,
              ],
            },
          },
          tmdb_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'tmdb'] },
                1,
                0,
              ],
            },
          },
          googlebooks_count: {
            $sum: {
              $cond: [
                { $eq: [{ $toLower: { $ifNull: ['$source', ''] } }, 'googlebooks'] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      {
        $match: {
          $and: [
            { $or: [{ '_id.type': { $ne: 'manga' } }, { mal_count: { $gt: 0 } }] },
            { $or: [{ '_id.type': { $ne: 'movie' } }, { tmdb_count: { $gt: 0 } }] },
            { $or: [{ '_id.type': { $ne: 'book' } }, { googlebooks_count: { $gt: 0 } }] },
          ],
        },
      },
      { $count: 'total' },
    ];
    const countResult = await UniqueMedia.aggregate(countPipeline);
    const total = countResult[0]?.total ?? 0;

    return res.status(200).json({ groups, total, skip, limit });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/duplicate-review/groups/:type/:normalizedName/items
 */
async function getDuplicateGroupItems(req, res) {
  try {
    const type = String(req.params.type || '').trim().toLowerCase();
    let normalizedName = req.params.normalizedName;
    if (normalizedName !== undefined && normalizedName !== null) {
      try {
        normalizedName = decodeURIComponent(String(normalizedName));
      } catch {
        normalizedName = String(normalizedName);
      }
    } else {
      normalizedName = '';
    }

    if (!type || !normalizedName) {
      return res.status(400).json({ error: 'type and normalized_name are required' });
    }

    const items = await UniqueMedia.find({
      type,
      normalized_name: normalizedName,
    })
      .select('_id media_id name image_url source type normalized_name updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({ type, normalized_name: normalizedName, items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function previewMerge(req, res) {
  try {
    const result = await previewDuplicateMerge(req.body || {});
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
}

async function applyMerge(req, res) {
  try {
    const result = await applyDuplicateMerge(req.body || {});
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
}

module.exports = {
  listDuplicateGroups,
  getDuplicateGroupItems,
  previewMerge,
  applyMerge,
};
