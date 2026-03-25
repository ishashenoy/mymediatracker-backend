const mongoose = require('mongoose');

const LinkedMediaSchema = new mongoose.Schema({
  unique_media_id: { type: mongoose.Schema.Types.ObjectId, ref: 'UniqueMedia', default: null },
  name:     { type: String, default: null },
  image_url: { type: String, default: null },
  type:     { type: String, default: null },
  source:   { type: String, default: null },
  media_id: { type: String, default: null },
}, { _id: false });

const PollOptionSchema = new mongoose.Schema({
  text:       { type: String, required: true, maxlength: 100 },
  vote_count: { type: Number, default: 0, min: 0 },
}, { _id: false });

const PollSchema = new mongoose.Schema({
  options:     { type: [PollOptionSchema], default: [] },
  total_votes: { type: Number, default: 0, min: 0 },
}, { _id: false });

const postSchema = new mongoose.Schema({
  author_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  body: {
    type: String,
    required: true,
    maxlength: 2000,
    trim: true,
  },
  cover_image_url: {
    type: String,
    default: null,
  },

  // ─── Attachments ─────────────────────────────────────────────────────────────
  linked_media: {
    type: LinkedMediaSchema,
    default: null,
  },
  linked_medias: {
    type: [LinkedMediaSchema],
    default: [],
    validate: [(v) => v.length <= 4, 'Max 4 linked media'],
  },
  poll: {
    type: PollSchema,
    default: null,
  },
  linked_list_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'List',
    default: null,
  },

  // ─── Tag ─────────────────────────────────────────────────────────────────────
  tag: {
    type: String,
    enum: ['review', 'question', 'recommendation', 'discussion', 'rant'],
    default: null,
  },

  // ─── Counts ──────────────────────────────────────────────────────────────────
  like_count:     { type: Number, default: 0, min: 0 },
  comment_count:  { type: Number, default: 0, min: 0 },
  repost_count:   { type: Number, default: 0, min: 0 },
  bookmark_count: { type: Number, default: 0, min: 0 },
  view_count:     { type: Number, default: 0, min: 0 },
  created_at: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

postSchema.index({ author_id: 1, created_at: -1 });

module.exports = mongoose.model('Post', postSchema);
