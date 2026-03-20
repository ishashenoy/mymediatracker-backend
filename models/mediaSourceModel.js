const mongoose = require('mongoose');

const mediaSourceSchema = new mongoose.Schema(
  {
    canonical_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CanonicalMedia',
      required: true,
      index: true,
    },
    // e.g. 'tmdb', 'rawg', 'igdb', 'openlibrary', 'googlebooks', 'mal', 'internal'
    source: {
      type: String,
      required: true,
      trim: true,
    },
    source_media_id: {
      type: String,
      required: true,
      trim: true,
    },
    // Full JSON blob from the external API at time of last fetch
    metadata_snapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    last_fetched_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

mediaSourceSchema.index({ source: 1, source_media_id: 1 }, { unique: true });

module.exports = mongoose.model('MediaSource', mediaSourceSchema);
