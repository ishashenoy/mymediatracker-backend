/**
 * Allow the duplicate review API for local/dev usage without extra setup.
 * Remote environments still require DUPLICATE_REVIEW_ENABLED=true.
 */
function duplicateReviewEnabled(req, res, next) {
  const host = String(req.get('host') || '').toLowerCase();
  const origin = String(req.get('origin') || '').toLowerCase();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const isLocalOrigin =
    !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  if (process.env.DUPLICATE_REVIEW_ENABLED === 'true') {
    return next();
  }

  if (isLocalHost && isLocalOrigin) {
    return next();
  }

  return res.status(404).json({ error: 'Not found' });
}

module.exports = duplicateReviewEnabled;
