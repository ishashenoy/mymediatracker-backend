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
    progress: {
        type: String,
        required: false
    },
    type:{
        type: String,
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
    },
    media_id : {
        type: String,
        index: true
    }
}, {timestamps: true})

module.exports = mongoose.model('Media', mediaSchema);