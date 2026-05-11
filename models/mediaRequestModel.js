const mongoose = require('mongoose');

const MEDIA_REQUEST_TYPES = [
  'movie',
  'tv',
  'web-video',
  'music',
  'anime',
  'manga',
  'game',
  'book',
];

/** Validated in controller; stored as null when unspecified */
const AIRING_STATUS_VALUES = ['ongoing', 'ended', 'upcoming', 'hiatus', 'cancelled', 'unknown'];

const mediaRequestSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    type: {
      type: String,
      required: true,
      enum: MEDIA_REQUEST_TYPES,
      index: true,
    },
    image_url: { type: String, default: '' },
    tags: {
      type: [String],
      default: [],
    },
    description: { type: String, default: '' },
    episode_count: { type: Number, default: null, min: 0 },
    year: { type: Number, default: null },
    runtime: { type: String, default: '', trim: true, maxlength: 80 },
    airing_status: { type: String, default: null },
    age_rating: { type: String, default: '', trim: true, maxlength: 32 },
    review_status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

mediaRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('MediaRequest', mediaRequestSchema);
module.exports.MEDIA_REQUEST_TYPES = MEDIA_REQUEST_TYPES;
module.exports.AIRING_STATUS_VALUES = AIRING_STATUS_VALUES;
