const cloudinary = require('cloudinary').v2;
const { IMAGE_TRANSFORMS } = require('./imageTransformProfiles');

cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

const MAX_EMBEDDED_IMAGES = 4;

/**
 * Stream a buffer to Cloudinary with the same optimization pattern as
 * media cover uploads (webp, auto quality, bounded dimensions).
 */
function uploadPostImageBuffer(buffer, userId) {
  const safeUser = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'anon';
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        public_id: `post-embeds/${safeUser}/${Date.now()}`,
        overwrite: false,
        format: 'webp',
        transformation: IMAGE_TRANSFORMS.postEmbed,
      },
      (error, uploadResult) => {
        if (error) reject(error);
        else resolve(uploadResult);
      }
    ).end(buffer);
  });
}

function isTrustedImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  return u.startsWith('https://res.cloudinary.com/');
}

module.exports = {
  MAX_EMBEDDED_IMAGES,
  uploadPostImageBuffer,
  isTrustedImageUrl,
};
