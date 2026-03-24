const mongoose = require('mongoose');

const uniqueMediaSchema = new mongoose.Schema(
    {
        source: {
            type: String,
            required: false,
            index: true,
        },
        media_id: {
            type: String,
            required: false,
            index: true,
        },
        type: {
            type: String,
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        normalized_name: {
            type: String,
            required: true,
            index: true,
        },
        image_url: {
            type: String,
            default: '',
            index: true,
        },
        score: {
            type: mongoose.Schema.Types.Mixed,
            required: false,
        },
    },
    { timestamps: true }
);

uniqueMediaSchema.index(
    { source: 1, media_id: 1, type: 1 },
    {
        unique: true,
        partialFilterExpression: {
            source: { $exists: true },
            media_id: { $exists: true },
        },
    }
);

uniqueMediaSchema.index({
    type: 1,
    normalized_name: 1,
    image_url: 1,
});

module.exports = mongoose.model('UniqueMedia', uniqueMediaSchema);