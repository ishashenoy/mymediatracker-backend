const mongoose = require('mongoose');
const { Schema } = mongoose;

const listSectionSchema = new Schema(
  {
    list_id: { type: mongoose.Schema.Types.ObjectId, ref: 'List', required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

listSectionSchema.index({ list_id: 1, position: 1 });

const ListSection = mongoose.model('ListSection', listSectionSchema);

module.exports = ListSection;
