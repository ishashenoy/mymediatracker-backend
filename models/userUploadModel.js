const mongoose = require('mongoose');

const userUploadSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  cloudinary_public_id: {
    type: String,
    required: true,
    trim: true,
  },
  // What the asset is used for
  resource_type: {
    type: String,
    enum: ['icon'],
    required: true,
  },
  linked_entity_id: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  linked_entity_type: {
    type: String,
    enum: ['UserMedia', 'List', 'User', null],
    default: null,
  },
  status: {
    type: String,
    enum: ['active', 'orphaned', 'deleted'],
    default: 'active',
  },
  uploaded_at: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('UserUpload', userUploadSchema);
