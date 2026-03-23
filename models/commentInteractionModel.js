const mongoose = require('mongoose');

const COMMENT_INTERACTION_TYPES = ['like', 'repost', 'bookmark'];

const commentInteractionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  comment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    required: true,
  },
  interaction_type: {
    type: String,
    enum: COMMENT_INTERACTION_TYPES,
    required: true,
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
});

// One interaction of each type per user per comment
commentInteractionSchema.index(
  { user_id: 1, comment_id: 1, interaction_type: 1 },
  { unique: true }
);
commentInteractionSchema.index({ comment_id: 1, interaction_type: 1 });

module.exports = mongoose.model('CommentInteraction', commentInteractionSchema);
