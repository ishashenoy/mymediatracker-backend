const mongoose = require('mongoose');
const { Schema } = mongoose;

// ListItem schema to represent the association between UserMedia and a List
const listItemSchema = new Schema(
  {
    list_id: { type: mongoose.Schema.Types.ObjectId, ref: 'List', required: true }, // Reference to the list that the media belongs to
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Reference to the user who owns the list
    user_media_id: { type: mongoose.Schema.Types.ObjectId, ref: 'UserMedia', required: true }, // Reference to the user's saved media
    added_at: { type: Date, default: Date.now }, // Date when the media was added to the list
    position: { type: Number, default: 0 } // Optional field for ordering list items
  },
  { timestamps: true } // Automatically adds createdAt and updatedAt timestamps
);

// Create a unique index to ensure each media item can only be added once per list
listItemSchema.index({ list_id: 1, user_media_id: 1 }, { unique: true });

const ListItem = mongoose.model('ListItem', listItemSchema);

module.exports = ListItem;