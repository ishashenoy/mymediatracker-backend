const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const feedSchema = new Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['added_media', 'removed_media', 'updated_status', 'updated_rating', 'updated_progress', 'milestone'],
    required: true
  },
  media: { type: mongoose.Schema.Types.ObjectId, ref: 'UserMedia', required: false }, // null for milestones
  mediaName: { type: String, required: false },
  mediaType: { type: String, required: false },
  mediaImage: { type: String, required: false },
  mediaSource: { type: String, required: false },
  mediaId: { type: String, required: false },
  oldValue: String,
  newValue: String,
  milestoneData: {
    type: String,
    enum: ['50_titles', '100_titles', '200_titles', '500_titles', '1000_titles']
  },
  timestamp: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// Compound indexes for performance
feedSchema.index({ user: 1, timestamp: -1 });
feedSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Feed', feedSchema);
