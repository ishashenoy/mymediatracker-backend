const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Bookmarks to other users' lists (quick access from Saved → Lists on profile). */
const savedListSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    list_id: { type: Schema.Types.ObjectId, ref: 'List', required: true },
  },
  { timestamps: true }
);

savedListSchema.index({ user_id: 1, list_id: 1 }, { unique: true });
savedListSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model('SavedList', savedListSchema);
