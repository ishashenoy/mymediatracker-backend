const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

const User = require('../models/userModel');
const UserMedia = require('../models/userMediaModel');
const UniqueMedia = require('../models/uniqueMediaModel');
const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const Feed = require('../models/feedModel');
const Post = require('../models/postModel');
const PostInteraction = require('../models/postInteractionModel');
const Comment = require('../models/commentModel');
const CommentInteraction = require('../models/commentInteractionModel');
const PollVote = require('../models/pollVoteModel');
const Notification = require('../models/notificationModel');
const Follow = require('../models/followModel');
const Event = require('../models/eventModel');
const UserUpload = require('../models/userUploadModel');

cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

async function destroyInternalUniqueMediaImage(media) {
  if (!media || media.source !== 'internal' || !media.image_url) return;
  try {
    const match = media.image_url.match(/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
    const publicId = match ? match[1] : null;
    if (publicId) {
      await cloudinary.uploader.destroy(publicId).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * Hard-deletes a user and all app-owned rows tied to them. Caller must ensure
 * the account is past the grace-period policy (scheduled purge time reached).
 */
async function permanentlyPurgeUser(userId) {
  const uid = new mongoose.Types.ObjectId(userId);
  const user = await User.findById(uid).select('username followers following');
  if (!user) {
    return { ok: false, reason: 'not_found' };
  }

  const username = user.username;

  const userMediaDocs = await UserMedia.find({ user_id: uid })
    .populate('unique_media_ref')
    .lean();

  const listIds = await List.find({ user_id: uid }).distinct('_id');

  await ListItem.deleteMany({
    $or: [{ user_id: uid }, { list_id: { $in: listIds } }],
  });
  await List.deleteMany({ user_id: uid });

  const uniqueIdsFromUser = [
    ...new Set(
      userMediaDocs
        .map((d) => d.unique_media_ref && d.unique_media_ref._id)
        .filter(Boolean)
        .map((id) => id.toString())
    ),
  ].map((s) => new mongoose.Types.ObjectId(s));

  await UserMedia.deleteMany({ user_id: uid });

  for (const umId of uniqueIdsFromUser) {
    const remaining = await UserMedia.countDocuments({ unique_media_ref: umId });
    if (remaining === 0) {
      const media = await UniqueMedia.findById(umId);
      if (media) {
        await destroyInternalUniqueMediaImage(media);
        await UniqueMedia.deleteOne({ _id: umId });
      }
    }
  }

  await Feed.deleteMany({ user: uid });

  const ownPostIds = await Post.find({ author_id: uid }).distinct('_id');
  for (const postId of ownPostIds) {
    const commentIds = await Comment.find({ post_id: postId }).distinct('_id');
    await CommentInteraction.deleteMany({ comment_id: { $in: commentIds } });
    await Comment.deleteMany({ post_id: postId });
    await PostInteraction.deleteMany({ post_id: postId });
    await PollVote.deleteMany({ post_id: postId });
    await Post.deleteOne({ _id: postId });
  }

  const authoredCommentIds = await Comment.find({ author_id: uid }).distinct('_id');
  await CommentInteraction.deleteMany({ comment_id: { $in: authoredCommentIds } });
  await Comment.deleteMany({ author_id: uid });

  await PostInteraction.deleteMany({ user_id: uid });
  await PollVote.deleteMany({ user_id: uid });

  await Notification.deleteMany({
    $or: [{ recipient_id: uid }, { actor_id: uid }],
  });

  await Follow.deleteMany({
    $or: [{ follower_id: uid }, { followee_id: uid }],
  });

  await Event.deleteMany({ user_id: uid });
  await UserUpload.deleteMany({ user_id: uid });

  const followerUsernames = Array.isArray(user.followers) ? user.followers : [];
  const followingUsernames = Array.isArray(user.following) ? user.following : [];

  await User.updateMany(
    { username: { $in: followerUsernames } },
    { $pull: { following: username } }
  );
  await User.updateMany(
    { username: { $in: followingUsernames } },
    { $pull: { followers: username } }
  );

  await User.deleteOne({ _id: uid });

  return { ok: true };
}

async function purgeAccountsPastScheduledDate(now = new Date()) {
  const due = await User.find({
    account_deletion_requested_at: { $ne: null },
    account_scheduled_purge_at: { $lte: now },
  }).select('_id');

  const results = { purged: 0, errors: [] };
  for (const u of due) {
    try {
      const r = await permanentlyPurgeUser(u._id);
      if (r.ok) results.purged += 1;
    } catch (e) {
      results.errors.push({ id: String(u._id), message: e.message });
    }
  }
  return results;
}

module.exports = {
  permanentlyPurgeUser,
  purgeAccountsPastScheduledDate,
};
