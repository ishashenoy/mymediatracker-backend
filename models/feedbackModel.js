const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    username: { type: String, required: true },
    email: { type: String, default: '' },
    category: {
      type: String,
      enum: ['feature', 'bug', 'general'],
      default: 'general',
    },
    message: { type: String, required: true, maxlength: 4000 },
  },
  { timestamps: true }
);

feedbackSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
