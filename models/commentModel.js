const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  post_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    required: true,
    index: true,
  },
  author_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  /** If set, this comment is a reply to another comment on the same post */
  parent_comment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
    index: true,
  },
  body: {
    type: String,
    default: '',
    maxlength: 500,
    trim: true,
  },
  /** Inline images on replies (Cloudinary URLs), max 4 */
  images: {
    type: [String],
    default: [],
    validate: [(v) => v.length <= 4, 'Max 4 images'],
  },
  like_count: { type: Number, default: 0, min: 0 },
  repost_count: { type: Number, default: 0, min: 0 },
  bookmark_count: { type: Number, default: 0, min: 0 },
  created_at: {
    type: Date,
    default: Date.now,
  },
});

// Ascending for chronological thread display
commentSchema.index({ post_id: 1, created_at: 1 });
commentSchema.index({ post_id: 1, parent_comment_id: 1 });

module.exports = mongoose.model('Comment', commentSchema);
