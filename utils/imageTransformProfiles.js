const IMAGE_OPTIMIZATION_BASE = Object.freeze([
  { quality: 'auto:low', fetch_format: 'auto' },
  { dpr: 'auto' },
  { compression: 'medium' },
]);

const IMAGE_TRANSFORMS = Object.freeze({
  userIcon: Object.freeze([
    { width: 400, height: 400, crop: 'fill' },
    { effect: 'improve' },
    ...IMAGE_OPTIMIZATION_BASE,
  ]),
  userBanner: Object.freeze([
    { width: 1200, height: 400, crop: 'fill', gravity: 'auto' },
    ...IMAGE_OPTIMIZATION_BASE,
  ]),
  mediaCover: Object.freeze([
    { width: 600, height: 900, crop: 'limit' },
    { effect: 'improve' },
    ...IMAGE_OPTIMIZATION_BASE,
  ]),
  listCover: Object.freeze([
    { width: 960, height: 540, crop: 'fill', gravity: 'auto' },
    ...IMAGE_OPTIMIZATION_BASE,
  ]),
  postEmbed: Object.freeze([
    { width: 1280, height: 1280, crop: 'limit' },
    ...IMAGE_OPTIMIZATION_BASE,
  ]),
});

module.exports = {
  IMAGE_TRANSFORMS,
};
