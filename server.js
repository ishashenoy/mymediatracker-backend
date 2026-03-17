require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const mediaRoutes = require('./routes/medias');
const userRoutes = require('./routes/user');
const searchRoutes = require('./routes/search');
const feedRoutes = require('./routes/feed');

// creating instance of express app
const app = express();

const cors = require('cors');

const corsOptions = {
  origin: [ // REMEMBER: change when domain name is changed
    'https://mytria.app',
    'http://localhost:3000',
    'http://localhost:8081',
    'http://10.39.52.174:8081',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

app.set('trust proxy', 1);

// middleware
app.use(express.json());

// routes
app.use('/api/medias', mediaRoutes);
app.use('/api/user', userRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/lists', require('./routes/lists'));

//conecting to db
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    // listen for requests
    app.listen(process.env.PORT || 3001, () => {
      // Server connected and listening
    })
  })
  .catch((error) => {
    // Error connecting to db
  })