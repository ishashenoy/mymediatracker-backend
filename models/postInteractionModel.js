const mongoose = require('mongoose');

const INTERACTION_TYPES = ['like', 'repost', 'bookmark'];

const postInteractionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  post_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    required: true,
  },
  interaction_type: {
    type: String,
    enum: INTERACTION_TYPES,
    required: true,
  },
  // Position of the post in the feed when the interaction was made — analytics signal
  feed_position: {
    type: Number,
    default: null,
  },
  session_id: {
    type: String,
    default: null,
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
});

// One interaction of each type per user per post
postInteractionSchema.index(
  { user_id: 1, post_id: 1, interaction_type: 1 },
  { unique: true }
);
// "All posts this user liked"
postInteractionSchema.index({ user_id: 1, interaction_type: 1, created_at: -1 });
// "All users who liked this post"
postInteractionSchema.index({ post_id: 1, interaction_type: 1 });

module.exports = mongoose.model('PostInteraction', postInteractionSchema);
module.exports.INTERACTION_TYPES = INTERACTION_TYPES;
