const { XMLParser } = require("fast-xml-parser");

// Used to make strings that are url friendly
const slugify = require("slugify"); 
// Used to make unique hashes
const crypto = require("crypto");   

const Media = require('../models/mediaModel');
const User = require('../models/userModel');

const NodeCache = require('node-cache');
const trendingCache = new NodeCache({ stdTTL: 86400 });

const mongoose = require('mongoose');

const cloudinary = require('cloudinary').v2;


cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL
});

// This function will help us generate slugs
function generateHash(str) {
    if (!str) return crypto.randomBytes(3).toString("hex");
    return crypto.createHash("md5").update(str).digest("hex").slice(0, 6);
}

function generateSlug(name, imageUrl) {
    // Only take the first 50 chars of the name, converted to a clean slug
    const base = slugify(name || "untitled", { lower: true, strict: true }).slice(0, 50);
    // Generate a hash based on the image URL or name
    const hash = generateHash(imageUrl || name);
    // Combine them, e.g., "drawing-closer-4394b0"
    return `${base}-${hash}`;
}

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
    try {
        const user = await User.findOne({ username });

        //if the user has requested an invalid username
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const user_id = user._id;
        const privacy = user.private;

        // public profile — anyone can view
        if (!privacy) {
            const profileMedia = await Media.find({ user_id }).sort({ status: 1 });
            return res.status(200).json({ watchList: profileMedia, private: privacy });
        }

        // private profile — check if viewer is a follower
        // Try to identify the viewer from an optional auth header
        const { authorization } = req.headers;
        if (authorization) {
            try {
                const jwt = require('jsonwebtoken');
                const token = authorization.split(' ')[1];
                const { _id } = jwt.verify(token, process.env.SECRET);
                const viewer = await User.findOne({ _id }).select('username');

                if (viewer) {
                    // Allow if viewer is the profile owner
                    if (viewer.username === username) {
                        const profileMedia = await Media.find({ user_id }).sort({ status: 1 });
                        return res.status(200).json({ watchList: profileMedia, private: privacy });
                    }
                    // Allow if viewer is a follower of this private profile
                    if (user.followers && user.followers.includes(viewer.username)) {
                        const profileMedia = await Media.find({ user_id }).sort({ status: 1 });
                        return res.status(200).json({ watchList: profileMedia, private: privacy });
                    }
                }
            } catch (err) {
                // Invalid token — treat as unauthenticated viewer
            }
        }

        // private profile and viewer is not a follower (or not logged in)
        return res.status(403).json({ error: "This account is private", private: true });
    } catch (error){
        return res.status(500).json({ error: error.message });
    }
}

// GET trending media
// Will be replaced by a ML based recommendation system soon
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
    const { name, image_url, progress, type, rating, status, media_id } = req.body;

    // Validating the request
    if (!name || !type) {
        return res.status(400).json({ error: "Name and type are required." });
    }

    // add doc to db
    try {
        const user_id = req.user._id;
        
        // Generate backup slug if media_id is empty or undefined
        let finalMediaId = media_id;
        const mediaIdStr = String(media_id ?? '').trim();
        if (!mediaIdStr) {
            finalMediaId = generateSlug(name, image_url);
        } else {
            finalMediaId = mediaIdStr;
        }
        
        const media = await Media.create({ name, image_url, progress, type, rating, status, user_id, media_id: finalMediaId });
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

    const media = await Media.findOne({ _id: id, user_id });

    if (!media){
        return res.status(404).json({error: 'Media does not exist.'});
    }

    // Delete image from Cloudinary if it exists
    if (media.image_url) {
        try {
            // Extract the public_id safely from the URL
            const match = media.image_url.match(/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
            const publicId = match ? match[1] : null;

            if (publicId) {
                await cloudinary.uploader.destroy(publicId).catch(() => {});
            }
        } catch (err) {
            console.error("Cloudinary deletion failed:", err.message);
        }
    }

    // Delete document
    await Media.deleteOne({ _id: id, user_id });

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

// Uploading media covers
const uploadCover = async (req,res) => {
    const user_id = req.user._id;

    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided' });
    }

    if (req.file.size > 5 * 1024 * 1024) { // 5MB limit
        return res.status(400).json({ error: 'File too large' });
    }

    // Generating a random hash per image upload
    const uniqueId = crypto.randomBytes(4).toString("hex");

    //Uploading the image to cloudinary storage
    return cloudinary.uploader.upload_stream(
    {
        public_id: `banners/${user_id}_${uniqueId}`, // unique id for each media
        format: "webp",
        //Cropping the image to fit size limits
        transformation: [
            { width: 300, height: 500, crop: "fill" }, // cropping image
            { quality: "auto:low", fetch_format: "auto" }, // optimize quality and reduce file size
            { effect: "improve" }, // apply contrast and sharpness
            { dpr: "auto" }, // adjust image quality
            { compression: "medium" }
        ]
    },
    (error, result) => {
        if (error){
            return res.status(400).json({error: error})
        }else{
            return res.status(200).json({ message: "Cover uploaded", image_url: result.secure_url});
        }
    }).end(req.file.buffer);
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
    

    // Validate handle based on source
    if (source === 'goodreads') {
        // Goodreads requires numeric user ID
        if (!/^\d+$/.test(handle)) {
            return res.status(400).json({ error: "Invalid Goodreads handle. Must be a number." });
        }
        // safe conversion to int for Goodreads
        handle = parseInt(handle, 10);
    } else if (source === 'letterboxd') {
        // Letterboxd requires username (alphanumeric, hyphens, underscores)
        if (!/^[a-zA-Z0-9_-]+$/.test(handle)) {
            return res.status(400).json({ error: "Invalid Letterboxd username. Must contain only letters, numbers, hyphens, and underscores." });
        }
    } else {
        return res.status(400).json({ error: "Unsupported source" });
    }

    //getting the user's verified id attached by middleware in req
    const user_id = req.user._id;

    const parser = new XMLParser();

    let url;
    if (source==='goodreads'){
        url = "https://www.goodreads.com/review/list_rss/"+handle;
    } else if (source==='letterboxd'){
        url = `https://letterboxd.com/${handle}/rss/`;
    } else {
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
            let name, image_url, progress, rating, type, status;

            if (source === 'goodreads') {
                name = unwrap(item.title);
                image_url = unwrap(item.book_large_image_url);
                progress = "";
                rating = String(item.user_rating || '0');
                type = 'book';

                if (item.user_shelves.includes("to-read")) {
                    status = "to-do";
                } else if (item.user_shelves.includes("currently-reading")) {
                    status = "doing";
                } else {
                    status = "done";
                }
            } else if (source === 'letterboxd') {
                // Letterboxd RSS format
                name = unwrap(item.title);
                
                // Letterboxd includes images in the description, we need to extract it
                const description = unwrap(item.description) || "";
                const imgMatch = description.match(/<img[^>]+src="([^"]*)"[^>]*>/);
                image_url = imgMatch ? imgMatch[1] : "";
                
                progress = "";
                
                // Letterboxd includes rating in the title or description
                const ratingMatch = name.match(/★+/) || description.match(/★+/);
                if (ratingMatch) {
                    rating = String(ratingMatch[0].length); // Count the stars
                } else {
                    rating = '0';
                }
                
                type = 'movie';
                
                // Letterboxd entries are typically movies that have been watched
                // We can check the description for "Watched" vs "Want to watch"
                if (description.includes("Want to watch") || description.includes("Watchlist")) {
                    status = "to-do";
                } else {
                    status = "done"; // Most Letterboxd entries are watched movies
                }
                
                // Clean up the title by removing rating stars and extra text
                name = name.replace(/★+/g, '').replace(/\s*\(\d{4}\).*/, '').trim();
            }

            const media_id = generateSlug(name, image_url);

            // add docs to db
            const media = await Media.create({name, image_url, progress, type, rating, status, user_id, media_id});
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
    importMedia,
    uploadCover
}