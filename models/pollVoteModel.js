const mongoose = require('mongoose');

const pollVoteSchema = new mongoose.Schema({
  post_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    required: true,
    index: true,
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Index of the chosen option in post.poll.options[]
  option_index: {
    type: Number,
    required: true,
    min: 0,
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
});

// One vote per user per post — also used to look up the user's current vote
pollVoteSchema.index({ post_id: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model('PollVote', pollVoteSchema);
