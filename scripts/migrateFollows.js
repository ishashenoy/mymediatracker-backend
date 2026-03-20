/**
 * Migration: Copy existing following/followers arrays into the `follows` collection.
 *
 * This is idempotent — the unique index on (follower_id, followee_id) ensures
 * running this script twice will silently skip duplicates.
 *
 * The dual-write in userController.js handles NEW follows going forward.
 * This script only backfills historical data.
 *
 * Usage:
 *   node scripts/migrateFollows.js
 *   node scripts/migrateFollows.js --dry-run
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected to MongoDB${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

    const User = require('../models/userModel');
    const Follow = require('../models/followModel');

    const users = await User.find(
        { following: { $exists: true, $not: { $size: 0 } } },
        { _id: 1, username: 1, following: 1 }
    );

    console.log(`Processing ${users.length} users with non-empty following lists`);

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
        for (const followeeUsername of (user.following || [])) {
            const followee = await User.findOne({ username: followeeUsername }, { _id: 1 });
            if (!followee) {
                skipped++;
                continue;
            }

            if (DRY_RUN) {
                console.log(`  [dry-run] Would create follow: ${user.username} → ${followeeUsername}`);
                created++;
                continue;
            }

            try {
                await Follow.create({
                    follower_id: user._id,
                    followee_id: followee._id,
                    // Best approximation — exact follow date not available in legacy data
                    created_at: user._id.getTimestamp(),
                });
                created++;
            } catch (e) {
                if (e.code === 11000) {
                    skipped++; // Already exists — idempotent
                } else {
                    console.error(`  Error for ${user.username} → ${followeeUsername}:`, e.message);
                    errors++;
                }
            }
        }
    }

    console.log(`\n✓ Done`);
    console.log(`  Created: ${created}`);
    console.log(`  Skipped (duplicate or user not found): ${skipped}`);
    console.log(`  Errors: ${errors}`);

    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
