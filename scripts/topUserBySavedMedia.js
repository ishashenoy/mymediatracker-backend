/**
 * One-off / utility: find user(s) with the highest number of saved media (UserMedia rows).
 *
 * By default, only users whose first and last UserMedia `updatedAt` are at least `--min-days`
 * apart count ("most saved over a long time", excludes same-week bulk imports). Use
 * `--min-days=0` for plain highest total. Use `--min-days=365` for a full-year minimum span.
 * Only **public** users (`private` ≠ true) are considered.
 *
 * Usage:
 *   node scripts/topUserBySavedMedia.js
 *   node scripts/topUserBySavedMedia.js --min-days=365
 *   node scripts/topUserBySavedMedia.js --min-days=0
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/userModel');
const UserMedia = require('../models/userMediaModel');

function parseMinDays(argv) {
  const raw = argv.find((a) => a.startsWith('--min-days='));
  if (!raw) return 90;
  const n = parseInt(raw.split('=')[1], 10);
  if (Number.isNaN(n) || n < 0) {
    console.error('Invalid --min-days=N (N must be a non-negative integer)');
    process.exit(1);
  }
  return n;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  const minDays = parseMinDays(process.argv.slice(2));

  await mongoose.connect(process.env.MONGO_URI);

  const pipeline = [
    {
      $group: {
        _id: '$user_id',
        savedCount: { $sum: 1 },
        firstSavedAt: { $min: '$createdAt' },
        lastSavedAt: { $max: '$createdAt' },
      },
    },
    {
      $set: {
        spanDays: {
          $dateDiff: {
            startDate: '$firstUpdatedAt',
            endDate: '$lastUpdatedAt',
            unit: 'day',
          },
        },
      },
    },
  ];

  if (minDays > 0) {
    pipeline.push({ $match: { spanDays: { $gte: minDays } } });
  }

  pipeline.push(
    {
      $lookup: {
        from: User.collection.name,
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
          { $project: { private: 1 } },
        ],
        as: 'userDoc',
      },
    },
    { $unwind: { path: '$userDoc' } },
    { $match: { 'userDoc.private': { $ne: true } } },
    { $project: { userDoc: 0 } },
    { $sort: { savedCount: -1 } }
  );

  const ranked = await UserMedia.aggregate(pipeline);

  if (ranked.length === 0) {
    if (minDays > 0) {
      console.log(
        `No public users with rows spanning at least ${minDays} days (first → last UserMedia updatedAt). Try a smaller --min-days or --min-days=0.`
      );
    } else {
      console.log(
        'No qualifying public users (or no UserMedia rows for public accounts).'
      );
    }
    await mongoose.disconnect();
    return;
  }

  const maxCount = ranked[0].savedCount;
  const topRows = ranked.filter((r) => r.savedCount === maxCount);
  const topIds = topRows.map((r) => r._id);

  const users = await User.find({ _id: { $in: topIds } })
    .select('username email _id')
    .lean();

  const byId = new Map(users.map((u) => [String(u._id), u]));

  const filterNote =
    minDays > 0
      ? ` (public users, ≥${minDays} day span between first and last save)`
      : ' (public users only)';

  console.log(
    `Highest saved media count: ${maxCount}${filterNote} (${topRows.length} user(s) tied)\n`
  );
  for (const row of topRows) {
    const u = byId.get(String(row._id));
    const label = u
      ? `${u.username} <${u.email}> (${u._id})`
      : `(user not found) ${row._id}`;
    const span =
      row.firstUpdatedAt && row.lastUpdatedAt
        ? `  span: ${row.spanDays} days (${row.firstUpdatedAt.toISOString().slice(0, 10)} → ${row.lastUpdatedAt.toISOString().slice(0, 10)})`
        : '';
    console.log(`  ${label}${span ? `\n${span}` : ''}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
