const { XMLParser } = require("fast-xml-parser");

const Media = require('../models/mediaModel');
const User = require('../models/userModel');

const NodeCache = require('node-cache');
const trendingCache = new NodeCache({ stdTTL: 86400 });

const mongoose = require('mongoose');

//GET all media
const getMedias = async (req,res) => {
    const user_id = req.user._id;

    const medias = await Media.find({user_id}).sort({status: 1});

    const user = await User.findOne({ _id: user_id });
    const privacy = user.private;

    return res.status(200).json({ watchList: medias, private: privacy });
}

//GET media of a profile
const getProfileMedia = async (req,res) => {
    const { username } = req.params;
    console.log('error');
    try {
        const user = await User.findOne({ username });

        //if the user has requested an invalid username
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const user_id = user._id;
        const privacy = user.private;

        // public profile
        if (!privacy) {
            const profileMedia = await Media.find({ user_id }).sort({ status: 1 });
            return res.status(200).json({ watchList: profileMedia, private: privacy });
        }

        // private profile
        return res.status(403).json({ error: "This account is private" });
    } catch (error){
        return res.status(500).json({ error: error.message });
    }
}

//GET trending media
const getTrendingMedia = async (req,res) => {

    try {
        const cachedResult = trendingCache.get('trendingMedia');
        if (cachedResult) {
            console.log('Cache found.');
            return res.status(200).json(cachedResult);
        }

        console.log('Cache expired/not found. Fetching new trending media from database...');

        const result = await Media.aggregate([
            {
                $group: {
                _id: { name: "$name", type: "$type" }, // group by fields
                count: { $sum: 1 }, // count frequency
                sampleDoc: { $first: "$$ROOT" } // keep one example document
                }
            },
            { $sort: { count: -1 } }, // sort by frequency
            { $limit: 15 }, // take top 15
            {
                $project: {
                    _id: 0,
                    name: "$_id.name",
                    type: "$_id.type",
                    count: 1,
                    sampleDoc: {
                        _id: "$sampleDoc._id",
                        name: "$sampleDoc.name",
                        type: "$sampleDoc.type",
                        image_url: "$sampleDoc.image_url"
                    }
                }
            }
        ]);

        trendingCache.set('trendingMedia', result);

        return res.status(200).json(result);
    } catch (error){
        return res.status(500).json({ error: error.message });
    }
}

//POST a new media
const createMedia = async (req,res) => {
    const { name, image_url, progress, type, rating, status } = req.body;

    // add doc to db
    try {
        const user_id = req.user._id;
        const media = await Media.create({ name, image_url, progress, type, rating, status, user_id });
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


// IMPORT (POST) media(s) from other website
const importMedia = async (req,res) => {
    const { source } = req.params;
    let  { handle } = req.body;

    if (!handle) {
        return res.status(400).json({ error: "Handle is required" });
    }

    // Ensure handle is a string and trim
    handle = String(handle || "").trim();
    

    // Validate handle is ONLY numerical
    if (!/^\d+$/.test(handle)) {
        return res.status(400).json({ error: "Invalid handle. Must be a number." });
    }

    // safe conversion to int
    handle = parseInt(handle, 10);

    //getting the user's verified id attached by middleware in req
    const user_id = req.user._id;

    const parser = new XMLParser();

    let url;
    if (source==='goodreads'){
        url = "https://www.goodreads.com/review/list_rss/"+handle;
    }else {
        return res.status(400).json({ error: "Unsupported source" });
    }

    let items;

    let importedMedia = [];

    try{
        const response = await fetch(url);

        if (!response.ok) throw new Error("Failed to fetch");

        const xmlData = await response.text();
        const jsonObj = parser.parse(xmlData);
        items = jsonObj?.rss?.channel?.item || [];
        if (!Array.isArray(items)) {
            items = [items];
        }

        function unwrap(val) {
            if (val && typeof val === "object" && "__cdata" in val) {
                return val.__cdata;
            }
            return val ?? "";
        }


        for (const item of items) {
            const name = unwrap(item.title);
            const image_url = unwrap(item.book_large_image_url);
            const progress = "";
            const rating = String(item.user_rating || '0');

            let type;
            switch (source){
                case "goodreads":
                    type='book';
                    break;
                default:
                    return res.status(400).json({error: 'Something went wrong.'});
            }

            let status;
            if (item.user_shelves.includes("to-read")) {
                status = "to-do";
            } else if (item.user_shelves.includes("currently-reading")) {
                status = "doing";
            } else {
                status = "done";
            }

            // add docs to db
            const media = await Media.create({name, image_url, progress, type, rating, status, user_id});
            importedMedia.push(media);
        }
    } catch (error){
        return res.status(500).json({error: error.message});
    }

    return res.status(200).json(importedMedia);
}

module.exports = {
    createMedia,
    getProfileMedia,
    getTrendingMedia,
    getMedias,
    deleteMedia,
    updateMedia,
    importMedia
}