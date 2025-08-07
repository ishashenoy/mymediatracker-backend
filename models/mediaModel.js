const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const mediaSchema = new Schema({
    name: {
        type: String,
        required: true
    },
    image_url: {
        type: String,
        required: true
    },
    score: {
        type: Number,
        required: false
    },
    progress: {
        type: String,
        required: false
    },
    type:{
        type: String,
        required: true
    },
    fav: {
        type: Boolean,
        required: true
    },
    rating: {
        type: String,
        required: true
    }, 
    status: {
        type: String,
        required: true
    },
    user_id : {
        type: String,
        required: true
    }
}, {timestamps: true})

module.exports = mongoose.model('Media', mediaSchema);