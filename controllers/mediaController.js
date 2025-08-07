const Media = require('../models/mediaModel');
const mongoose = require('mongoose');

//GET all media
const getMedias = async (req,res) => {
    const user_id = req.user._id;

    const medias = await Media.find({user_id}).sort({createdAt: -1});

    res.status(200).json(medias);
}

//POST a new media
const createMedia = async (req,res) => {
    console.log("Incoming request body:", req.body); 
    const { name, image_url, score, progress, type, fav, rating, status } = req.body;

    // add doc to db
    try {
        const user_id = req.user._id;
        const media = await Media.create({ name, image_url, score, progress, type, fav, rating, status, user_id });
        res.status(200).json(media);
    } catch (error){
        res.status(400).json({error: error.message});
    }
}

//DELETE a media
const deleteMedia = async(req,res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    const media = await Media.findOneAndDelete({_id: id});

    if (!media){
        return res.status(404).json({error: 'Media does not exist.'});
    }
    res.status(200).json(media);
}

//UPDATE a media
const updateMedia = async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    const media = await Media.findOneAndUpdate({_id: id}, {
        ...req.body
    });

    if (!media){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    res.status(200).json(media);
}

module.exports = {
    createMedia,
    getMedias,
    deleteMedia,
    updateMedia
}