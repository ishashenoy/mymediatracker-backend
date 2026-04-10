const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const validator = require('validator');

const Schema = mongoose.Schema;

const userSchema = new Schema({
    email : {
        type: String,
        required: true,
        unique: true
    },
    username : {
        type: String,
        required: true,
        unique: true
    },
    password : {
        type: String,
        required: true
    },
    following : {
        type: Array,
        required: false
    },
    followers : {
        type: Array,
        required: false
    },
    icon : {
        type: String,
        required: false
    },
    banner: {
        type: String,
        required: false
    },
    is_creator_badge: {
        type: Boolean,
        default: false
    },
    // banners field removed; banners now stored per-list
    private : {
        type: Boolean,
        default: false
    },
    bio: {
        type: String,
        default: '',
        maxlength: 200,
        trim: true,
    },

    // --- Demographic & onboarding fields (all optional, collected progressively) ---
    birth_year: {
        type: Number,
        default: null,
    },
    // ISO 3166-1 alpha-2 country code, e.g. 'US', 'IN'
    country: {
        type: String,
        default: null,
    },
    locale: {
        type: String,
        default: null,
    },
    // Stores structured onboarding step data (media types, platforms, seed titles)
    onboarding_selections: {
        type: Array,
        default: [],
    },
    last_active_at: {
        type: Date,
        default: null,
    },
    account_deletion_requested_at: {
        type: Date,
        default: null,
    },
    account_scheduled_purge_at: {
        type: Date,
        default: null,
    },
  },
  { timestamps: true }
);

userSchema.index(
  { account_scheduled_purge_at: 1 },
  {
    partialFilterExpression: {
      account_scheduled_purge_at: { $type: 'date' },
    },
  }
);

// static signup method
userSchema.statics.signup = async function (email, password, username) {

    //validation 
    if (!email || !password || !username){
        throw Error('All fields must be filled');
    }

    if (!validator.isEmail(email)){
        throw Error('Email is not valid');
    }

    const customOptions = {
        minLength: 8,
        minSymbols: 0,
        minLowercase: 1,
        minUppercase: 0
    };

    const exists = await this.findOne({ email }) || await this.findOne({ username: new RegExp(`^${username}$`, 'i') });

    if (exists){
        throw Error('Email/username already in use');
    }

    if (!validator.isStrongPassword(password, customOptions)){
        throw Error('Password not strong enough');
    }
    
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const user = await this.create({ email, username, password: hash, private: false});

    return user;
}

// static login method
userSchema.statics.login = async function (email, password) {
    //validation 
    if (!email || !password){
        throw Error('All fields must be filled');
    }

    const user = await this.findOne({ email });

    const match = user ? await bcrypt.compare(password, user.password) : false;

    if (!user || !match) {
        throw Error('Incorrect email or password.');
    }

    if (user.account_scheduled_purge_at && new Date() >= new Date(user.account_scheduled_purge_at)) {
        throw Error('This account is no longer available.');
    }

    return user;
}

module.exports = mongoose.model('User', userSchema);
