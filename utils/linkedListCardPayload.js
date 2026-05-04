const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const User = require('../models/userModel');

/**
 * Normalize post.linked_list_id whether it is an ObjectId, string, or populated { _id }.
 */
function listRefKey(ref) {
  if (ref == null || ref === '') return '';
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
}

/**
 * Build a map listId -> payload shaped for list preview cards (same fields as /api/lists/saved items).
 */
async function buildLinkedListCardMap(listIds) {
  const uniqueIds = [...new Set(listIds.map(listRefKey).filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const lists = await List.find({ _id: { $in: uniqueIds } }).lean();
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

module.exports = { buildLinkedListCardMap, listRefKey };
