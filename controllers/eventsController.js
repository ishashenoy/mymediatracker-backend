const Event = require('../models/eventModel');
const { VALID_EVENT_TYPES } = require('../models/eventModel');

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

    if (!event_type) {
        return res.status(400).json({ error: 'event_type is required.' });
    }

    if (!VALID_EVENT_TYPES.includes(event_type)) {
        return res.status(400).json({
            error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}.`,
        });
    }

    try {
        await Event.create({
            user_id,
            event_type,
            canonical_id: canonical_id || null,
            metadata: metadata || {},
            session_id: session_id || null,
        });
        return res.status(201).json({ message: 'Event recorded.' });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to record event.' });
    }
};

module.exports = { fireEvent, createEvent };
