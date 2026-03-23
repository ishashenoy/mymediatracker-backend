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
  body: {
    type: String,
    required: true,
    maxlength: 500,
    trim: true,
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

module.exports = mongoose.model('Comment', commentSchema);
