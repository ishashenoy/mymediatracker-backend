const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const axios = require('axios');

//create jwt
const createToken = (_id) => {
    return jwt.sign({_id}, process.env.SECRET, { expiresIn: '3d' })
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
        return res.status(400).json({ error: 'reCAPTCHA verification failed.' });
    }

    try {
        const user = await User.login(email, password);

        //create a token
        const token = createToken(user._id);
        const username = user.username;

        res.status(200).json({username, token});
    } catch (error) {
        res.status(400).json({error: error.message});
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
        return res.status(400).json({ error: 'reCAPTCHA verification failed.' });
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

module.exports = {
    loginUser,
    signupUser
}