const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const { fireEvent } = require('./eventsController');
const Mailjet = require('node-mailjet');
const mailjet = Mailjet.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_SECRET_KEY
);
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcrypt');
const validator = require('validator');
const { sanitizeText, sanitizeFeedbackMessage, sanitizeIdentifier } = require('../utils/sanitize');
const { ratingForApiResponse } = require('../utils/starRating');
const Feedback = require('../models/feedbackModel');
const { createNotification } = require('./notificationController');
const { isAdminUser, isOwnerOrAdmin, canViewPrivateAccountContent } = require('../utils/privacy');
const { scheduledPurgeAtFromNow, GRACE_DAYS, isAccountPendingDeletion } = require('../utils/accountDeletion');
const { userHasAdminBadge } = require('../utils/adminBadge');
const UserMedia = require('../models/userMediaModel');
const {
    sanitizeTimeZone,
    dayKeyFromInstant,
    startWeekdaySundayFirst,
    daysInMonth,
    monthTitleUpper,
} = require('../utils/receiptCalendar');

cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL
});

//create jwt
const createToken = (_id) => {
    return jwt.sign({_id}, process.env.SECRET, { expiresIn: '7d' })
}

const serializePublicUser = (user) => {
    if (!user) return null;
    return {
        _id: user._id,
        username: user.username,
        icon: user.icon || null,
        banner: user.banner || null,
        is_admin_badge: userHasAdminBadge(user),
    };
};

const hasAsciiChunk = (buffer, chunk) => {
    if (!Buffer.isBuffer(buffer) || !chunk) return false;
    return buffer.indexOf(Buffer.from(chunk, 'ascii')) !== -1;
};

/** GIF by MIME or file signature (catches mislabeled uploads). */
const isGifUpload = (file) => {
    if (!file || !Buffer.isBuffer(file.buffer)) return false;
    if ((file.mimetype || '').toLowerCase() === 'image/gif') return true;
    if (file.buffer.length >= 6) {
        const head = file.buffer.toString('ascii', 0, 6);
        if (head === 'GIF87a' || head === 'GIF89a') return true;
    }
    return false;
};

const isAnimatedImageUpload = (file) => {
    if (!file || !Buffer.isBuffer(file.buffer)) return false;

    if (isGifUpload(file)) return true;

    const mime = (file.mimetype || '').toLowerCase();

    // APNG files contain the animation control chunk.
    if (mime === 'image/png' && hasAsciiChunk(file.buffer, 'acTL')) {
        return true;
    }

    // Animated WebP files include an ANIM chunk and/or animation bit in VP8X.
    const isWebpMime = mime === 'image/webp';
    const isRiffWebp = hasAsciiChunk(file.buffer.subarray(0, 32), 'RIFF')
        && hasAsciiChunk(file.buffer.subarray(0, 32), 'WEBP');
    if (isWebpMime || isRiffWebp) {
        if (hasAsciiChunk(file.buffer, 'ANIM')) {
            return true;
        }

        const vp8xOffset = file.buffer.indexOf(Buffer.from('VP8X', 'ascii'));
        if (vp8xOffset !== -1) {
            const flagsByteIndex = vp8xOffset + 8;
            if (file.buffer.length > flagsByteIndex) {
                const hasAnimationFlag = (file.buffer[flagsByteIndex] & 0x02) === 0x02;
                if (hasAnimationFlag) return true;
            }
        }
    }

    return false;
};

const getRequestingUserFromToken = async (req) => {
    if (req.requestingUser !== undefined) return req.requestingUser;

    req.requestingUser = null;
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) return req.requestingUser;

    const token = authorization.split(' ')[1];
    if (!token) return req.requestingUser;

    try {
        const { _id } = jwt.verify(token, process.env.SECRET);
        req.requestingUser = await User.findById(_id).select('_id username following role isAdmin is_admin is_admin_badge is_creator_badge');
    } catch (error) {
        req.requestingUser = null;
    }

    return req.requestingUser;
};

const verifyRecaptcha = async (token) => {
  const secret = process.env.RECAPTCHA_SECRET_KEY;

  try {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      new URLSearchParams({
        secret,
        response: token,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 5000,
      }
    );
    return response.data.success === true;
  } catch (err) {
    return false;
  }
};

// LOGIN
const loginUser = async (req, res) => {
  const { email, password, recaptchaToken } = req.body;

  if (!recaptchaToken) {
    return res.status(400).json({ error: 'reCAPTCHA token is missing.' });
  }

  const isHuman = await verifyRecaptcha(recaptchaToken);
  if (!isHuman) {
    return res.status(400).json({ error: 'reCAPTCHA verification failed. Please refresh and try again.' });
  }

  try {
    const user = await User.login(email, password);
    const token = createToken(user._id);
    return res.status(200).json({
      username: user.username,
      id: user._id.toString(),
      token,
      icon: user.icon || null,
      banner: user.banner || null,
      hide_explicit_covers: user.hide_explicit_covers !== false,
      is_admin_badge: userHasAdminBadge(user),
      accountPendingDeletion: isAccountPendingDeletion(user),
      accountScheduledPurgeAt: user.account_scheduled_purge_at
        ? user.account_scheduled_purge_at.toISOString()
        : null,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

// GET user's connections list
const getConnections = async (req, res) => {
    const { username } = req.params; // this is the user's username
    const user = await User.findOne({ username: username });

    //Checking if the username exists
    if (!user) return res.status(404).json({error: 'User does not exist.'});
    const requestingUser = await User.findById(req.user._id).select('_id username following role isAdmin is_admin').lean();
    if (user.account_deletion_requested_at && !isOwnerOrAdmin(user, requestingUser)) {
        return res.status(404).json({error: 'User does not exist.'});
    }
    const canViewConnections = canViewPrivateAccountContent(user, requestingUser);
    if (!canViewConnections) {
        return res.status(403).json({ error: 'This account is private.', code: 'PROFILE_PRIVATE' });
    }

    const userFollowers = Array.isArray(user.followers) ? user.followers : [];
    const userFollowing = Array.isArray(user.following) ? user.following : [];

    const [followerUsers, followingUsers] = await Promise.all([
        userFollowers.length
            ? User.find({ username: { $in: userFollowers } }).select('username icon is_admin_badge is_creator_badge').lean()
            : [],
        userFollowing.length
            ? User.find({ username: { $in: userFollowing } }).select('username icon is_admin_badge is_creator_badge').lean()
            : [],
    ]);

    const followersByUsername = new Map(followerUsers.map((u) => [u.username, u]));
    const followingByUsername = new Map(followingUsers.map((u) => [u.username, u]));

    const followers = userFollowers.map((uname) => {
        const doc = followersByUsername.get(uname);
        return doc
            ? serializePublicUser(doc)
            : { username: uname, icon: null, is_admin_badge: false };
    });

    const following = userFollowing.map((uname) => {
        const doc = followingByUsername.get(uname);
        return doc
            ? serializePublicUser(doc)
            : { username: uname, icon: null, is_admin_badge: false };
    });

    return res.status(200).json({followers, following});
}

// GET user's icon
const getIcon = async (req, res) => {
    const { username } = req.params; // this is the user's username
    const user = await User.findOne({username: username});

    //Checking if the username exists
    if (!user) return res.status(404).json({error: 'User does not exist.'});

    if (user.account_deletion_requested_at) {
        const requestingUser = await getRequestingUserFromToken(req);
        if (!isOwnerOrAdmin(user, requestingUser)) {
            return res.status(404).json({error: 'User does not exist.'});
        }
    }

    const userIcon = user.icon;
    if (!userIcon){
        return res.status(200).json({message: 'none'});
    }
    return res.status(200).json(userIcon);
}

// change privacy of user account
const changePrivacy = async (req, res) => {
    const { username } = req.params; // this is the current page's username
    const user = await User.findOne({username: username});

    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id;

    if (!(user._id.equals(senderId))) return res.status(401).json({error: 'Not authorized'});

    // Getting the username from database
    try{
        // only allow updating privacy field
        if (typeof req.body.private !== "boolean") {
            return res.status(400).json({ error: "Invalid privacy value" });
        }

        // Update the user's private status with the new value  
        const user = await User.findOneAndUpdate({ _id: senderId}, {
            ...req.body
        },{ new: true });
        return res.status(200).json({...req.body});
    }catch (error){
        return res.status(500).json({error});
    }
}

// change user icon
const changeIcon = async (req, res) => {
    const { username } = req.params; // this is the current page's username

    try {
        const user = await User.findOne({ username: username });
        if (!user) return res.status(404).json({ error: "User not found" });

        // this is the sender's trusted user id verified by the JWT
        const senderId = req.user._id;
        if (!user._id.equals(senderId)) return res.status(401).json({ error: "Not authorized" });

        if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
            return res.status(400).json({ error: "No image file was uploaded" });
        }

        if (isAnimatedImageUpload(req.file)) {
            return res.status(403).json({ error: "Animated profile pictures are currently disabled." });
        }

        // Delete old icon if it exists
        if (user.icon) {
            const oldPublicId = user.icon.split('/').slice(-1)[0].split('.')[0]; // extract public_id from URL
            await cloudinary.uploader.destroy(oldPublicId).catch(() => {}); // ignore errors
        }

        // Wrap Cloudinary upload in a promise
        const uploadIcon = () =>
            new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    {
                        public_id: `icons/${user._id}`, // unique id for this user's icon
                        overwrite: true,
                        format: "webp",
                        transformation: [
                            { width: 500, height: 500, crop: "fill" },
                            { quality: "auto:low", fetch_format: "auto" },
                            { effect: "improve" },
                            { dpr: "auto" },
                            { compression: "medium" }
                        ]
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                ).end(req.file.buffer);
            });

        // Wait for the upload to finish
        const result = await uploadIcon();

        // Save new icon URL in DB
        user.icon = result.secure_url;
        await user.save();

        // Single UserUpload row per user icon (replace prior DB rows; Cloudinary id is unchanged)
        setImmediate(async () => {
            try {
                const UserUpload = require('../models/userUploadModel');
                await UserUpload.deleteMany({ user_id: user._id, resource_type: 'icon' });
                await UserUpload.create({
                    user_id: user._id,
                    cloudinary_public_id: `icons/${user._id}`,
                    resource_type: 'icon',
                    linked_entity_id: user._id,
                    linked_entity_type: 'User',
                    status: 'active',
                });
            } catch (e) { /* silent */ }
        });

        // Send response once
        return res.status(200).json({ message: "Icon processed", image_url: result.secure_url });

    } catch (error) {
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message || "Failed to process icon" });
        }
    }
};

// change user profile banner
const changeBanner = async (req, res) => {
    const { username } = req.params; // this is the current page's username

    try {
        const user = await User.findOne({ username: username });
        if (!user) return res.status(404).json({ error: "User not found" });

        // this is the sender's trusted user id verified by the JWT
        const senderId = req.user._id;
        if (!user._id.equals(senderId)) return res.status(401).json({ error: "Not authorized" });

        if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
            return res.status(400).json({ error: "No image file was uploaded" });
        }

        if (isGifUpload(req.file)) {
            return res.status(400).json({ error: "GIF images can't be used as profile banners." });
        }

        if (isAnimatedImageUpload(req.file)) {
            return res.status(403).json({ error: "Animated profile banners are currently disabled." });
        }

        await cloudinary.uploader.destroy(`banners/${user._id}`, { resource_type: 'image' }).catch(() => {});

        const uploadBanner = () =>
            new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    {
                        public_id: `banners/${user._id}`,
                        overwrite: true,
                        format: "webp",
                        transformation: [
                            { width: 1800, height: 600, crop: "fill", gravity: "auto" },
                            { quality: "auto:low", fetch_format: "auto" },
                            { dpr: "auto" },
                            { compression: "medium" }
                        ]
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                ).end(req.file.buffer);
            });

        const result = await uploadBanner();

        user.banner = result.secure_url;
        await user.save();

        // Single UserUpload row per user banner (replace prior DB rows; Cloudinary id is unchanged)
        setImmediate(async () => {
            try {
                const UserUpload = require('../models/userUploadModel');
                await UserUpload.deleteMany({ user_id: user._id, resource_type: 'banner' });
                await UserUpload.create({
                    user_id: user._id,
                    cloudinary_public_id: `banners/${user._id}`,
                    resource_type: 'banner',
                    linked_entity_id: user._id,
                    linked_entity_type: 'User',
                    status: 'active',
                });
            } catch (e) { /* silent */ }
        });

        return res.status(200).json({ message: "Banner processed", image_url: result.secure_url });
    } catch (error) {
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message || "Failed to process banner" });
        }
    }
};

// Search for users by username or email (partial, case-insensitive)
const searchUsers = async (req, res) => {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: "Search query is required." });
    }

    const query = q.trim();

    try {
        // Search by username or email (partial, case-insensitive)
        const users = await User.find({
            username: { $regex: query, $options: 'i' },
            $or: [
                { account_deletion_requested_at: null },
                { account_deletion_requested_at: { $exists: false } },
            ],
        })
        .select('username icon private is_admin_badge is_creator_badge')
        .limit(20);

        const results = users.map(u => ({
            username: u.username,
            icon: u.icon || null,
            private: u.private,
            is_admin_badge: userHasAdminBadge(u),
        }));

        return res.status(200).json(results);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

// follow another user (update sender's following list, receiver's follower list)
const followRequest = async (req, res) => {
    const { username } = req.params; // this is the receiver's username.
    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id; 

    // Getting the username from database
    const senderUser = await User.findOne({ _id: senderId });
    const senderUsername = senderUser.username;

    // Prevent self-follow
    if (senderUsername === username) {
        return res.status(400).json({ error: "You cannot follow yourself." });
    }

    try{
        // Check if receiver exists first
        const receivingUser = await User.findOne({ username: username });
        if (!receivingUser) return res.status(404).json({error: 'User does not exist.'});
        if (receivingUser.account_deletion_requested_at) {
            return res.status(404).json({error: 'User does not exist.'});
        }
        if (receivingUser.private === true) {
            return res.status(403).json({ error: 'Cannot follow private accounts right now.' });
        }

        // Checking if already following (duplicate prevention)
        if (receivingUser.followers && receivingUser.followers.includes(senderUsername)) {
            return res.status(200).json({ message: "Already following!" });
        }

        // Update the receivers follower list
        await User.findOneAndUpdate({ username: username}, {
            $addToSet: { followers: senderUsername  }
        });

        //Update the senders following list
        await User.findOneAndUpdate({ username: senderUsername}, {
            $addToSet: { following: username }
        });

        // Dual-write to follows collection + fire event (async, fire-and-forget)
        setImmediate(async () => {
            try {
                const Follow = require('../models/followModel');
                await Follow.findOneAndUpdate(
                    { follower_id: senderId, followee_id: receivingUser._id },
                    { follower_id: senderId, followee_id: receivingUser._id, created_at: new Date() },
                    { upsert: true, new: true }
                );
                await fireEvent(senderId, 'follow', null, { followee: username });
                await createNotification({
                    recipientId: receivingUser._id,
                    actorId: senderId,
                    type: 'new_follower',
                    entityType: 'follow',
                    entityId: receivingUser._id,
                });
            } catch (e) { /* silent */ }
        });

        res.status(200).json({ message: "Follow successful!" });
    } catch (error) {
        return res.status(500).json({error: 'Internal server error.'});
    }
}

// unfollow a user (update sender's following list, receiver's follower list)
const unfollowRequest = async (req, res) => {
    const { username } = req.params; // this is the receiver's username.
    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id; 

    // Getting the username from database
    const senderUser = await User.findOne({ _id: senderId });
    const senderUsername = senderUser.username;

    try{
        // Update the receivers follower list
        const receivingUser = await User.findOneAndUpdate({ username: username}, {
            $pull: { followers: senderUsername  }
        });

        // checking if the receiving user exists.
        if (!receivingUser) return res.status(404).json({error: 'User does not exist.'});

        //Update the senders following list
        await User.findOneAndUpdate({ username: senderUsername}, {
            $pull: { following: username }
        });

        // Remove from follows collection (async, fire-and-forget)
        setImmediate(async () => {
            try {
                const Follow = require('../models/followModel');
                await Follow.deleteOne({ follower_id: senderId, followee_id: receivingUser._id });
            } catch (e) { /* silent */ }
        });

        res.status(200).json({ message: "Unfollow succesfull!" });
    } catch (error) {
        return res.status(500).json({error: 'Internal server error.'});
    }
}

// SIGNUP
const signupUser = async (req, res) => {
  const { email, password, username, recaptchaToken } = req.body;

  if (!recaptchaToken) {
    return res.status(400).json({ error: 'reCAPTCHA token is missing.' });
  }

  const isHuman = await verifyRecaptcha(recaptchaToken);
  if (!isHuman) {
    return res.status(400).json({ error: 'reCAPTCHA verification failed. Please refresh and try again.' });
  }

  try {
    const user = await User.signup(email, password, username);
    const token = createToken(user._id);
    return res.status(200).json({
        username: user.username,
        id: user._id.toString(),
        token,
        hide_explicit_covers: user.hide_explicit_covers !== false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

const sendPasswordResetEmail = async (req, res) => {
    const { email, recaptchaToken } = req.body;

    if (!recaptchaToken) {
        return res.status(400).json({ error: 'reCAPTCHA token is missing.' });
    }

    const isHuman = await verifyRecaptcha(recaptchaToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'reCAPTCHA verification failed. Please refresh the page and try again.' });
    }

    const genericResetResponse = {
        message:
            'If an account exists for that email, you will receive password reset instructions shortly.',
    };

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(200).json(genericResetResponse);
        }

        // Create a short-lived token (expires in 15 minutes)
        const resetToken = jwt.sign(
            { _id: user._id },
            process.env.PASSWORD_RESET_SECRET,
            { expiresIn: '15m' }
        );

        // Construct password reset link (update domain to your frontend URL)
        const resetLink = `${
            // https is always used in production
            process.env.NODE_ENV === 'production' 
                ? 'https://' 
                : 'http://' // http is only allowed in development
        }${process.env.CLIENT_URL}/reset-password/${resetToken}`;

        const result = await mailjet
            .post('send', { version: 'v3.1' })
            .request({
                Messages: [
                    {
                        From: {
                            Email: "mymediatracker.help@gmail.com",
                            Name: "Mytria (formerly MyMediaTracker) Support"
                        },
                        To: [
                            {
                                Email: email,
                                Name: user.username
                            }
                        ],
                        Subject: "Password Reset Request",
                        HTMLPart: `
                            <p>Hello ${user.username},</p>
                            <p>You requested to reset your password. Click the link below to choose a new password:</p>
                            <a href="${resetLink}" target="_blank">Reset Password</a>
                            <p>This link will expire in 15 minutes.</p>
                            <p>If you did not request this, you can safely ignore this email.</p>
                        `
                    }
                ]
            });

        return res.status(200).json(genericResetResponse);

    } catch (error) {
        return res.status(500).json({ error: 'Failed to send password reset email.' });
    }
};

const resetPassword = async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    try {
        // Verify the token
        const decoded = jwt.verify(token, process.env.PASSWORD_RESET_SECRET);
        const userId = decoded._id;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const customOptions = {
            minLength: 8,
            minSymbols: 0,
            minLowercase: 1,
            minUppercase: 0
        };

        if (!validator.isStrongPassword(password, customOptions)){
            return res.status(400).json({ error: 'Password not strong enough!' });
        }

        // Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        // Update the database
        await User.findByIdAndUpdate(userId, {
            password: hash
        });

        return res.status(200).json({ message: 'Password successfully reset' });

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(400).json({ error: 'Invalid or expired token.' });
        }
        return res.status(500).json({ error: 'An error occurred while resetting password.' });
    }
}

// GET user's complete profile data
const getUserProfile = async (req, res) => {
    const { username } = req.params;
    
    try {
        // Find the user
        const user = await User.findOne({ username: username }).select('-password');
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const requestingUser = await getRequestingUserFromToken(req);
        const isOwnerOrAdminProfile = (requestingUser && requestingUser._id.toString() === user._id.toString())
            || isAdminUser(requestingUser);
        if (user.account_deletion_requested_at && !isOwnerOrAdminProfile) {
            return res.status(404).json({ error: 'User not found' });
        }
        const canViewPrivateContent = canViewPrivateAccountContent(user, requestingUser);

        // Get user's lists
        const List = require('../models/listModel');
        const totalNonArchivedLists = await List.countDocuments({
            user_id: user._id,
            archived: false,
        });

        const publicListsCount = await List.countDocuments({
            user_id: user._id,
            archived: false,
            private: { $ne: true },
        });

        // Profile never surfaces private lists (owners manage those on Media only).
        const userListsQuery = {
            user_id: user._id,
            archived: false,
            private: { $ne: true },
        };

        const userLists = canViewPrivateContent
            ? await List.find(userListsQuery).sort({ position: 1, created_at: -1 })
            : [];

        // Get user's connections (followers/following count)
        const followersCount = user.followers ? user.followers.length : 0;
        const followingCount = user.following ? user.following.length : 0;

        // Get detailed connection info if requesting user is authenticated
        let detailedConnections = null;
        if (requestingUser) {
            const isFollowing = requestingUser.following && requestingUser.following.includes(username);
            const isFollowedByUser = user.followers && user.followers.includes(requestingUser.username);
            
            detailedConnections = {
                isFollowing,
                isFollowedByUser,
                followersCount,
                followingCount
            };
        } else {
            detailedConnections = {
                isFollowing: false,
                isFollowedByUser: false,
                followersCount,
                followingCount
            };
        }

        // Format user lists with media counts and preview items
        const ListItem = require('../models/listItemModel');
        const serializeUserMedia = (media) => {
            if (!media) return null;
            return {
                _id: media._id,
                status: media.status,
                rating: ratingForApiResponse(media.rating),
                notes: media.notes,
                unique_media_ref: media.unique_media_ref,
                createdAt: media.createdAt,
                updatedAt: media.updatedAt
            };
        };
        
        const listDetails = await Promise.all(
            userLists.map(async (list) => {
                const mediaCount = await ListItem.countDocuments({ 
                    list_id: list._id 
                });
                
                // Get preview items (first 4) - like in collection endpoint
                const previewItems = await ListItem.find({ list_id: list._id })
                    .populate({
                        path: 'user_media_id',
                        populate: {
                            path: 'unique_media_ref'
                        }
                    })
                    .sort({ position: 1, createdAt: -1 })
                    .limit(4);
                
                return {
                    _id: list._id,
                    name: list.name,
                    system_key: list.system_key,
                    private: list.private === true,
                    position: typeof list.position === 'number' ? list.position : 0,
                    created_at: list.created_at,
                    updated_at: list.updated_at,
                    media_count: mediaCount,
                    previewItems: previewItems.map(item => serializeUserMedia(item.user_media_id)).filter(Boolean)
                };
            })
        );

        // Construct profile response
        const profileData = {
            user: {
                _id: user._id,
                username: user.username,
                icon: user.icon,
                banner: user.banner || null,
                is_admin_badge: userHasAdminBadge(user),
                bio: user.bio || '',
                instagram: user.instagram_handle || '',
                twitter: user.twitter_handle || '',
                tiktok: user.tiktok_handle || '',
                private: user.private,
                hide_explicit_covers: user.hide_explicit_covers !== false,
                created_at: user.createdAt
            },
            connections: detailedConnections,
            lists: listDetails,
            stats: {
                total_lists: canViewPrivateContent ? userLists.length : 0,
                total_non_archived_lists: canViewPrivateContent ? totalNonArchivedLists : 0,
                total_media: canViewPrivateContent ? listDetails.reduce((sum, list) => sum + list.media_count, 0) : 0,
                public_lists_count: canViewPrivateContent ? publicListsCount : 0,
            },
            permissions: {
                can_view_lists: canViewPrivateContent,
                can_view_posts: canViewPrivateContent,
                profile_locked: !canViewPrivateContent,
            },
            ...(isOwnerOrAdminProfile
                ? {
                      accountPendingDeletion: Boolean(user.account_deletion_requested_at),
                      accountScheduledPurgeAt: user.account_scheduled_purge_at
                          ? user.account_scheduled_purge_at.toISOString()
                          : null,
                      accountDeletionGraceDays: GRACE_DAYS,
                  }
                : {}),
        };

        res.status(200).json(profileData);

    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
};

// PATCH /api/user/:username/onboarding
const updateOnboarding = async (req, res) => {
    const { username } = req.params;
    const senderId = req.user._id;

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (!user._id.equals(senderId)) return res.status(401).json({ error: 'Not authorized.' });

        const { onboarding_selections, hide_explicit_covers } = req.body;
        if (!Array.isArray(onboarding_selections)) {
            return res.status(400).json({ error: 'onboarding_selections must be an array.' });
        }

        if (typeof hide_explicit_covers !== 'boolean') {
            return res.status(400).json({ error: 'hide_explicit_covers must be a boolean.' });
        }

        user.hide_explicit_covers = hide_explicit_covers;
        user.onboarding_selections = onboarding_selections;
        await user.save();

        setImmediate(() => fireEvent(senderId, 'onboarding_complete', null, {
            steps_completed: onboarding_selections.length,
        }));

        return res.status(200).json({ message: 'Onboarding saved.' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

function sanitizeIanaTimeZone(tz) {
    const s = String(tz || '').trim();
    if (!s || s.length > 80) return 'UTC';
    if (!/^[A-Za-z0-9/_+\-.]+$/.test(s)) return 'UTC';
    return s;
}

function mergeContributionDayRows(rowArrays, yearStr) {
    const days = {};
    let total = 0;
    for (const rows of rowArrays) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            const key = row._id;
            if (!key || !String(key).startsWith(yearStr)) continue;
            const c = typeof row.count === 'number' ? row.count : 0;
            days[key] = (days[key] || 0) + c;
            total += c;
        }
    }
    return { days, total };
}

function mergeBoundsObjects(boundsList) {
    let minDate = null;
    let maxDate = null;
    for (const b of boundsList) {
        if (!b?.minDate || !b?.maxDate) continue;
        if (!minDate || b.minDate < minDate) minDate = b.minDate;
        if (!maxDate || b.maxDate > maxDate) maxDate = b.maxDate;
    }
    return minDate && maxDate ? { minDate, maxDate } : null;
}

// GET /api/user/:username/media-activity — daily contribution counts (optional auth)
const getMediaActivityHeatmap = async (req, res) => {
    const { username } = req.params;
    const yearRaw = parseInt(req.query.year, 10);
    const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
    if (year < 1970 || year > 2100) {
        return res.status(400).json({ error: 'Invalid year' });
    }
    const tz = sanitizeIanaTimeZone(req.query.tz);

    try {
        const profileUser = await User.findOne({ username }).select('_id username private account_deletion_requested_at');
        if (!profileUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const requestingUser = await getRequestingUserFromToken(req);
        if (
            profileUser.account_deletion_requested_at &&
            !isOwnerOrAdmin(profileUser, requestingUser)
        ) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!canViewPrivateAccountContent(profileUser, requestingUser)) {
            return res.status(403).json({ error: 'This account is private.', code: 'PROFILE_PRIVATE' });
        }

        const Feed = require('../models/feedModel');
        const Post = require('../models/postModel');
        const Comment = require('../models/commentModel');

        const MS_DAY = 86400000;
        const start = new Date(Date.UTC(year, 0, 1) - 2 * MS_DAY);
        const end = new Date(Date.UTC(year + 1, 0, 1) + 2 * MS_DAY);

        const uid = profileUser._id;
        const isPrivate = !!profileUser.private;

        // Feed duplicates adds/updates that we already count from UserMedia. Only count events
        // that are not represented on UserMedia rows (milestones, removals after delete).
        const feedExtraTypes = { $in: ['removed_media', 'milestone'] };

        const feedByDay = !isPrivate
            ? await Feed.aggregate([
                  { $match: { user: uid, type: feedExtraTypes } },
                  {
                      $addFields: {
                          activityAt: { $ifNull: ['$timestamp', '$createdAt'] },
                      },
                  },
                  {
                      $match: {
                          $and: [
                              { activityAt: { $gte: start, $lt: end } },
                              { activityAt: { $type: 'date' } },
                          ],
                      },
                  },
                  {
                      $group: {
                          _id: {
                              $dateToString: { format: '%Y-%m-%d', date: '$activityAt', timezone: tz },
                          },
                          count: { $sum: 1 },
                      },
                  },
              ])
            : [];

        const userMediaContribByDay = await UserMedia.aggregate([
            { $match: { user_id: uid } },
            {
                $addFields: {
                    contribDates: {
                        $concatArrays: [
                            {
                                $cond: [
                                    {
                                        $and: [
                                            { $gte: ['$createdAt', start] },
                                            { $lt: ['$createdAt', end] },
                                        ],
                                    },
                                    ['$createdAt'],
                                    [],
                                ],
                            },
                            {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$updatedAt', '$createdAt'] },
                                            { $gte: ['$updatedAt', start] },
                                            { $lt: ['$updatedAt', end] },
                                        ],
                                    },
                                    ['$updatedAt'],
                                    [],
                                ],
                            },
                        ],
                    },
                },
            },
            { $unwind: '$contribDates' },
            {
                $group: {
                    _id: {
                        $dateToString: { format: '%Y-%m-%d', date: '$contribDates', timezone: tz },
                    },
                    count: { $sum: 1 },
                },
            },
        ]);

        const postsByDay = await Post.aggregate([
            { $match: { author_id: uid, created_at: { $gte: start, $lt: end } } },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: tz } },
                    count: { $sum: 1 },
                },
            },
        ]);

        const commentsByDay = await Comment.aggregate([
            { $match: { author_id: uid, created_at: { $gte: start, $lt: end } } },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: tz } },
                    count: { $sum: 1 },
                },
            },
        ]);

        const yearStr = String(year);
        const { days, total } = mergeContributionDayRows(
            [feedByDay, userMediaContribByDay, postsByDay, commentsByDay],
            yearStr
        );

        const [feedBounds, postBounds, commentBounds, umBounds] = await Promise.all([
            !isPrivate
                ? Feed.aggregate([
                      { $match: { user: uid, type: feedExtraTypes } },
                      {
                          $addFields: {
                              activityAt: { $ifNull: ['$timestamp', '$createdAt'] },
                          },
                      },
                      { $match: { activityAt: { $type: 'date' } } },
                      {
                          $group: {
                              _id: null,
                              minDate: { $min: '$activityAt' },
                              maxDate: { $max: '$activityAt' },
                          },
                      },
                  ])
                : Promise.resolve([]),
            Post.aggregate([
                { $match: { author_id: uid } },
                {
                    $group: {
                        _id: null,
                        minDate: { $min: '$created_at' },
                        maxDate: { $max: '$created_at' },
                    },
                },
            ]),
            Comment.aggregate([
                { $match: { author_id: uid } },
                {
                    $group: {
                        _id: null,
                        minDate: { $min: '$created_at' },
                        maxDate: { $max: '$created_at' },
                    },
                },
            ]),
            UserMedia.aggregate([
                { $match: { user_id: uid } },
                {
                    $addFields: {
                        lastActivity: {
                            $cond: [{ $gt: ['$updatedAt', '$createdAt'] }, '$updatedAt', '$createdAt'],
                        },
                    },
                },
                {
                    $group: {
                        _id: null,
                        minDate: { $min: '$createdAt' },
                        maxDate: { $max: '$lastActivity' },
                    },
                },
            ]),
        ]);

        const mergedBounds = mergeBoundsObjects([
            feedBounds[0],
            postBounds[0],
            commentBounds[0],
            umBounds[0],
        ]);

        const currentYear = new Date().getFullYear();
        let availableYears = [currentYear];
        if (mergedBounds?.minDate && mergedBounds?.maxDate) {
            const yMin = mergedBounds.minDate.getFullYear();
            const yMax = mergedBounds.maxDate.getFullYear();
            availableYears = [];
            for (let y = yMin; y <= yMax; y++) availableYears.push(y);
            if (!availableYears.includes(currentYear)) {
                availableYears.push(currentYear);
                availableYears.sort((a, b) => a - b);
            }
        }

        return res.status(200).json({
            year,
            days,
            total,
            available_years: availableYears,
            timezone: tz,
        });
    } catch (error) {
        console.error('getMediaActivityHeatmap', error);
        return res.status(500).json({ error: 'Failed to load media activity' });
    }
};

const updateBio = async (req, res) => {
    const { username } = req.params;
    const senderId = req.user._id;

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user._id.equals(senderId)) return res.status(401).json({ error: 'Not authorized' });

        const incomingBio = typeof req.body.bio === 'string' ? req.body.bio : '';
        const sanitizedBio = sanitizeText(incomingBio, { maxLen: 200, allowNewlines: true });
        user.bio = sanitizedBio;
        await user.save();

        return res.status(200).json({ bio: user.bio });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to update bio' });
    }
};

const updateSocialLinks = async (req, res) => {
    const { username } = req.params;
    const senderId = req.user._id;

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user._id.equals(senderId)) return res.status(401).json({ error: 'Not authorized' });

        const igRaw = typeof req.body.instagram === 'string' ? req.body.instagram : '';
        const twRaw = typeof req.body.twitter === 'string' ? req.body.twitter : '';
        const ttRaw = typeof req.body.tiktok === 'string' ? req.body.tiktok : '';
        const ig = sanitizeIdentifier(igRaw.replace(/^@+/, ''), { maxLen: 30 });
        const tw = sanitizeIdentifier(twRaw.replace(/^@+/, ''), { maxLen: 15 });
        const tt = sanitizeIdentifier(ttRaw.replace(/^@+/, ''), { maxLen: 24 });

        user.instagram_handle = ig;
        user.twitter_handle = tw;
        user.tiktok_handle = tt;
        await user.save();

        return res.status(200).json({
            instagram: user.instagram_handle,
            twitter: user.twitter_handle,
            tiktok: user.tiktok_handle,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to update social links' });
    }
};

const submitFeedback = async (req, res) => {
    const { message, category } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required.' });
    }
    const safe = sanitizeFeedbackMessage(message, { maxLen: 4000 });
    if (!safe || safe.length < 3) {
        return res.status(400).json({ error: 'Please enter a slightly longer message.' });
    }
    const cat = ['feature', 'bug', 'general'].includes(category) ? category : 'general';

    try {
        const u = await User.findById(req.user._id).select('username email');
        if (!u) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        await Feedback.create({
            user_id: u._id,
            username: u.username,
            email: u.email || '',
            category: cat,
            message: safe,
        });

        return res.status(200).json({ ok: true });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to submit feedback' });
    }
};

const requestAccountDeletion = async (req, res) => {
    const { username } = req.params;
    const { password } = req.body || {};

    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'Password is required to delete your account.' });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user._id.equals(req.user._id)) {
            return res.status(401).json({ error: 'Not authorized' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Incorrect password.' });
        }

        const now = new Date();
        user.account_deletion_requested_at = now;
        user.account_scheduled_purge_at = scheduledPurgeAtFromNow(now);
        await user.save();

        return res.status(200).json({
            message: 'Your account is scheduled for deletion.',
            accountPendingDeletion: true,
            accountScheduledPurgeAt: user.account_scheduled_purge_at.toISOString(),
            graceDays: GRACE_DAYS,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to process deletion request' });
    }
};

const cancelAccountDeletion = async (req, res) => {
    const { username } = req.params;

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user._id.equals(req.user._id)) {
            return res.status(401).json({ error: 'Not authorized' });
        }

        user.account_deletion_requested_at = null;
        user.account_scheduled_purge_at = null;
        await user.save();

        return res.status(200).json({
            message: 'Account deletion cancelled.',
            accountPendingDeletion: false,
            accountScheduledPurgeAt: null,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to cancel deletion' });
    }
};

/**
 * Monthly calendar "star receipt": one top-rated cover per day (timezone-aware).
 * Today prefers the latest rated title added that day; other days use best rating on activity date.
 * Visibility matches profile library access (public or approved follower).
 */
const getStarReceipt = async (req, res) => {
    try {
        const { username } = req.params;
        const tz = sanitizeTimeZone(req.query.tz);

        const user = await User.findOne({ username }).select('_id username private followers account_deletion_requested_at').lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const requestingUser = await getRequestingUserFromToken(req);
        const isOwnerOrAdminProfile =
            (requestingUser && requestingUser._id.toString() === user._id.toString()) || isAdminUser(requestingUser);

        if (user.account_deletion_requested_at && !isOwnerOrAdminProfile) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!canViewPrivateAccountContent(user, requestingUser)) {
            return res.status(403).json({ error: 'This account is private.', code: 'PROFILE_PRIVATE' });
        }

        const now = new Date();
        let year = parseInt(String(req.query.year || ''), 10);
        let month = parseInt(String(req.query.month || ''), 10);
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            const yPart = now.toLocaleDateString('en-CA', { timeZone: tz, year: 'numeric' });
            year = parseInt(yPart, 10) || now.getUTCFullYear();
        }
        if (!Number.isFinite(month) || month < 1 || month > 12) {
            const parts = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
            month = parseInt(parts[1], 10) || now.getUTCMonth() + 1;
        }

        const rangeStart = new Date(Date.UTC(year, month - 2, 1));
        const rangeEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

        const lookupStages = [
            {
                $lookup: {
                    from: 'uniquemedias',
                    localField: 'unique_media_ref',
                    foreignField: '_id',
                    as: 'umDocs',
                },
            },
            {
                $addFields: {
                    um: { $arrayElemAt: ['$umDocs', 0] },
                },
            },
        ];

        const ratedPipeline = [
            { $match: { user_id: user._id } },
            {
                $addFields: {
                    ratingNum: {
                        $convert: { input: '$rating', to: 'double', onError: 0, onNull: 0 },
                    },
                    sortDate: { $ifNull: ['$finished_at', '$updatedAt'] },
                },
            },
            { $match: { ratingNum: { $gte: 0.5 } } },
            {
                $match: {
                    $or: [
                        { sortDate: { $gte: rangeStart, $lte: rangeEnd } },
                        { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
                    ],
                },
            },
            ...lookupStages,
        ];

        /** Any row with createdAt in range — for “last added that day” when nothing rated maps. */
        const addedPipeline = [
            { $match: { user_id: user._id } },
            {
                $match: {
                    createdAt: { $gte: rangeStart, $lte: rangeEnd },
                },
            },
            {
                $addFields: {
                    ratingNum: {
                        $convert: { input: '$rating', to: 'double', onError: 0, onNull: 0 },
                    },
                    sortDate: { $ifNull: ['$finished_at', '$updatedAt'] },
                },
            },
            ...lookupStages,
        ];

        const [rowsRated, rowsAdded] = await Promise.all([
            UserMedia.aggregate(ratedPipeline),
            UserMedia.aggregate(addedPipeline),
        ]);

        const lastDay = daysInMonth(year, month);

        const todayKey = dayKeyFromInstant(now, tz);

        const mapDoc = (doc) => {
            const sortKey = dayKeyFromInstant(doc.sortDate, tz);
            const createdKey = dayKeyFromInstant(doc.createdAt, tz);
            const um = doc.um || {};
            const useCustom = Boolean(doc.use_custom_display) && String(doc.custom_name || '').trim().length > 0;
            const name = useCustom ? doc.custom_name : (um.name || 'Unknown title');
            const image_url =
                useCustom && doc.custom_image_url ? doc.custom_image_url : (um.image_url || '');
            return {
                ...doc,
                sortKey,
                createdKey,
                displayName: name,
                displayImage: image_url || '',
                displayType: um.type || '',
                ratingNum: Number(doc.ratingNum) || 0,
            };
        };

        const enrichedRated = rowsRated.map(mapDoc);
        const enrichedAdded = rowsAdded.map(mapDoc);

        const pickRatedForDay = (dayKey) => {
            const rated = enrichedRated.filter((d) => Number(d.ratingNum) >= 0.5);
            if (dayKey === todayKey) {
                const addedToday = rated.filter((d) => d.createdKey === dayKey);
                if (addedToday.length) {
                    addedToday.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                    return addedToday[0];
                }
            }
            const bySort = rated.filter((d) => d.sortKey === dayKey);
            if (!bySort.length) return null;
            bySort.sort((a, b) => {
                if (Number(b.ratingNum) !== Number(a.ratingNum)) {
                    return Number(b.ratingNum) - Number(a.ratingNum);
                }
                return new Date(b.sortDate) - new Date(a.sortDate);
            });
            return bySort[0];
        };

        /** Most recently created library row on this calendar day (includes unrated). */
        const pickLastAddedForDay = (dayKey) => {
            const onDay = enrichedAdded.filter((d) => d.createdKey === dayKey);
            if (!onDay.length) return null;
            onDay.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return onDay[0];
        };

        const toDayPayload = (winner) => {
            const hasRating = Number(winner.ratingNum) >= 0.5;
            return {
                name: winner.displayName,
                image_url: winner.displayImage,
                rating: hasRating ? ratingForApiResponse(winner.ratingNum) : null,
                type: winner.displayType,
            };
        };

        const days = {};
        for (let d = 1; d <= lastDay; d += 1) {
            const key = new Date(Date.UTC(year, month - 1, d, 12, 0, 0, 0)).toLocaleDateString('en-CA', {
                timeZone: tz,
            });
            const ratedWinner = pickRatedForDay(key);
            const winner = ratedWinner || pickLastAddedForDay(key);
            days[key] = winner ? toDayPayload(winner) : null;
        }

        const startWeekday = startWeekdaySundayFirst(year, month, tz);

        return res.status(200).json({
            username: user.username,
            year,
            month,
            monthTitle: monthTitleUpper(year, month),
            timeZone: tz,
            startWeekday,
            daysInMonth: lastDay,
            todayKey,
            days,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to load receipt' });
    }
};

module.exports = {
    signupUser,
    loginUser,
    followRequest,
    unfollowRequest,
    changePrivacy,
    changeIcon,
    changeBanner,
    getConnections,
    getIcon,
    getUserProfile,
    searchUsers,
    sendPasswordResetEmail,
    resetPassword,
    updateOnboarding,
    updateBio,
    updateSocialLinks,
    getMediaActivityHeatmap,
    submitFeedback,
    requestAccountDeletion,
    cancelAccountDeletion,
    getStarReceipt,
};