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
    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id; 

    try {
        const user = await User.findOne({username});
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const user_id = user._id;
        const privacy = user.private;

        //Checking if the current user is trying to access their own page
        if (senderId.equals(user._id)){
            const profileMedia = await Media.find({user_id}).sort({status: 1});
            return res.status(200).json({watchList: profileMedia, private: privacy});
        } else {
            // If the account is public
            if (!privacy){
                const profileMedia = await Media.find({user_id}).sort({status: 1});
                return res.status(200).json({watchList: profileMedia, private: privacy});
            } else { 
                // If the account is private and current user does not match the requested username
                return res.status(403).json({ error: "This account is private" });
            }
        }
    } catch (error){
        return res.status(500).json({ error: error.message });
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
    const user_id = req.user._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    const media = await Media.findOneAndDelete({_id: id, user_id : user_id});

    if (!media){
        return res.status(404).json({error: 'Media does not exist.'});
    }
    res.status(200).json(media);
}

//UPDATE a media
const updateMedia = async (req, res) => {
    const user_id = req.user._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    const media = await Media.findOneAndUpdate({_id: id, user_id : user_id}, {
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