require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const mediaRoutes = require('./routes/medias');
const userRoutes = require('./routes/user');

// creating instance of express app
const app = express();

const cors = require('cors');

app.use(cors());

// middleware
app.use(express.json());
app.use((req, res, next) => {
    console.log(req.path, req.method);
    next();
})

// routes
app.use('/api/medias', mediaRoutes);
app.use('/api/user', userRoutes);

//conecting to db
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        // listen for requests
        app.listen(process.env.PORT || 3001, () => {
            console.log('connected to db & listening on port', process.env.PORT);
        })
    })
    .catch((error) => {
        console.log(error);
})