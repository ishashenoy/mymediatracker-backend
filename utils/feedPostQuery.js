/** Allowed post tag values (must match models/postModel.js enum). */
const VALID_POST_TAGS = ['review', 'question', 'recommendation', 'discussion', 'rant'];

/**
 * Builds Mongo query for cursor-paginated feed, optionally filtered by post tag.
 * @param {{ cursor?: string, tag?: string }} opts
 * @returns {{ query: object } | { error: string }}
 */
function buildFeedPostQuery(opts) {
  const { cursor, tag } = opts;
  const query = {};

  if (tag !== undefined && tag !== null && String(tag).trim() !== '') {
    const t = String(tag).toLowerCase();
    if (t !== 'all') {
      if (!VALID_POST_TAGS.includes(t)) {
        return { error: 'Invalid tag filter.' };
      }
      query.tag = t;
    }
  }

  if (cursor) {
    query.created_at = { $lt: new Date(cursor) };
  }

  return { query };
}

module.exports = { VALID_POST_TAGS, buildFeedPostQuery };
