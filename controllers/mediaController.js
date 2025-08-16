const Media = require('../models/mediaModel');
const User = require('../models/userModel');
const mongoose = require('mongoose');

//GET all media
const getMedias = async (req,res) => {
    const user_id = req.user._id;

    const medias = await Media.find({user_id}).sort({status: 1});

    res.status(200).json(medias);
}

//GET media of a profile
const getProfileMedia = async (req,res) => {
    const { username } = req.params;

    try {
        const user = await User.findOne({username});
        const user_id = user._id;
        const profileMedia = await Media.find({user_id}).sort({status: 1});

        res.status(200).json(profileMedia);
    } catch (error){
        res.status(500).json({ error: error.message });
    }
}

//POST a new media
const createMedia = async (req,res) => {
    const { name, image_url, progress, type, fav, rating, status } = req.body;

    // add doc to db
    try {
        const user_id = req.user._id;
        const media = await Media.create({ name, image_url, progress, type, fav, rating, status, user_id });
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
    getProfileMedia,
    getMedias,
    deleteMedia,
    updateMedia
}