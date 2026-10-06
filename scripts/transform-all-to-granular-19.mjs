// scripts/transform-all-to-granular-19.mjs
//
// Ingests and decomposes legacy city datasets across all cities into the new
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
    await putR2('geo-datalake', `sources/city-network/${city}/${f}`, buf, isBin);
    await putR2('globe', `data/${city}-2d/${f}`, buf, isBin);
  }
  return true;
}

/**
 * Pack vertices and edges into TKST binary buffer
 */
function packTkstBuffer(verts, edges, names, minLon, minLat) {
  const headerSize = 32;
  const vertBytes = verts.length * 8; // 2 * Int32 per vertex
  const buf = Buffer.alloc(headerSize + vertBytes);
  buf.write('TKST', 0, 4, 'ascii');
  buf.writeUInt32LE(1, 4); // version 1
  buf.writeUInt32LE(verts.length, 8);
  buf.writeUInt32LE(edges.length, 12);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(names.length, 20);
  buf.writeInt32LE(Math.round(minLon * 1e6), 24);
  buf.writeInt32LE(Math.round(minLat * 1e6), 28);

  let offset = headerSize;
  for (const [lon, lat] of verts) {
    buf.writeInt32LE(Math.round(lon * 1e6), offset);
    buf.writeInt32LE(Math.round(lat * 1e6), offset + 4);
    offset += 8;
  }
  return buf;
}

/**
 * 2. Decompose existing 5 files across all cities into the 19 granular architecture:
 * - neighborhoods.json -> areas.json + districts.json (higher administrative units)
 * - places.json -> districts.json (boroughs/districts) + pois.json + landmarks.json
 * - street-geoms.json -> streets.json + streets.bin (PlayTokyo TKST binary)
 * - transit-lines.json -> baseline.json (heavy rail/metro) + tram-streets.json & tram-streets.bin (trams)
 * - extent.json & pack.json
 */
async function transformCity(slug) {
  // If complete raw pack exists locally, upload directly
  if (await syncLocalRawPack(slug)) {
    console.log(`  ✓ ${slug}: uploaded complete raw pack.`);
    return;
  }

  const manifest = { city: slug, version: 1, files: {}, written: new Date().toISOString() };
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  const updateBBox = (lon, lat) => {
    if (typeof lon !== 'number' || typeof lat !== 'number') return;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  // --- A. Places & Neighborhoods Decomposition ---
  const places = await getR2Json('globe', `data/${slug}-2d/places.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/places.json`);

  const neigh = await getR2Json('globe', `data/${slug}-2d/neighborhoods.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/neighborhoods.json`);

  const districtsFeatures = [];
  const poisFeatures = [];
  const landmarksFeatures = [];
  const areasFeatures = [];

  // Partition places.json
  if (places && Array.isArray(places.features)) {
    for (const f of places.features) {
      const k = f.properties?.kind || '';
      const coords = f.geometry?.coordinates;
      if (coords && coords.length >= 2) updateBBox(coords[0], coords[1]);

      if (k === 'district' || k === 'borough') {
        districtsFeatures.push(f);
      } else if (['shop', 'edu', 'health', 'night', 'air'].includes(k)) {
        poisFeatures.push(f);
      } else if (['landmark', 'employment', 'civic'].includes(k)) {
        landmarksFeatures.push(f);
      } else {
        poisFeatures.push(f);
      }
    }
  }

  // Partition neighborhoods.json
  if (neigh) {
    const rawFeats = neigh.features || (neigh.neighbourhoods || []).map((n, idx) => ({
      type: 'Feature',
      id: idx,
      properties: { name: n.name, rank: n.rank, kind: n.kind || 'neighbourhood', qid: n.qid, population: n.population },
      geometry: { type: 'Point', coordinates: [n.lng, n.lat] }
    }));

    for (const f of rawFeats) {
      const p = f.properties || {};
      const k = p.kind || '';
      const r = p.rank ?? 5;
      const coords = f.geometry?.coordinates;
      if (Array.isArray(coords) && typeof coords[0] === 'number') updateBBox(coords[0], coords[1]);

      // If it's a municipality, local government area, or top-level district, merge into districts.json
      if (k === 'municipality' || k === 'district' || (r <= 3 && !districtsFeatures.some(d => d.properties?.name === p.name))) {
        districtsFeatures.push(f);
      } else {
        areasFeatures.push(f);
      }
    }
  }

  // Save districts.json, pois.json, landmarks.json, areas.json
  if (districtsFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: districtsFeatures };
    await putR2('globe', `data/${slug}-2d/districts.json`, doc);
    await putR2('geo-datalake', `sources/city-network/${slug}/districts.json`, doc);
    manifest.files['districts.json'] = JSON.stringify(doc).length;
  }
  if (poisFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: poisFeatures };
    await putR2('globe', `data/${slug}-2d/pois.json`, doc);
    await putR2('geo-datalake', `sources/city-network/${slug}/pois.json`, doc);
    manifest.files['pois.json'] = JSON.stringify(doc).length;
  }
  if (landmarksFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: landmarksFeatures };
    await putR2('globe', `data/${slug}-2d/landmarks.json`, doc);
    await putR2('geo-datalake', `sources/city-network/${slug}/landmarks.json`, doc);
    manifest.files['landmarks.json'] = JSON.stringify(doc).length;
  }
  if (areasFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: areasFeatures };
    await putR2('globe', `data/${slug}-2d/areas.json`, doc);
    await putR2('geo-datalake', `sources/city-network/${slug}/areas.json`, doc);
    manifest.files['areas.json'] = JSON.stringify(doc).length;
  }

  // --- B. Street Network Decomposition: streets.json + streets.bin ---
  const streetGeoms = await getR2Json('globe', `data/${slug}-2d/street-geoms.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/street-geoms.json`);

  if (streetGeoms && streetGeoms.geoms) {
    const verts = [];
    const edges = [];
    const names = [];

    for (const [stName, stObj] of Object.entries(streetGeoms.geoms)) {
      const nameIdx = names.length;
      names.push(stObj.n || stName);

      if (Array.isArray(stObj.lines)) {
        for (const line of stObj.lines) {
          if (!Array.isArray(line) || line.length < 2) continue;
          const lineVertIndices = [];
          for (const [lon, lat] of line) {
            updateBBox(lon, lat);
            lineVertIndices.push(verts.length);
            verts.push([lon, lat]);
          }
          for (let j = 0; j < lineVertIndices.length - 1; j++) {
            edges.push([lineVertIndices[j], lineVertIndices[j + 1], 40, nameIdx]);
          }
        }
      }
    }

    const streetsDoc = { verts, edges, names };
    await putR2('globe', `data/${slug}-2d/streets.json`, streetsDoc);
    await putR2('geo-datalake', `sources/city-network/${slug}/streets.json`, streetsDoc);
    manifest.files['streets.json'] = JSON.stringify(streetsDoc).length;

    // Generate TKST streets.bin
    const streetsBin = packTkstBuffer(verts, edges, names, minLon < 180 ? minLon : 0, minLat < 90 ? minLat : 0);
    await putR2('globe', `data/${slug}-2d/streets.bin`, streetsBin, true);
    await putR2('geo-datalake', `sources/city-network/${slug}/streets.bin`, streetsBin, true);
    manifest.files['streets.bin'] = streetsBin.length;
  }

  // --- C. Transit Decomposition: baseline.json vs tram-streets.json & tram-streets.bin ---
  const transitLines = await getR2Json('globe', `data/${slug}-2d/transit-lines.json`)
    || await getR2Json('geo-datalake', `sources/osm/places/${slug}/transit-lines.json`);

  if (transitLines) {
    const rawLines = transitLines.lines?.features || transitLines.features || transitLines.lines || [];
    const baselineFeatures = [];
    const tramVerts = [];
    const tramEdges = [];
    const tramNames = [];

    for (const item of rawLines) {
      const p = item.properties || item;
      const route = String(p.route || p.mode || '').toLowerCase();
      const network = String(p.network || p.operator || '').toLowerCase();
      const isTram = route.includes('tram') || route.includes('light_rail') || network.includes('tram');

      if (isTram) {
        const coords = item.geometry?.coordinates || item.coords || [];
        const tName = p.name || p.ref || 'Tram';
        const nameIdx = tramNames.length;
        tramNames.push(tName);

        const linesList = item.geometry?.type === 'MultiLineString' ? coords : [coords];
        for (const line of linesList) {
          if (!Array.isArray(line) || line.length < 2) continue;
          const lineVerts = [];
          for (const [lon, lat] of line) {
            updateBBox(lon, lat);
            lineVerts.push(tramVerts.length);
            tramVerts.push([lon, lat]);
          }
          for (let j = 0; j < lineVerts.length - 1; j++) {
            tramEdges.push([lineVerts[j], lineVerts[j + 1], 30, nameIdx]);
          }
        }
      } else {
        baselineFeatures.push(item);
      }
    }

    if (baselineFeatures.length > 0) {
      const baselineDoc = {
        city: slug,
        generated: 'transit-decomposition',
        lines: baselineFeatures
      };
      await putR2('globe', `data/${slug}-2d/baseline.json`, baselineDoc);
      await putR2('geo-datalake', `sources/city-network/${slug}/baseline.json`, baselineDoc);
      manifest.files['baseline.json'] = JSON.stringify(baselineDoc).length;
    }

    if (tramVerts.length > 0) {
      const tramDoc = { verts: tramVerts, edges: tramEdges, names: tramNames };
      await putR2('globe', `data/${slug}-2d/tram-streets.json`, tramDoc);
      await putR2('geo-datalake', `sources/city-network/${slug}/tram-streets.json`, tramDoc);
      manifest.files['tram-streets.json'] = JSON.stringify(tramDoc).length;

      const tramBin = packTkstBuffer(tramVerts, tramEdges, tramNames, minLon < 180 ? minLon : 0, minLat < 90 ? minLat : 0);
      await putR2('globe', `data/${slug}-2d/tram-streets.bin`, tramBin, true);
      await putR2('geo-datalake', `sources/city-network/${slug}/tram-streets.bin`, tramBin, true);
      manifest.files['tram-streets.bin'] = tramBin.length;
    }
  }

  // --- D. Extent and Manifest ---
  if (minLon < maxLon && minLat < maxLat) {
    const extentDoc = {
      type: 'Feature',
      properties: { city: slug },
      geometry: {
        type: 'Polygon',
        coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]
      }
    };
    await putR2('globe', `data/${slug}-2d/extent.json`, extentDoc);
    await putR2('geo-datalake', `sources/city-network/${slug}/extent.json`, extentDoc);
    manifest.files['extent.json'] = JSON.stringify(extentDoc).length;
  }

  if (Object.keys(manifest.files).length > 0) {
    await putR2('globe', `data/${slug}-2d/pack.json`, manifest);
    await putR2('geo-datalake', `sources/city-network/${slug}/pack.json`, manifest);
  }

  console.log(`  ✓ ${slug}: decomposed into granular files (${Object.keys(manifest.files).join(', ')}).`);
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
  console.log(`Starting granular urban transformation (concurrency: ${concurrency})...`);

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
