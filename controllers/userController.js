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
const { sanitizeText } = require('../utils/sanitize');

cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL
});

//create jwt
const createToken = (_id) => {
    return jwt.sign({_id}, process.env.SECRET, { expiresIn: '7d' })
}

const isAdminUser = (user) => {
    if (!user) return false;
    return user.role === 'admin' || user.isAdmin === true || user.is_admin === true;
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
        req.requestingUser = await User.findById(_id).select('_id username following role isAdmin is_admin');
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
    return res.status(200).json({ username: user.username, token, icon: user.icon || null });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

// GET user's connections list
const getConnections = async (req, res) => {
    const { username } = req.params; // this is the user's username
    const user = await User.findOne({username: username});

    //Checking if the username exists
    if (!user) return res.status(404).json({error: 'User does not exist.'});

    const userFollowers = user.followers;
    const userFollowing = user.following;
    return res.status(200).json({followers: userFollowers, following: userFollowing});
}

// GET user's icon
const getIcon = async (req, res) => {
    const { username } = req.params; // this is the user's username
    const user = await User.findOne({username: username});

    //Checking if the username exists
    if (!user) return res.status(404).json({error: 'User does not exist.'});

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

        // Log upload to audit trail (fire-and-forget)
        setImmediate(async () => {
            try {
                const UserUpload = require('../models/userUploadModel');
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

// Search for users by username or email (partial, case-insensitive)
const searchUsers = async (req, res) => {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: "Search query is required." });
    }

    const query = q.trim();

    try {
        // Search by username or email (partial, case-insensitive)
        const users = await User.find({ username: { $regex: query, $options: 'i' }})
        .select('username icon private')
        .limit(20);

        const results = users.map(u => ({
            username: u.username,
            icon: u.icon || null,
            private: u.private
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
    return res.status(200).json({ username, token });
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

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'No account found with that email.' });
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

        return res.status(200).json({ message: 'Password reset email sent.' });

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
        const isOwnerOrAdmin = (requestingUser && requestingUser._id.toString() === user._id.toString())
            || isAdminUser(requestingUser);

        // Get user's lists
        const List = require('../models/listModel');
        const userListsQuery = {
            user_id: user._id,
            archived: false,
            ...(isOwnerOrAdmin ? {} : { private: false }),
        };

        const userLists = await List.find(userListsQuery)
            .sort({ position: 1, created_at: -1 });

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
                rating: media.rating,
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
                    private: Boolean(list.private),
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
                bio: user.bio || '',
                private: user.private,
                created_at: user.createdAt
            },
            connections: detailedConnections,
            lists: listDetails,
            stats: {
                total_lists: userLists.length,
                total_media: listDetails.reduce((sum, list) => sum + list.media_count, 0)
            },
            permissions: {
                can_view_lists: true
            }
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

        const { onboarding_selections } = req.body;
        if (!Array.isArray(onboarding_selections)) {
            return res.status(400).json({ error: 'onboarding_selections must be an array.' });
        }

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
}

module.exports = {
    signupUser,
    loginUser,
    followRequest,
    unfollowRequest,
    changePrivacy,
    changeIcon,
    getConnections,
    getIcon,
    getUserProfile,
    searchUsers,
    sendPasswordResetEmail,
    resetPassword,
    updateOnboarding,
    updateBio,
}