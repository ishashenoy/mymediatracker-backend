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
  },
  { timestamps: true }
);

userMediaSchema.index({ user_id: 1, status: 1 });
userMediaSchema.index({ user_id: 1, fav: 1 });

module.exports = mongoose.model('UserMedia', userMediaSchema);