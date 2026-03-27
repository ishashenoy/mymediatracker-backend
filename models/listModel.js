const mongoose = require('mongoose');
const { Schema } = mongoose;

// List schema to represent user-created and system lists
const listSchema = new Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Reference to the user who created the list
    name: { type: String, required: true }, // Name of the list (e.g., "Anime", "Favorites")
    system_key: { type: String, default: null }, // system lists (e.g., 'anime', 'movie') or null for custom lists
    // Only documents with private: true are hidden from other users; missing field = public (legacy data).
    private: { type: Boolean, default: false },
    position: { type: Number, default: 0 }, // Manual ordering position among user's lists
    created_at: { type: Date, default: Date.now }, // Date when the list was created
    updated_at: { type: Date, default: Date.now }, // Date when the list was last updated
    archived: { type: Boolean, default: false }, // Whether the list is archived
    list_type: {
      type: String,
      enum: ['manual', 'watchlist', 'favorites', 'ranked', 'other'],
      default: 'manual',
    },
  },
  { timestamps: true } // Automatically adds createdAt and updatedAt timestamps
);

// Create an index to ensure user_id and name are unique together (in case custom lists have duplicate names)
listSchema.index({ user_id: 1, name: 1 }, { unique: true });

const List = mongoose.model('List', listSchema);

module.exports = List;