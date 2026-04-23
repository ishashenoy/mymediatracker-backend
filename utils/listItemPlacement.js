const ListItem = require('../models/listItemModel');

/**
 * Where to place a newly added list item in a flat list (no sections).
 * Returns the next position in the list.
 */
async function resolveNewListItemSectionAndPosition(listId) {
  const last = await ListItem.findOne({ list_id: listId })
    .sort({ position: -1 })
    .select('position')
    .lean();

  const position = typeof last?.position === 'number' ? last.position + 1 : 0;
  return { section_id: null, position };
}

module.exports = { resolveNewListItemSectionAndPosition };
