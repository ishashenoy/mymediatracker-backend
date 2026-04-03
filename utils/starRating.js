/**
 * Normalizes user star ratings to half-star steps (0.5–5) stored as Number, or null when cleared.
 */

function normalizeStarRatingInput(raw) {
  if (raw === undefined) {
    return { skip: true };
  }
  if (raw === null || raw === '') {
    return { value: null };
  }

  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (Number.isNaN(n)) {
    throw new Error('Invalid rating');
  }

  if (n === 0) {
    return { value: null };
  }

  const stepped = Math.round(n * 2) / 2;
  if (stepped < 0.5 || stepped > 5) {
    throw new Error('Rating must be between 0.5 and 5 stars');
  }

  return { value: stepped };
}

function ratingForApiResponse(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  normalizeStarRatingInput,
  ratingForApiResponse,
};
