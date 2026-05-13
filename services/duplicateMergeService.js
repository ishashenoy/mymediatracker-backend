const UniqueMedia = require('../models/uniqueMediaModel');
const UserMedia = require('../models/userMediaModel');
const Event = require('../models/eventModel');
const Post = require('../models/postModel');
const { sanitizeUrl } = require('../utils/sanitize');

const SUPPORTED_MERGE_TYPES = new Set(['anime', 'manga', 'game', 'movie', 'tv', 'book']);
const ALWAYS_PIN_IMAGE_TYPES = new Set(['anime', 'manga']);
const CANONICAL_SOURCE_BY_TYPE = {
  anime: 'mal',
  manga: 'mal',
  game: 'rawg',
  movie: 'tmdb',
  tv: 'tvmaze',
  book: 'googlebooks',
};

function createHttpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeSource(value) {
  return String(value || '').trim().toLowerCase();
}

function toIdString(value) {
  return value ? String(value) : '';
}

function uniqueStringIds(values) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

function summarizeUniqueMedia(item) {
  return {
    _id: toIdString(item?._id),
    type: item?.type || '',
    normalized_name: item?.normalized_name || '',
    source: normalizeSource(item?.source),
    media_id: item?.media_id ? String(item.media_id) : '',
    name: item?.name || '',
    image_url: item?.image_url || '',
  };
}

function emptyStats() {
  return {
    userMediaReassigned: 0,
    eventsReassigned: 0,
    postLinkedMediaDocsUpdated: 0,
    postLinkedMediasDocsUpdated: 0,
    postLinkedMediasAttachmentsUpdated: 0,
    duplicateRowsTargeted: 0,
    duplicateRowsDeleted: 0,
  };
}

function addStats(target, partial) {
  target.userMediaReassigned += partial.userMediaReassigned;
  target.eventsReassigned += partial.eventsReassigned;
  target.postLinkedMediaDocsUpdated += partial.postLinkedMediaDocsUpdated;
  target.postLinkedMediasDocsUpdated += partial.postLinkedMediasDocsUpdated;
  target.postLinkedMediasAttachmentsUpdated += partial.postLinkedMediasAttachmentsUpdated;
  target.duplicateRowsTargeted += partial.duplicateRowsTargeted;
  target.duplicateRowsDeleted += partial.duplicateRowsDeleted;
}

function getPinnedCoverImage(userMedia, previousUniqueMedia) {
  const currentDisplayedImage =
    userMedia.use_custom_display && userMedia.custom_image_url
      ? userMedia.custom_image_url
      : previousUniqueMedia.image_url || '';

  return sanitizeUrl(currentDisplayedImage || '');
}

function buildPostReplacementFields(survivor) {
  return {
    unique_media_id: survivor._id,
    name: survivor.name || null,
    image_url: sanitizeUrl(survivor.image_url) || null,
    type: survivor.type || null,
    source: normalizeSource(survivor.source) || null,
    media_id: survivor.media_id ? String(survivor.media_id) : null,
  };
}

async function countArrayLinkedMediaReferences(duplicateId) {
  const result = await Post.aggregate([
    { $match: { linked_medias: { $elemMatch: { unique_media_id: duplicateId } } } },
    {
      $project: {
        matchCount: {
          $size: {
            $filter: {
              input: '$linked_medias',
              as: 'item',
              cond: { $eq: ['$$item.unique_media_id', duplicateId] },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        postCount: { $sum: 1 },
        attachmentCount: { $sum: '$matchCount' },
      },
    },
  ]);

  return {
    postCount: result[0]?.postCount || 0,
    attachmentCount: result[0]?.attachmentCount || 0,
  };
}

async function countRemainingReferences(duplicateIds) {
  const duplicateIdFilter = { $in: duplicateIds };

  const [userMediaCount, eventCount, linkedMediaPostCount, linkedMediasPostCount] =
    await Promise.all([
      UserMedia.countDocuments({ unique_media_ref: duplicateIdFilter }),
      Event.countDocuments({ unique_media_id: duplicateIdFilter }),
      Post.countDocuments({ 'linked_media.unique_media_id': duplicateIdFilter }),
      Post.countDocuments({ linked_medias: { $elemMatch: { unique_media_id: duplicateIdFilter } } }),
    ]);

  return {
    userMediaCount,
    eventCount,
    linkedMediaPostCount,
    linkedMediasPostCount,
    total: userMediaCount + eventCount + linkedMediaPostCount + linkedMediasPostCount,
  };
}

async function migrateDuplicateReferences(duplicate, survivor, options) {
  const duplicateId = duplicate._id;
  const survivorPostFields = buildPostReplacementFields(survivor);

  const [userMediaDocs, eventCount, singularPostCount, arrayLinkedMediaCounts] = await Promise.all([
    UserMedia.find({ unique_media_ref: duplicateId })
      .select(
        '_id user_id rating status progress watched_episodes fav use_custom_display custom_name custom_image_url aspectRatio review_text contains_spoilers rewatch_count format platform started_at finished_at source_of_discovery mood_tags owned dropped_at_progress'
      )
      .lean(),
    Event.countDocuments({ unique_media_id: duplicateId }),
    Post.countDocuments({ 'linked_media.unique_media_id': duplicateId }),
    countArrayLinkedMediaReferences(duplicateId),
  ]);

  const stats = {
    userMediaReassigned: userMediaDocs.length,
    eventsReassigned: eventCount,
    postLinkedMediaDocsUpdated: singularPostCount,
    postLinkedMediasDocsUpdated: arrayLinkedMediaCounts.postCount,
    postLinkedMediasAttachmentsUpdated: arrayLinkedMediaCounts.attachmentCount,
    duplicateRowsTargeted: 1,
    duplicateRowsDeleted: 0,
  };

  if (!options.apply) {
    return stats;
  }

  if (userMediaDocs.length > 0) {
    const userIds = [...new Set(userMediaDocs.map((doc) => String(doc.user_id)))];
    const existingSurvivorRows = await UserMedia.find({
      user_id: { $in: userIds },
      unique_media_ref: survivor._id,
    })
      .select(
        '_id user_id rating status progress watched_episodes fav use_custom_display custom_name custom_image_url aspectRatio review_text contains_spoilers rewatch_count format platform started_at finished_at source_of_discovery mood_tags owned dropped_at_progress'
      )
      .lean();
    const existingByUserId = new Map(existingSurvivorRows.map((doc) => [String(doc.user_id), doc]));
    const bulkOps = [];

    for (const userMedia of userMediaDocs) {
      const pinnedCoverImage = getPinnedCoverImage(userMedia, duplicate);
      const existing = existingByUserId.get(String(userMedia.user_id));

      if (!existing) {
        const set = {
          unique_media_ref: survivor._id,
        };

        if (ALWAYS_PIN_IMAGE_TYPES.has(survivor.type)) {
          set.use_custom_display = true;
          set.custom_image_url = pinnedCoverImage;
        } else if (pinnedCoverImage) {
          set.use_custom_display = true;
          set.custom_image_url = pinnedCoverImage;
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: userMedia._id, unique_media_ref: duplicateId },
            update: { $set: set },
          },
        });
        continue;
      }

      const set = {};
      if (existing.rating == null && userMedia.rating != null) set.rating = userMedia.rating;
      if (!existing.status && userMedia.status) set.status = userMedia.status;
      if (existing.progress == null && userMedia.progress != null) set.progress = userMedia.progress;
      if (!existing.review_text && userMedia.review_text) set.review_text = userMedia.review_text;
      if (!existing.fav && userMedia.fav) set.fav = true;
      if (!existing.custom_name && userMedia.custom_name) set.custom_name = userMedia.custom_name;
      if (existing.aspectRatio == null && userMedia.aspectRatio != null) set.aspectRatio = userMedia.aspectRatio;
      if (!existing.format && userMedia.format) set.format = userMedia.format;
      if (!existing.platform && userMedia.platform) set.platform = userMedia.platform;
      if (!existing.started_at && userMedia.started_at) set.started_at = userMedia.started_at;
      if (!existing.finished_at && userMedia.finished_at) set.finished_at = userMedia.finished_at;
      if (!existing.source_of_discovery && userMedia.source_of_discovery) {
        set.source_of_discovery = userMedia.source_of_discovery;
      }
      if (!existing.owned && userMedia.owned) set.owned = true;
      if (existing.dropped_at_progress == null && userMedia.dropped_at_progress != null) {
        set.dropped_at_progress = userMedia.dropped_at_progress;
      }
      if (!existing.contains_spoilers && userMedia.contains_spoilers) {
        set.contains_spoilers = true;
      }
      if ((existing.rewatch_count || 0) < (userMedia.rewatch_count || 0)) {
        set.rewatch_count = userMedia.rewatch_count;
      }
      if (!(existing.use_custom_display && existing.custom_image_url) && pinnedCoverImage) {
        set.use_custom_display = true;
        set.custom_image_url = pinnedCoverImage;
      }

      const addToSet = {};
      if (Array.isArray(userMedia.mood_tags) && userMedia.mood_tags.length > 0) {
        addToSet.mood_tags = { $each: userMedia.mood_tags };
      }
      if (Array.isArray(userMedia.watched_episodes) && userMedia.watched_episodes.length > 0) {
        addToSet.watched_episodes = { $each: userMedia.watched_episodes };
      }

      const update = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet;

      if (Object.keys(update).length > 0) {
        bulkOps.push({
          updateOne: {
            filter: { _id: existing._id },
            update,
          },
        });
      }

      bulkOps.push({
        deleteOne: {
          filter: { _id: userMedia._id, unique_media_ref: duplicateId },
        },
      });
    }

    if (bulkOps.length > 0) {
      await UserMedia.bulkWrite(bulkOps, { ordered: false });
    }
  }

  if (eventCount > 0) {
    await Event.updateMany({ unique_media_id: duplicateId }, { $set: { unique_media_id: survivor._id } });
  }

  if (singularPostCount > 0) {
    await Post.updateMany(
      { 'linked_media.unique_media_id': duplicateId },
      {
        $set: {
          'linked_media.unique_media_id': survivorPostFields.unique_media_id,
          'linked_media.name': survivorPostFields.name,
          'linked_media.image_url': survivorPostFields.image_url,
          'linked_media.type': survivorPostFields.type,
          'linked_media.source': survivorPostFields.source,
          'linked_media.media_id': survivorPostFields.media_id,
        },
      }
    );
  }

  if (arrayLinkedMediaCounts.attachmentCount > 0) {
    await Post.updateMany(
      { linked_medias: { $elemMatch: { unique_media_id: duplicateId } } },
      {
        $set: {
          'linked_medias.$[item].unique_media_id': survivorPostFields.unique_media_id,
          'linked_medias.$[item].name': survivorPostFields.name,
          'linked_medias.$[item].image_url': survivorPostFields.image_url,
          'linked_medias.$[item].type': survivorPostFields.type,
          'linked_medias.$[item].source': survivorPostFields.source,
          'linked_medias.$[item].media_id': survivorPostFields.media_id,
        },
      },
      {
        arrayFilters: [{ 'item.unique_media_id': duplicateId }],
      }
    );
  }

  return stats;
}

async function validateMergeSelection({ keeperId, duplicateIds }) {
  const keeperIdString = String(keeperId || '').trim();
  const duplicateIdStrings = uniqueStringIds(duplicateIds);

  if (!keeperIdString) {
    throw createHttpError(400, 'keeperId is required.');
  }
  if (duplicateIdStrings.length === 0) {
    throw createHttpError(400, 'At least one duplicate id is required.');
  }
  if (duplicateIdStrings.includes(keeperIdString)) {
    throw createHttpError(400, 'keeperId cannot also be included in duplicateIds.');
  }

  const allRequestedIds = [keeperIdString, ...duplicateIdStrings];
  const docs = await UniqueMedia.find({ _id: { $in: allRequestedIds } })
    .select('_id type normalized_name source media_id name image_url updatedAt')
    .lean();

  const docMap = new Map(docs.map((doc) => [toIdString(doc._id), doc]));
  const keeper = docMap.get(keeperIdString);

  if (!keeper) {
    throw createHttpError(404, 'Selected keeper media was not found.');
  }

  const duplicates = duplicateIdStrings.map((id) => docMap.get(id)).filter(Boolean);
  if (duplicates.length !== duplicateIdStrings.length) {
    throw createHttpError(404, 'One or more duplicate media entries were not found.');
  }

  const type = String(keeper.type || '').trim().toLowerCase();
  const normalizedName = String(keeper.normalized_name || '').trim();
  if (!SUPPORTED_MERGE_TYPES.has(type)) {
    throw createHttpError(400, `Merging is not supported for type "${type || 'unknown'}".`);
  }
  if (!normalizedName) {
    throw createHttpError(400, 'Selected media is missing normalized_name.');
  }

  const outOfGroup = duplicates.find(
    (item) =>
      String(item.type || '').trim().toLowerCase() !== type ||
      String(item.normalized_name || '').trim() !== normalizedName
  );
  if (outOfGroup) {
    throw createHttpError(400, 'All selected media must belong to the same duplicate group.');
  }

  const warnings = [];
  const preferredSource = CANONICAL_SOURCE_BY_TYPE[type];
  const keeperSource = normalizeSource(keeper.source);
  if (preferredSource && keeperSource && keeperSource !== preferredSource) {
    warnings.push(
      `Selected keeper is ${keeperSource.toUpperCase()}, not the usual ${preferredSource.toUpperCase()} source for ${type}.`
    );
  }

  return {
    type,
    normalized_name: normalizedName,
    keeper,
    duplicates,
    warnings,
  };
}

async function previewDuplicateMerge(payload) {
  const selection = await validateMergeSelection(payload || {});
  const stats = emptyStats();

  for (const duplicate of selection.duplicates) {
    const duplicateStats = await migrateDuplicateReferences(duplicate, selection.keeper, { apply: false });
    addStats(stats, duplicateStats);
  }

  return {
    mode: 'preview',
    group: {
      type: selection.type,
      normalized_name: selection.normalized_name,
    },
    keeper: summarizeUniqueMedia(selection.keeper),
    duplicates: selection.duplicates.map(summarizeUniqueMedia),
    stats,
    warnings: selection.warnings,
  };
}

async function applyDuplicateMerge(payload) {
  const selection = await validateMergeSelection(payload || {});
  const stats = emptyStats();

  for (const duplicate of selection.duplicates) {
    const duplicateStats = await migrateDuplicateReferences(duplicate, selection.keeper, { apply: true });
    addStats(stats, duplicateStats);
  }

  const duplicateObjectIds = selection.duplicates.map((item) => item._id);
  const remainingReferences = await countRemainingReferences(duplicateObjectIds);
  if (remainingReferences.total > 0) {
    throw createHttpError(
      409,
      `Verification failed for ${selection.type} | ${selection.normalized_name}.`,
      { remainingReferences }
    );
  }

  const deleteResult = await UniqueMedia.deleteMany({ _id: { $in: duplicateObjectIds } });
  stats.duplicateRowsDeleted = deleteResult.deletedCount || 0;

  return {
    mode: 'apply',
    group: {
      type: selection.type,
      normalized_name: selection.normalized_name,
    },
    keeper: summarizeUniqueMedia(selection.keeper),
    duplicates: selection.duplicates.map(summarizeUniqueMedia),
    stats,
    warnings: selection.warnings,
    verification: {
      passed: true,
      remainingReferences,
    },
  };
}

module.exports = {
  SUPPORTED_MERGE_TYPES,
  previewDuplicateMerge,
  applyDuplicateMerge,
};
