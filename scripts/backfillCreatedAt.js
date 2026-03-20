/**
 * Migration: Backfill createdAt on User documents that are missing it.
 *
 * MongoDB ObjectIds encode a creation timestamp. For users created before
 * Mongoose timestamps were enabled, this script derives createdAt from the _id.
 *
 * Usage:
 *   node scripts/backfillCreatedAt.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const User = require('../models/userModel');

    const usersWithout = await User.find({
        $or: [
            { createdAt: { $exists: false } },
            { createdAt: null },
        ],
    }).select('_id createdAt');

    console.log(`Found ${usersWithout.length} users missing createdAt`);

    let updated = 0;
    for (const user of usersWithout) {
        const ts = user._id.getTimestamp();
        await User.updateOne({ _id: user._id }, { $set: { createdAt: ts } });
        updated++;
    }

    console.log(`✓ Backfilled createdAt on ${updated} users`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
