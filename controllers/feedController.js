const Feed = require('../models/feedModel');
const UserMedia = require('../models/userMediaModel');
const User = require('../models/userModel');

// Get feed with filtering and pagination
const getFeed = async (req, res) => {
  const { page = 1, limit = 20, filter = 'all' } = req.query;
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const skip = (parsedPage - 1) * parsedLimit;

  const query = {};

  try {
    if (filter === 'following') {
      const user = await User.findById(req.user._id).select('following');
      const followedUsers = [req.user._id, ...(user?.following || [])];
      query.user = { $in: followedUsers };
    } else if (filter === 'global') {
      const privateUsers = await User.find({ private: true }).select('_id');
      query.user = { $nin: privateUsers.map((u) => u._id) };
    }

    const activities = await Feed.find(query)
      .populate('user', 'username icon')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parsedLimit);

    const hasMore = activities.length === parsedLimit;

    res.status(200).json({ activities, hasMore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Internal function to create feed activities
const createFeedActivity = async (userId, type, mediaId, oldValue, newValue) => {
  try {
    const user = await User.findById(userId).select('private');
    if (!user || user.private) return;

    const activityData = { user: userId, type, oldValue, newValue };

    if (mediaId) {
      const userMedia = await UserMedia.findById(mediaId).populate('unique_media_ref');

      if (userMedia && userMedia.unique_media_ref) {
        const media = userMedia.unique_media_ref;

        activityData.media = userMedia._id;
        activityData.mediaName = media.name;
        activityData.mediaType = media.type;
        activityData.mediaSource = media.source;
        activityData.mediaImage = media.image_url;
        activityData.mediaId = media.media_id;
        activityData.milestoneData = newValue;
      }
    }

    await Feed.create(activityData);
  } catch (error) {
    // Error creating feed activity
  }
};

// Check and create milestone activities
const checkMilestones = async (userId) => {
  try {
    const mediaCount = await UserMedia.countDocuments({ user_id: userId });
    const milestones = [50, 100, 200, 500, 1000];

    for (const milestone of milestones) {
      if (mediaCount === milestone) {
        await createFeedActivity(userId, 'milestone', null, null, `${milestone}_titles`);
      }
    }
  } catch (error) {
    // Error checking milestones
  }
};

module.exports = {
  getFeed,
  createFeedActivity,
  checkMilestones
};
