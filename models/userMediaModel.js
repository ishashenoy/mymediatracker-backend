const mongoose = require('mongoose');

const userMediaSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    unique_media_ref: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UniqueMedia',
      required: true,
      index: true,
    },
    rating: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    status: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    progress: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    watched_episodes: {
      type: [String],
      default: [],
    },
    fav: {
      type: Boolean,
      default: false,
      index: true,
    },

    use_custom_display: {
      type: Boolean,
      default: false,
    },
    custom_name: {
      type: String,
      default: '',
      trim: true,
    },
    custom_image_url: {
      type: String,
      default: '',
    },
    aspectRatio: {
      type: String,
      enum: ['poster', 'square', 'landscape'],
      default: null,
    },

    // --- New data capture fields (all optional) ---
    canonical_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CanonicalMedia',
      default: null,
      index: true,
    },
    review_text: {
      type: String,
      default: null,
    },
    contains_spoilers: {
      type: Boolean,
      default: false,
    },
    rewatch_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    // e.g. 'streaming', 'physical', 'digital', 'rental', 'ebook', 'audiobook', 'library', 'other'
    format: {
      type: String,
      default: null,
    },
    // Free-text platform name, e.g. 'Netflix', 'Steam', 'Kindle'
    platform: {
      type: String,
      default: null,
    },
    started_at: {
      type: Date,
      default: null,
    },
    finished_at: {
      type: Date,
      default: null,
    },
    // e.g. 'friend_rec', 'mytria_rec', 'list', 'search', 'browsing', 'social_media', 'other'
    source_of_discovery: {
      type: String,
      default: null,
    },
    // e.g. ['cozy', 'nostalgic', 'binge-worthy']
    mood_tags: {
      type: [String],
      default: [],
    },
    owned: {
      type: Boolean,
      default: false,
    },
    // If status=dropped, stores the progress value at time of dropping
    dropped_at_progress: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

userMediaSchema.index({ user_id: 1, status: 1 });
userMediaSchema.index({ user_id: 1, fav: 1 });
userMediaSchema.index(
  { user_id: 1, canonical_id: 1 },
  { unique: true, partialFilterExpression: { canonical_id: { $type: 'objectId' } } }
);

module.exports = mongoose.model('UserMedia', userMediaSchema);