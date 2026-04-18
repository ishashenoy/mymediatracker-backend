function stripHtmlTags(value) {
  return String(value).replace(/<[^>]*>/g, '');
}

function removeControlChars(value, { keepNewlines = true } = {}) {
  // Remove ASCII control chars except newline/tab if desired.
  // \x00-\x08, \x0B-\x0C, \x0E-\x1F, \x7F
  const base = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (keepNewlines) return base;
  return base.replace(/[\r\n\t]/g, ' ');
}

function collapseWhitespace(value, { keepNewlines = true } = {}) {
  const s = String(value);
  if (keepNewlines) {
    // Collapse spaces/tabs but keep newlines meaningful.
    return s
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{4,}/g, '\n\n\n');
  }
  return s.replace(/\s+/g, ' ');
}

/**
 * Sanitize user-provided plain text for DB storage.
 * - Strips HTML tags (defense-in-depth against stored XSS)
 * - Removes control characters
 * - Trims and collapses excessive whitespace
 * - Enforces max length (hard cap)
 */
function sanitizeText(input, { maxLen = 500, allowNewlines = true } = {}) {
  if (input === undefined || input === null) return '';
  const stripped = stripHtmlTags(input);
  const noCtrl = removeControlChars(stripped, { keepNewlines: allowNewlines });
  const collapsed = collapseWhitespace(noCtrl, { keepNewlines: allowNewlines });
  const trimmed = collapsed.trim();
  if (typeof maxLen === 'number' && maxLen > 0) {
    return trimmed.slice(0, maxLen);
  }
  return trimmed;
}

const ZERO_WIDTH_AND_BOM = /[\u200B-\u200D\uFEFF\u00AD]/g;

/**
 * Plain-text body for feedback / suggestion storage (DB + optional webhooks).
 * Strips HTML, control chars, zero-width/BOM, collapses whitespace; hard-caps length.
 */
function sanitizeFeedbackMessage(input, { maxLen = 4000 } = {}) {
  if (typeof input !== 'string') {
    return '';
  }
  const withoutInvisible = input.replace(ZERO_WIDTH_AND_BOM, '');
  return sanitizeText(withoutInvisible, { maxLen, allowNewlines: true });
}

/**
 * Sanitize "identifier-like" strings (usernames, ids, slugs).
 * Keeps only a conservative charset.
 */
function sanitizeIdentifier(input, { maxLen = 80 } = {}) {
  if (input === undefined || input === null) return '';
  const s = sanitizeText(input, { maxLen: maxLen * 2, allowNewlines: false });
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '');
  return cleaned.slice(0, maxLen);
}

/**
 * Sanitize URL-ish strings: trim + remove control chars + hard cap.
 * Does NOT HTML-escape to avoid breaking URLs; rely on frontend rendering safety.
 */
function sanitizeUrl(input, { maxLen = 2048 } = {}) {
  if (input === undefined || input === null) return null;
  const s = removeControlChars(String(input), { keepNewlines: false }).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/** Signup / public handle: ASCII letters and digits only, lowercase, bounded length. */
const USERNAME_MIN_LEN = 3;
const USERNAME_MAX_LEN = 30;

/**
 * @returns {{ ok: true, username: string } | { ok: false, error: string }}
 */
function validateUsernameShape(raw) {
  const u = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!u) {
    return { ok: false, error: 'Username is required' };
  }
  if (u.length < USERNAME_MIN_LEN || u.length > USERNAME_MAX_LEN) {
    return {
      ok: false,
      error: `Username must be ${USERNAME_MIN_LEN}-${USERNAME_MAX_LEN} characters`,
    };
  }
  if (!/^[a-z0-9]+$/.test(u)) {
    return {
      ok: false,
      error: 'Username may only contain letters and numbers (no spaces or symbols)',
    };
  }
  return { ok: true, username: u };
}

module.exports = {
  sanitizeText,
  sanitizeFeedbackMessage,
  sanitizeIdentifier,
  sanitizeUrl,
  validateUsernameShape,
  USERNAME_MIN_LEN,
  USERNAME_MAX_LEN,
};

