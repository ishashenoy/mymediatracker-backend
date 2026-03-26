const Event = require('../models/eventModel');
const { VALID_EVENT_TYPES } = require('../models/eventModel');
const { sanitizeIdentifier, sanitizeText } = require('../utils/sanitize');

/**
 * Internal helper — fire-and-forget event recording.
 * Never throws; any failure is caught and silently ignored so callers are unaffected.
 */
async function fireEvent(userId, eventType, canonicalId = null, metadata = {}, sessionId = null) {
    try {
        await Event.create({
            user_id: userId,
            event_type: eventType,
            canonical_id: canonicalId || null,
            metadata: metadata || {},
            session_id: sessionId || null,
        });
    } catch (e) {
        // Silent — event loss is acceptable; it must never crash a business operation
    }
}

/**
 * POST /api/events
 * Client-side event ingestion (search queries, page views, etc.)
 */
const createEvent = async (req, res) => {
    const { event_type, canonical_id, metadata, session_id } = req.body;
    const user_id = req.user._id;

    const safeEventType = sanitizeIdentifier(event_type, { maxLen: 64 });
    const safeSessionId = session_id ? sanitizeIdentifier(session_id, { maxLen: 80 }) : null;

    if (!safeEventType) {
        return res.status(400).json({ error: 'event_type is required.' });
    }

    if (!VALID_EVENT_TYPES.includes(safeEventType)) {
        return res.status(400).json({
            error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}.`,
        });
    }

    try {
        // Metadata can contain arbitrary client-provided values.
        // We sanitize string leaves (defense-in-depth) but preserve structure.
        const sanitizeMetadata = (val) => {
            if (val === null || val === undefined) return val;
            if (typeof val === 'string') return sanitizeText(val, { maxLen: 500, allowNewlines: false });
            if (Array.isArray(val)) return val.map(sanitizeMetadata);
            if (typeof val === 'object') {
                const out = {};
                Object.keys(val).forEach((k) => {
                    out[k] = sanitizeMetadata(val[k]);
                });
                return out;
            }
            return val;
        };

        await Event.create({
            user_id,
            event_type: safeEventType,
            canonical_id: canonical_id || null,
            metadata: sanitizeMetadata(metadata || {}),
            session_id: safeSessionId,
        });
        return res.status(201).json({ message: 'Event recorded.' });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to record event.' });
    }
};

module.exports = { fireEvent, createEvent };
