const Feed = require('../models/feedModel');
const Media = require('../models/mediaModel');
const User = require('../models/userModel');

// Get feed with filtering and pagination
const getFeed = async (req, res) => {
  const { page = 1, limit = 20, filter = 'all' } = req.query;
  const skip = (page - 1) * limit;
  
  let query = {};
  
  if (filter === 'following') {
    // Get followed users
    const user = await User.findById(req.user._id);
    const followedUsers = [req.user._id, ...(user.following || [])];
    query.user = { $in: followedUsers };
  } else if (filter === 'global') {
    // Exclude private users
    const privateUsers = await User.find({ private: true }).select('_id');
    query.user = { $nin: privateUsers.map(u => u._id) };
  }
  
  try {
    const activities = await Feed.find(query)
      .populate('user', 'username icon')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const hasMore = activities.length === parseInt(limit);
    
    res.status(200).json({ activities, hasMore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Internal function to create feed activities
const createFeedActivity = async (userId, type, mediaId, oldValue, newValue) => {
  try {
    const user = await User.findById(userId);
    if (user.private) return; // Skip private users
    
    let activityData = { user: userId, type, oldValue, newValue };
    
    if (mediaId) {
      const media = await Media.findById(mediaId);
      if (media) {
        activityData.media = mediaId;
        activityData.mediaName = media.name;
        activityData.mediaType = media.type;
        activityData.mediaImage = media.image_url;
        activityData.mediaId = media.media_id; // for linking to details page
      }
    }
    
    await Feed.create(activityData);
  } catch (error) {
    console.error('Error creating feed activity:', error);
  }
};

// Check and create milestone activities
const checkMilestones = async (userId) => {
  try {
    const mediaCount = await Media.countDocuments({ user_id: userId });
    const milestones = [50, 100, 200, 500, 1000];
    
    for (const milestone of milestones) {
      if (mediaCount === milestone) {
        await createFeedActivity(userId, 'milestone', null, null, `${milestone}_titles`);
      }
    }
  } catch (error) {
    console.error('Error checking milestones:', error);
  }
};

module.exports = {
  getFeed,
  createFeedActivity,
  checkMilestones
};