// scripts/transform-all-to-granular-19.mjs
//
// Batch transforms existing R2 datasets across all cities into the new
// 19 granular urban dataset architecture without deleting existing files.
//
// Usage:
//   bun run scripts/transform-all-to-granular-19.mjs --city amsterdam
//   bun run scripts/transform-all-to-granular-19.mjs --city all --concurrency 8

import fs from 'node:fs';
import path from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};

const cityArg = flag('city', 'amsterdam');
const concurrency = parseInt(flag('concurrency', '8'), 10);
const dryRun = argv.includes('--dry-run');

function readVars(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.replace(/\r$/, '').match(/^([^#=]+)=(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
  } catch {}
  return out;
}

const vars = {
  ...readVars('.env'),
  ...readVars('.dev.vars'),
  ...readVars('../site/.env'),
  ...readVars('../geo/site/.env'),
  ...process.env,
};

const accountId = vars.R2_DATALAKE_ACCOUNT_ID || vars.R2_ACCOUNT_ID || '5d469620e5b9363beae1cb2e4e290aee';
const accessKeyId = vars.R2_DATALAKE_ACCESS_KEY_ID || vars.Access_Key_ID;
const secretAccessKey = vars.R2_DATALAKE_SECRET_ACCESS_KEY || vars.Secret_Access_Key;

if (!accessKeyId || !secretAccessKey) {
  console.warn('[WARN] No R2 credentials found in environment or .env files. Ensure R2_DATALAKE_ACCESS_KEY_ID and R2_DATALAKE_SECRET_ACCESS_KEY are set.');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || '',
  },
});

async function getR2Json(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function putR2(bucket, key, body, isBinary = false) {
  if (dryRun) {
    console.log(`    [DRY RUN] Would put s3://${bucket}/${key} (${isBinary ? body.length + ' bytes' : 'JSON'})`);
    return;
  }
  const contentType = isBinary ? 'application/octet-stream' : 'application/json; charset=utf-8';
  const payload = isBinary ? body : (typeof body === 'string' ? body : JSON.stringify(body));

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: payload,
    ContentType: contentType,
    CacheControl: 'public, max-age=86400, s-maxage=604800'
  }));
}

function getRawPackDir(city) {
  const candidates = [
    path.resolve('data/raw', city),
    path.resolve('todo/city-network', city),
    path.resolve('../geo/site/todo/city-network', city),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 1. For cities that have local raw 19 files (Amsterdam, Berlin):
 * Upload all raw granular files directly to R2!
 */
async function syncLocalRawPack(city) {
  const cityDir = getRawPackDir(city);
  if (!cityDir) return false;

  const files = fs.readdirSync(cityDir).filter(f => f.endsWith('.json') || f.endsWith('.bin'));
  console.log(`[RAW PACK] Syncing ${city} from local directory (${files.length} files)...`);

  for (const f of files) {
    const fp = path.join(cityDir, f);
    const buf = fs.readFileSync(fp);
    const isBin = f.endsWith('.bin');
    // Upload both to datalake archive and globe serving
    await putR2('geo-datalake', `sources/city-network/${city}/${f}`, buf, isBin);
    await putR2('globe', `data/${city}-2d/${f}`, buf, isBin);
  }
  return true;
}

/**
 * 2. For existing cities in R2:
 * Decompose places.json, neighborhoods.json, transit-lines.json, street-geoms.json
 * into granular files WITHOUT removing the existing ones!
 */
async function transformCity(slug) {
  // Check if local raw pack exists first
  if (await syncLocalRawPack(slug)) {
    console.log(`  ✓ ${slug}: uploaded complete raw pack.`);
    return;
  }

  // A. Decompose places.json -> districts.json, pois.json, landmarks.json
  const places = await getR2Json('globe', `data/${slug}-2d/places.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/places.json`);

  if (places && Array.isArray(places.features)) {
    const districts = [];
    const pois = [];
    const landmarks = [];

    for (const f of places.features) {
      const k = f.properties?.kind;
      if (k === 'district') {
        districts.push(f);
      } else if (['shop', 'edu', 'health', 'night', 'air'].includes(k)) {
        pois.push(f);
      } else if (['landmark', 'employment'].includes(k)) {
        landmarks.push(f);
      } else {
        pois.push(f);
      }
    }

    await putR2('globe', `data/${slug}-2d/districts.json`, { type: 'FeatureCollection', features: districts });
    await putR2('globe', `data/${slug}-2d/pois.json`, { type: 'FeatureCollection', features: pois });
    await putR2('globe', `data/${slug}-2d/landmarks.json`, { type: 'FeatureCollection', features: landmarks });

    await putR2('geo-datalake', `sources/city-network/${slug}/districts.json`, { type: 'FeatureCollection', features: districts });
    await putR2('geo-datalake', `sources/city-network/${slug}/pois.json`, { type: 'FeatureCollection', features: pois });
    await putR2('geo-datalake', `sources/city-network/${slug}/landmarks.json`, { type: 'FeatureCollection', features: landmarks });
  }

  // B. Decompose neighborhoods.json -> areas.json
  const neigh = await getR2Json('globe', `data/${slug}-2d/neighborhoods.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/neighborhoods.json`);

  if (neigh) {
    const areasDoc = neigh.features ? neigh : {
      type: 'FeatureCollection',
      features: (neigh.neighbourhoods || []).map((n, idx) => ({
        type: 'Feature',
        id: idx,
        properties: { name: n.name, rank: n.rank, qid: n.qid, population: n.population },
        geometry: { type: 'Point', coordinates: [n.lng, n.lat] }
      }))
    };

    await putR2('globe', `data/${slug}-2d/areas.json`, areasDoc);
    await putR2('geo-datalake', `sources/city-network/${slug}/areas.json`, areasDoc);
  }

  // C. street-geoms.json -> streets.json
  const streetGeoms = await getR2Json('globe', `data/${slug}-2d/street-geoms.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/street-geoms.json`);

  if (streetGeoms) {
    await putR2('globe', `data/${slug}-2d/streets.json`, streetGeoms);
    await putR2('geo-datalake', `sources/city-network/${slug}/streets.json`, streetGeoms);
  }

  // D. transit-lines.json -> baseline.json
  const transitLines = await getR2Json('globe', `data/${slug}-2d/transit-lines.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/transit-lines.json`);

  if (transitLines) {
    await putR2('globe', `data/${slug}-2d/baseline.json`, transitLines);
    await putR2('geo-datalake', `sources/city-network/${slug}/baseline.json`, transitLines);
  }

  console.log(`  ✓ ${slug}: created new granular JSON files in R2.`);
}

function getTargetCities(cityArg) {
  if (cityArg !== 'all') {
    return cityArg.split(',').map(s => s.trim().replace(/-city-atlas$/, ''));
  }
  const candidates = [
    path.resolve('data/atlas-city-centers.json'),
    path.resolve('src/data/atlas-city-centers.json'),
    path.resolve('../geo/site/src/data/atlas-city-centers.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const centers = JSON.parse(fs.readFileSync(c, 'utf8'));
        return Object.keys(centers).map(k => k.replace(/-city-atlas$/, ''));
      } catch {}
    }
  }
  return ['amsterdam', 'berlin'];
}

async function main() {
  console.log(`Starting granular 19-file transformation (concurrency: ${concurrency})...`);

  const targetCities = getTargetCities(cityArg);
  console.log(`Target cities count: ${targetCities.length}`);

  // Process in batches
  for (let i = 0; i < targetCities.length; i += concurrency) {
    const batch = targetCities.slice(i, i + concurrency);
    console.log(`\nProcessing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(targetCities.length / concurrency)}: [${batch.join(', ')}]`);
    await Promise.all(batch.map(c => transformCity(c).catch(err => console.error(`  ✗ ${c} error:`, err.message))));
  }

  console.log('\nAll cities processed successfully into new granular 19-file architecture!');
}

main().catch(console.error);
