const mongoose = require('mongoose');
const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const User = require('../models/userModel');
const UserMedia = require('../models/userMediaModel');

/**
 * Normalize post.linked_list_id whether it is an ObjectId, string, or populated { _id }.
 */
function listRefKey(ref) {
  if (ref == null || ref === '') return '';
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
}

/** Per-list queries — MongoDB < 5 (no $setWindowFields) and error fallback. */
async function buildLinkedListCardMapSequential(listObjectIds) {
  const lists = await List.find({ _id: { $in: listObjectIds } }).lean();
  const map = new Map();

  await Promise.all(
    lists.map(async (list) => {
      const idStr = list._id.toString();
      const [ownerDoc, previewItems, totalCount] = await Promise.all([
        User.findById(list.user_id).select('username icon').lean(),
        ListItem.find({ list_id: list._id })
          .populate({
            path: 'user_media_id',
            populate: { path: 'unique_media_ref' },
          })
          .sort({ position: 1, createdAt: -1 })
          .limit(4)
          .lean(),
        ListItem.countDocuments({ list_id: list._id }),
      ]);

      map.set(idStr, {
        _id: list._id,
        name: list.name,
        cover_image_url: list.cover_image_url || null,
        private: !!list.private,
        items: previewItems,
        totalCount,
        owner: ownerDoc
          ? { username: ownerDoc.username, icon: ownerDoc.icon || null }
          : undefined,
      });
    })
  );

  return map;
}

/**
 * Build a map listId -> payload shaped for list preview cards (same fields as /api/lists/saved items).
 * Batches DB work when MongoDB supports window functions; otherwise falls back to per-list queries.
 */
async function buildLinkedListCardMap(listIds) {
  const uniqueIdStrs = [...new Set(listIds.map(listRefKey).filter(Boolean))];
  if (!uniqueIdStrs.length) return new Map();

  let listObjectIds;
  try {
    listObjectIds = uniqueIdStrs.map((id) => new mongoose.Types.ObjectId(id));
  } catch {
    return new Map();
  }

  const lists = await List.find({ _id: { $in: listObjectIds } }).lean();
  if (!lists.length) return new Map();

  try {
    const ownerIds = [...new Set(lists.map((l) => String(l.user_id)))].map(
      (id) => new mongoose.Types.ObjectId(id)
    );
    const owners = await User.find({ _id: { $in: ownerIds } }).select('username icon').lean();
    const ownerMap = new Map(owners.map((o) => [o._id.toString(), o]));

    const [countRows, topItems] = await Promise.all([
      ListItem.aggregate([
        { $match: { list_id: { $in: listObjectIds } } },
        { $group: { _id: '$list_id', totalCount: { $sum: 1 } } },
      ]),
      ListItem.aggregate([
        { $match: { list_id: { $in: listObjectIds } } },
        {
          $setWindowFields: {
            partitionBy: '$list_id',
            sortBy: { position: 1, createdAt: -1 },
            output: { _previewRank: { $documentNumber: {} } },
          },
        },
        { $match: { _previewRank: { $lte: 4 } } },
        { $project: { _previewRank: 0 } },
      ]),
    ]);

    const countMap = new Map(countRows.map((r) => [r._id.toString(), r.totalCount]));

    const umIdStrs = [
      ...new Set(
        topItems
          .map((li) => li.user_media_id && String(li.user_media_id))
          .filter(Boolean)
      ),
    ];
    const userMedias = umIdStrs.length
      ? await UserMedia.find({ _id: { $in: umIdStrs.map((s) => new mongoose.Types.ObjectId(s)) } })
          .populate('unique_media_ref')
          .lean()
      : [];
    const umMap = new Map(userMedias.map((um) => [um._id.toString(), um]));

    const byListId = new Map();
    for (const li of topItems) {
      const lid = String(li.list_id);
      if (!byListId.has(lid)) byListId.set(lid, []);
      const copy = { ...li };
      if (li.user_media_id) {
        copy.user_media_id = umMap.get(String(li.user_media_id)) || li.user_media_id;
      }
      byListId.get(lid).push(copy);
    }

    for (const arr of byListId.values()) {
      arr.sort((a, b) => {
        const dp = (a.position ?? 0) - (b.position ?? 0);
        if (dp !== 0) return dp;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
    }

    const map = new Map();
    for (const list of lists) {
      const idStr = list._id.toString();
      const ownerDoc = ownerMap.get(String(list.user_id));
      map.set(idStr, {
        _id: list._id,
        name: list.name,
        cover_image_url: list.cover_image_url || null,
        private: !!list.private,
        items: byListId.get(idStr) || [],
        totalCount: countMap.get(idStr) ?? 0,
        owner: ownerDoc
          ? { username: ownerDoc.username, icon: ownerDoc.icon || null }
          : undefined,
      });
    }

    return map;
  } catch {
    return buildLinkedListCardMapSequential(listObjectIds);
  }
}

module.exports = { buildLinkedListCardMap, listRefKey };
