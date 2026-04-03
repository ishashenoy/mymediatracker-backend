require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const { createProxyMiddleware } = require('http-proxy-middleware');
const posthog = require('./posthog');
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
    'http://localhost:3001',
    'http://localhost:3002',
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
app.use(require('./middleware/requestLogger'));

// PostHog reverse proxy — bypasses ad blockers
app.use(['/ingest', '/metrics'], createProxyMiddleware({
  target: 'https://us.i.posthog.com',
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/(ingest|metrics)/, ''),
}));

// routes
app.use('/api/medias', mediaRoutes);
app.use('/api/user', userRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/lists', require('./routes/lists'));
app.use('/api/events', require('./routes/events'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/aggregate', require('./routes/aggregate'));
app.use('/api/notifications', require('./routes/notifications'));

//conecting to db
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    // Register new collections so their indexes are created on startup
    require('./models/canonicalMediaModel');
    require('./models/mediaSourceModel');
    require('./models/eventModel');
    require('./models/userUploadModel');
    require('./models/followModel');
    require('./models/postModel');
    require('./models/postInteractionModel');
    require('./models/commentModel');
    require('./models/notificationModel');
    require('./models/feedbackModel');

    const { startAccountPurgeScheduler } = require('./jobs/purgeScheduledAccounts');
    startAccountPurgeScheduler();

    // listen for requests
    app.listen(process.env.PORT || 3001, () => {
      // Server connected and listening
      console.log('Server connected and listening on port', process.env.PORT || 3001);
    })
  })
  .catch((error) => {
    // Error connecting to db
  })

process.on('SIGTERM', async () => {
  await posthog.shutdown();
});
process.on('SIGINT', async () => {
  await posthog.shutdown();
});