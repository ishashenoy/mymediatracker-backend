const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const Mailjet = require('node-mailjet');
const mailjet = Mailjet.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_SECRET_KEY
);
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcrypt');
const validator = require('validator');

cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL
});

//create jwt
const createToken = (_id) => {
    return jwt.sign({_id}, process.env.SECRET)
}

const verifyRecaptcha = async (token) => {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    const response = await axios.post(
        `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`
    );
    return response.data.success;
};

// login user
const loginUser = async (req, res) => {
    const {email, password, recaptchaToken} = req.body;

    if (!recaptchaToken) {
        return res.status(400).json({ error: 'reCAPTCHA token is missing.' });
    }

    const isHuman = await verifyRecaptcha(recaptchaToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'reCAPTCHA verification failed.\n Please refresh the page and try again.' });
    }

    try {
        const user = await User.login(email, password);

        //create a token
        const token = createToken(user._id);
        const username = user.username;

        return res.status(200).json({username, token});
    } catch (error) {
        return res.status(400).json({error: error.message});
    }
}

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
    const user = await User.findOne({username: username});

    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id;

    if (!(user._id.equals(senderId))) return res.status(401).json({error: 'Not authorized'});

    if (user.icon) {
        // This id will allow us to replace images and delete unused ones.
        const oldPublicId = user.icon.split('/').slice(-1)[0].split('.')[0]; // extract public_id from URL
        await cloudinary.uploader.destroy(oldPublicId);
    }

    //Uploading the image to cloudinary storage
    return cloudinary.uploader.upload_stream(
    { 
        public_id: `icons/${user._id}`, // give a unique id for this user's icon
        overwrite: true,
        //Cropping the image to fit size limits
        transformation: [
        { width: 500, height: 500, crop: "limit" }, // image shouldn't exceed 500x500
        { quality: "auto:eco", fetch_format: "auto" } // compressing images as well
    ]},
    (error, result) => {
        if (error){
            return res.status(400).json({error: error})
        }else{
            //Saving the image url to mongo db
            user.icon = result.secure_url;
            user.save();
            return res.status(200).json({ message: "Icon processed", image_url: result.secure_url});
        }
    }).end(req.file.buffer);
}


// GET user's banners
const getBanner = async (req, res) => {
    const user_id = req.user._id;
    
    const user = await User.findOne({_id: user_id});

    //Checking if the username exists
    if (!user) return res.status(404).json({error: 'User does not exist.'});

    let banners = user.banners;

    if (!banners || Object.keys(banners).length === 0) {
        return res.status(200).json({ message: 'none' });
    }


    // Convert Map to plain object if needed
    if (banners instanceof Map) {
        banners = Object.fromEntries(banners);
    } else if (banners && banners.toObject) {
        banners = banners.toObject();
    }
    
    return res.status(200).json(banners);
}

// change user's banner for a media page
const changeBanner = async (req, res) => {
    const { type_number  } = req.params; // this is the type of media

    const user_id = req.user._id;

    const user = await User.findOne({_id: user_id});

    // this is the sender's trusted user id 
    // verified by the jwt token provided to our middleware
    const senderId = req.user._id;

    if (!(user._id.equals(senderId))) return res.status(401).json({error: 'Not authorized'});

    if (user.banners && user.banners.get(type_number)) {
        const oldBannerUrl = user.banners.get(type_number);
        const oldPublicId = oldBannerUrl.split('/').slice(-1)[0].split('.')[0];
        await cloudinary.uploader.destroy(oldPublicId);
    }

    cloudinary.uploader.upload_stream(
    { 
        public_id: `banners/${user._id}_${type_number}`, // unique id per type_number
        overwrite: true,
        transformation: [
        { width: 1600, height: 200, crop: "limit" }, // image shouldn't exceed 1600x200
        { quality: "auto:eco", fetch_format: "auto" } // compressing images as well
    ]},
    (error, result) => {
        if (error){
            return res.status(400).json({error: error})
        }else{
            if (!type_number ) return;

            if (!user.banners) {
                user.banners = new Map(); // initialize if missing
            }

            user.banners.set(type_number, result.secure_url);

            user.save();

            return res.status(200).json({ message: "Banner processed", image_url: result.secure_url});
        }
    }).end(req.file.buffer);
}

// get a list of all public users based on a search
const getUsers = async (req,res) => {
    const username = req.query.username;

    try {
        const users = await User.find({username: username});

        const user_info = {
            username: username,
            icon_url: users?.image_url
        }

        return users ? res.status(200).json(user_info) : res.status(404).json({error: "User not found."});
    }catch (error) {
        res.status(400).json({error: error.message});
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

    try{
        // Update the receivers follower list
        const receivingUser = await User.findOneAndUpdate({ username: username}, {
            $addToSet: { followers: senderUsername  }
        });

        // checking if the receiving user exists.
        if (!receivingUser) return res.status(404).json({error: 'User does not exist.'});

        // Checking if the users are already following each other.
        if (receivingUser.followers.includes(username)) return res.status(200).json({ message: "Already following!" });
        
        //Update the senders following list
        await User.findOneAndUpdate({ username: senderUsername}, {
            $addToSet: { following: username }
        });
        res.status(200).json({ message: "Follow succesfull!" });
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
        res.status(200).json({ message: "Unfollow succesfull!" });
    } catch (error) {
        return res.status(500).json({error: 'Internal server error.'});
    }
}

// signup user
const signupUser = async (req, res) => {
    const {email, password, username, recaptchaToken} = req.body;

    if (!recaptchaToken) {
        return res.status(400).json({ error: 'reCAPTCHA token is missing.' });
    }

    const isHuman = await verifyRecaptcha(recaptchaToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'reCAPTCHA verification failed.\n Please refresh the page and try again.' });
    }

    try {
        const user = await User.signup(email, password, username);

        //create a token
        const token = createToken(user._id);

        res.status(200).json({username, token});
    } catch (error) {
        res.status(400).json({error: error.message});
    }
}

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
                            Name: "MyMediaTracker Support"
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

        console.log('Mailjet response:', result.body); // Add this line

        return res.status(200).json({ message: 'Password reset email sent.' });

    } catch (error) {
        console.error('Error sending reset email:', error);
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

module.exports = {
    loginUser,
    signupUser,
    followRequest,
    unfollowRequest,
    changePrivacy,
    changeIcon,
    changeBanner,
    getConnections,
    getIcon,
    getBanner,
    getUsers,
    sendPasswordResetEmail,
    resetPassword
}