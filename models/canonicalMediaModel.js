const mongoose = require('mongoose');

const canonicalMediaSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    normalized_name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    primary_image_url: {
      type: String,
      default: '',
    },
    is_user_submitted: {
      type: Boolean,
      default: false,
    },
    // Array of UniqueMedia _ids this canonical was merged from (rollback safety)
    merge_history: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
  },
  { timestamps: true }
);

canonicalMediaSchema.index({ type: 1, normalized_name: 1 });

module.exports = mongoose.model('CanonicalMedia', canonicalMediaSchema);
