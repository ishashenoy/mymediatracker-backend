/**
 * Migration: Deduplicate uniquemedias → canonical_media + media_sources.
 *
 * For each UniqueMedia document:
 *   1. Find or create a CanonicalMedia with matching (type, normalized_name).
 *   2. Create a MediaSource record linking the UniqueMedia's source+media_id
 *      to the canonical entry.
 *   3. Backfill canonical_id on all UserMedia documents that reference this UniqueMedia.
 *
 * When multiple UniqueMedia docs share the same (type, normalized_name) — i.e. duplicates —
 * they all point to the SAME CanonicalMedia. The old UniqueMedia _id is stored in
 * merge_history for rollback safety. The original unique_media_ref on UserMedia is
 * NEVER modified; only canonical_id is set.
 *
 * Usage:
 *   node scripts/migrateUniquemedia.js            # live run
 *   node scripts/migrateUniquemedia.js --dry-run  # preview only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

function normalizeName(name = '') {
    return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected to MongoDB${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

    const UniqueMedia = require('../models/uniqueMediaModel');
    const CanonicalMedia = require('../models/canonicalMediaModel');
    const MediaSource = require('../models/mediaSourceModel');
    const UserMedia = require('../models/userMediaModel');

    const total = await UniqueMedia.countDocuments();
    console.log(`Total UniqueMedia documents: ${total}`);

    let processed = 0;
    let canonicalCreated = 0;
    let canonicalReused = 0;
    let sourceCreated = 0;
    let userMediaBackfilled = 0;
    let errors = 0;

    // Process in batches using skip/limit
    let skip = 0;
    while (skip < total) {
        const batch = await UniqueMedia.find().skip(skip).limit(BATCH_SIZE).lean();
        skip += BATCH_SIZE;

        for (const doc of batch) {
            try {
                const cleanType = String(doc.type || '').trim();
                const cleanName = String(doc.name || '').trim();
                const cleanNorm = normalizeName(cleanName);
                const cleanImage = String(doc.image_url || '').trim();
                const cleanSource = String(doc.source || '').trim();
                const cleanMediaId = String(doc.media_id || '').trim();

                if (!cleanType || !cleanName) {
                    processed++;
                    continue;
                }

                // Find existing canonical entry for this (type, normalized_name)
                let canonical = await CanonicalMedia.findOne({
                    type: cleanType,
                    normalized_name: cleanNorm,
                });

                if (canonical) {
                    canonicalReused++;
                    // Record this UniqueMedia _id in merge_history if not already there
                    if (!DRY_RUN) {
                        const alreadyInHistory = canonical.merge_history.some(
                            id => id.toString() === doc._id.toString()
                        );
                        if (!alreadyInHistory) {
                            await CanonicalMedia.updateOne(
                                { _id: canonical._id },
                                { $addToSet: { merge_history: doc._id } }
                            );
                        }
                    } else {
                        console.log(`  [dry-run] Would reuse canonical for "${cleanName}" (${cleanType})`);
                    }
                } else {
                    // Create new canonical entry
                    if (!DRY_RUN) {
                        canonical = await CanonicalMedia.create({
                            type: cleanType,
                            name: cleanName,
                            normalized_name: cleanNorm,
                            primary_image_url: cleanImage,
                            is_user_submitted: !cleanSource || cleanSource === 'internal',
                            merge_history: [doc._id],
                        });
                    } else {
                        console.log(`  [dry-run] Would create canonical: "${cleanName}" (${cleanType})`);
                        canonical = { _id: new mongoose.Types.ObjectId() }; // fake for dry-run stats
                    }
                    canonicalCreated++;
                }

                // Upsert MediaSource if we have external identifiers
                if (cleanSource && cleanMediaId) {
                    if (!DRY_RUN) {
                        await MediaSource.findOneAndUpdate(
                            { source: cleanSource, source_media_id: cleanMediaId },
                            {
                                canonical_id: canonical._id,
                                metadata_snapshot: {
                                    name: cleanName,
                                    image_url: cleanImage,
                                    score: doc.score,
                                },
                                last_fetched_at: doc.updatedAt || doc.createdAt || new Date(),
                            },
                            { upsert: true, new: true }
                        );
                    }
                    sourceCreated++;
                }

                // Backfill canonical_id on UserMedia documents
                if (!DRY_RUN) {
                    const result = await UserMedia.updateMany(
                        { unique_media_ref: doc._id, canonical_id: null },
                        { $set: { canonical_id: canonical._id } }
                    );
                    userMediaBackfilled += result.modifiedCount || 0;
                }

                processed++;
            } catch (e) {
                console.error(`  Error processing UniqueMedia ${doc._id}:`, e.message);
                errors++;
                processed++;
            }
        }

        const pct = Math.round((processed / total) * 100);
        console.log(`Progress: ${processed}/${total} (${pct}%) | canonical created: ${canonicalCreated} | reused: ${canonicalReused} | errors: ${errors}`);
    }

    console.log('\n✓ Migration complete');
    console.log(`  UniqueMedia processed:   ${processed}`);
    console.log(`  CanonicalMedia created:  ${canonicalCreated}`);
    console.log(`  CanonicalMedia reused:   ${canonicalReused}`);
    console.log(`  MediaSource records:     ${sourceCreated}`);
    console.log(`  UserMedia backfilled:    ${userMediaBackfilled}`);
    console.log(`  Errors:                  ${errors}`);

    if (DRY_RUN) {
        console.log('\n[DRY RUN] No changes were written to the database.');
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
