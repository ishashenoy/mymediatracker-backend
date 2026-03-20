const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const requireAuth = async (req, res, next) => {
    // verify if user is authenticated
    const { authorization } = req.headers;
    
    if (!authorization){
        return res.status(401).json({error: 'Authorization token required'});
    }

    //splitting the token to get the jwt
    // Since it is made up of two parts (Bearer ####), we need to split it by the space and get the second part.
    const token = authorization.split(' ')[1];

    try {
        const {_id} = jwt.verify(token, process.env.SECRET);

        req.user = await User.findOne({_id}).select('_id');
        
        if (!req.user) {
            return res.status(401).json({error: 'User not found'});
        }
        
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({error: 'Session expired. Please log in again.'});
        } else if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({error: 'Invalid token. Please log in again.'});
        } else {
            return res.status(401).json({error: 'Request is not authorized'});
        }
    }
}

module.exports = requireAuth;