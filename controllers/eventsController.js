const Event = require('../models/eventModel');
const { VALID_EVENT_TYPES } = require('../models/eventModel');
const { sanitizeIdentifier, sanitizeText } = require('../utils/sanitize');

/**
 * Internal helper — fire-and-forget event recording.
 * Never throws; any failure is caught and silently ignored so callers are unaffected.
 */
async function fireEvent(userId, eventType, uniqueMediaId = null, metadata = {}, sessionId = null) {
    try {
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

        const safeEventType = sanitizeIdentifier(eventType, { maxLen: 64 });
        if (!safeEventType) return;

        await Event.create({
            user_id: userId,
            event_type: safeEventType,
            unique_media_id: uniqueMediaId || null,
            metadata: sanitizeMetadata(metadata || {}),
            session_id: sessionId ? sanitizeIdentifier(sessionId, { maxLen: 80 }) : null,
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
    const { event_type, unique_media_id, metadata, session_id } = req.body;
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
            unique_media_id: unique_media_id || null,
            metadata: sanitizeMetadata(metadata || {}),
            session_id: safeSessionId,
        });
        return res.status(201).json({ message: 'Event recorded.' });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to record event.' });
    }
};

module.exports = { fireEvent, createEvent };
