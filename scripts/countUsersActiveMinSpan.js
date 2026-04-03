/**
 * One-off / utility: count users whose UserMedia rows span at least N calendar days
 * between first and last `updatedAt` (default 60 ≈ 2 months). Uses only existing
 * UserMedia timestamps.
 *
 * Usage:
 *   node scripts/countUsersActiveMinSpan.js
 *   node scripts/countUsersActiveMinSpan.js --min-days=60
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const UserMedia = require('../models/userMediaModel');

function parseMinDays(argv) {
  const raw = argv.find((a) => a.startsWith('--min-days='));
  if (!raw) return 60;
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

  const result = await UserMedia.aggregate([
    {
      $group: {
        _id: '$user_id',
        firstUpdatedAt: { $min: '$updatedAt' },
        lastUpdatedAt: { $max: '$updatedAt' },
      },
    },
    {
      $match: {
        $expr: {
          $gte: [
            {
              $dateDiff: {
                startDate: '$firstUpdatedAt',
                endDate: '$lastUpdatedAt',
                unit: 'day',
              },
            },
            minDays,
          ],
        },
      },
    },
    { $count: 'n' },
  ]);

  const count = result[0]?.n ?? 0;

  console.log(
    `Users with first/last updatedAt ≥${minDays} day(s) apart: ${count}`
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
