const mongoose = require('mongoose');

const followSchema = new mongoose.Schema({
  follower_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  followee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
});

// Prevents duplicate follows and enables fast "am I following?" lookups
followSchema.index({ follower_id: 1, followee_id: 1 }, { unique: true });
// Enables fast "who follows me?" queries
followSchema.index({ followee_id: 1 });

module.exports = mongoose.model('Follow', followSchema);
