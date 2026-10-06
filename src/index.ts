export interface Env {
  GLOBE: R2Bucket;
  DATALAKE: R2Bucket;
}

const GRANULAR_19_FILES = [
  'areas.json',
  'baseline.json',
  'buildings.bin',
  'buildings.json',
  'demand-streets.json',
  'demand.json',
  'districts.json',
  'extent.json',
  'landmarks.json',
  'model.json',
  'pack.json',
  'pois.json',
  'purposes.bin.json',
  'streets.bin',
  'streets.json',
  'tram-streets.bin',
  'tram-streets.json',
  'water-rings.json',
  'water.json'
];

async function getR2Json(bucket: R2Bucket, key: string): Promise<any | null> {
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return await obj.json();
  } catch {
    return null;
  }
}

async function putR2Json(bucket: R2Bucket, key: string, data: any): Promise<number> {
  const str = JSON.stringify(data);
  await bucket.put(key, str, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=86400, s-maxage=604800'
    }
  });
  return str.length;
}

async function putR2Bin(bucket: R2Bucket, key: string, buffer: ArrayBuffer): Promise<number> {
  await bucket.put(key, buffer, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=86400, s-maxage=604800'
    }
  });
  return buffer.byteLength;
}

/**
 * Packs vertex coordinates into PlayTokyo TKST binary buffer
 */
function packTkstBuffer(verts: [number, number][], edges: any[], names: string[], minLon: number, minLat: number): ArrayBuffer {
  const headerSize = 32;
  const vertBytes = verts.length * 8; // 2 * Int32 (8 bytes) per vertex
  const buffer = new ArrayBuffer(headerSize + vertBytes);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Magic 'TKST'
  u8[0] = 84; u8[1] = 75; u8[2] = 83; u8[3] = 84;
  view.setUint32(4, 1, true); // Version 1
  view.setUint32(8, verts.length, true);
  view.setUint32(12, edges.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, names.length, true);
  view.setInt32(24, Math.round(minLon * 1e6), true);
  view.setInt32(28, Math.round(minLat * 1e6), true);

  let offset = headerSize;
  for (let i = 0; i < verts.length; i++) {
    view.setInt32(offset, Math.round(verts[i][0] * 1e6), true);
    view.setInt32(offset + 4, Math.round(verts[i][1] * 1e6), true);
    offset += 8;
  }
  return buffer;
}

/**
 * Transforms an existing city in R2 into the 19 granular JSON & binary layers.
 * Reads directly from env.GLOBE (and env.DATALAKE) with zero external network overhead!
 */
export async function transformCityInR2(slug: string, env: Env) {
  const manifest: { city: string; version: number; files: Record<string, number>; written: string } = {
    city: slug,
    version: 1,
    files: {},
    written: new Date().toISOString()
  };

  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  const updateBBox = (lon?: number, lat?: number) => {
    if (typeof lon !== 'number' || typeof lat !== 'number') return;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  // 1. Places & Neighborhoods Decomposition
  const places = await getR2Json(env.GLOBE, `data/${slug}-2d/places.json`)
    || await getR2Json(env.DATALAKE, `sources/osm/places/${slug}/places.json`);

  const neigh = await getR2Json(env.GLOBE, `data/${slug}-2d/neighborhoods.json`)
    || await getR2Json(env.DATALAKE, `sources/osm/places/${slug}/neighborhoods.json`);

  const districtsFeatures: any[] = [];
  const poisFeatures: any[] = [];
  const landmarksFeatures: any[] = [];
  const areasFeatures: any[] = [];

  // Partition places.json
  if (places && Array.isArray(places.features)) {
    for (const f of places.features) {
      const k = f.properties?.kind || '';
      const coords = f.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) updateBBox(coords[0], coords[1]);

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
    const rawFeats = neigh.features || (neigh.neighbourhoods || []).map((n: any, idx: number) => ({
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

      if (k === 'municipality' || k === 'district' || (r <= 3 && !districtsFeatures.some(d => d.properties?.name === p.name))) {
        districtsFeatures.push(f);
      } else {
        areasFeatures.push(f);
      }
    }
  }

  if (districtsFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: districtsFeatures };
    manifest.files['districts.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/districts.json`, doc);
  }
  if (poisFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: poisFeatures };
    manifest.files['pois.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/pois.json`, doc);
  }
  if (landmarksFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: landmarksFeatures };
    manifest.files['landmarks.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/landmarks.json`, doc);
  }
  if (areasFeatures.length > 0) {
    const doc = { type: 'FeatureCollection', features: areasFeatures };
    manifest.files['areas.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/areas.json`, doc);
  }

  // 2. Street Network Decomposition: streets.json + streets.bin
  const streetGeoms = await getR2Json(env.GLOBE, `data/${slug}-2d/street-geoms.json`)
    || await getR2Json(env.DATALAKE, `sources/osm/places/${slug}/street-geoms.json`);

  if (streetGeoms && streetGeoms.geoms) {
    const verts: [number, number][] = [];
    const edges: any[] = [];
    const names: string[] = [];

    for (const [stName, stObj] of Object.entries(streetGeoms.geoms as Record<string, any>)) {
      const nameIdx = names.length;
      names.push(stObj.n || stName);

      if (Array.isArray(stObj.lines)) {
        for (const line of stObj.lines) {
          if (!Array.isArray(line) || line.length < 2) continue;
          const lineVertIndices: number[] = [];
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
    manifest.files['streets.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/streets.json`, streetsDoc);

    const streetsBin = packTkstBuffer(verts, edges, names, minLon < 180 ? minLon : 0, minLat < 90 ? minLat : 0);
    manifest.files['streets.bin'] = await putR2Bin(env.GLOBE, `data/${slug}-2d/streets.bin`, streetsBin);
  }

  // 3. Transit Decomposition: baseline.json vs tram-streets.json & tram-streets.bin
  const transitLines = await getR2Json(env.GLOBE, `data/${slug}-2d/transit-lines.json`)
    || await getR2Json(env.DATALAKE, `sources/osm/places/${slug}/transit-lines.json`);

  if (transitLines) {
    const rawLines = transitLines.lines?.features || transitLines.features || transitLines.lines || [];
    const baselineFeatures: any[] = [];
    const tramVerts: [number, number][] = [];
    const tramEdges: any[] = [];
    const tramNames: string[] = [];

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
          const lineVerts: number[] = [];
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
      const baselineDoc = { city: slug, generated: 'transit-decomposition', lines: baselineFeatures };
      manifest.files['baseline.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/baseline.json`, baselineDoc);
    }

    if (tramVerts.length > 0) {
      const tramDoc = { verts: tramVerts, edges: tramEdges, names: tramNames };
      manifest.files['tram-streets.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/tram-streets.json`, tramDoc);

      const tramBin = packTkstBuffer(tramVerts, tramEdges, tramNames, minLon < 180 ? minLon : 0, minLat < 90 ? minLat : 0);
      manifest.files['tram-streets.bin'] = await putR2Bin(env.GLOBE, `data/${slug}-2d/tram-streets.bin`, tramBin);
    }
  }

  // 4. Extent and Pack Manifest
  if (minLon < maxLon && minLat < maxLat) {
    const extentDoc = {
      type: 'Feature',
      properties: { city: slug },
      geometry: {
        type: 'Polygon',
        coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]
      }
    };
    manifest.files['extent.json'] = await putR2Json(env.GLOBE, `data/${slug}-2d/extent.json`, extentDoc);
  }

  if (Object.keys(manifest.files).length > 0) {
    await putR2Json(env.GLOBE, `data/${slug}-2d/pack.json`, manifest);
  }

  return manifest;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health / Root info
    if (path === '/' || path === '/health') {
      return Response.json({
        service: 'city-network',
        description: 'Cloudflare Worker for 19 Granular Urban Dataset Transformation directly against globe R2',
        endpoints: [
          'GET /cities - Lists all cities discovered in globe/data/',
          'GET /status?city=<slug> - Checks presence of the 19 granular files for a city',
          'POST /sync?city=<slug> - Decomposes and transforms a single city or comma-separated cities',
          'POST /sync-all?limit=20&cursor=... - Decomposes a batch of cities directly on Cloudflare',
          'GET /data/:slug/:file - Serves granular JSON or BIN file directly from R2'
        ]
      }, { headers: corsHeaders });
    }

    // List all cities found in globe/data/
    if (path === '/cities') {
      const cursor = url.searchParams.get('cursor') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '500', 10);
      const list = await env.GLOBE.list({ prefix: 'data/', delimiter: '/', cursor, limit });
      const cities: string[] = [];
      for (const p of list.delimitedPrefixes) {
        const m = p.match(/^data\/([a-z0-9_-]+)-2d\/$/);
        if (m) cities.push(m[1]);
      }
      return Response.json({
        count: cities.length,
        cities,
        truncated: list.truncated,
        cursor: list.cursor
      }, { headers: corsHeaders });
    }

    // Check status of 19 files for a city
    if (path === '/status') {
      const city = url.searchParams.get('city');
      if (!city) return Response.json({ error: 'Missing city parameter' }, { status: 400, headers: corsHeaders });

      const files: Record<string, boolean> = {};
      await Promise.all(GRANULAR_19_FILES.map(async (f) => {
        const head = await env.GLOBE.head(`data/${city}-2d/${f}`);
        files[f] = !!head;
      }));

      const presentCount = Object.values(files).filter(Boolean).length;
      return Response.json({
        city,
        presentCount,
        totalFiles: GRANULAR_19_FILES.length,
        files
      }, { headers: corsHeaders });
    }

    // Transform single city or specific list of cities
    if (path === '/sync' && request.method === 'POST') {
      const city = url.searchParams.get('city') || (await request.json().catch(() => ({})) as any).city;
      if (!city) return Response.json({ error: 'Missing city parameter' }, { status: 400, headers: corsHeaders });

      const cities = city.split(',').map((s: string) => s.trim().replace(/-city-atlas$/, ''));
      const results: Record<string, any> = {};

      for (const c of cities) {
        try {
          results[c] = await transformCityInR2(c, env);
        } catch (err: any) {
          results[c] = { error: err.message };
        }
      }

      return Response.json({ success: true, count: cities.length, results }, { headers: corsHeaders });
    }

    // Batch transform across globe/data/
    if (path === '/sync-all' && request.method === 'POST') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 30);
      const cursor = url.searchParams.get('cursor') || undefined;

      const list = await env.GLOBE.list({ prefix: 'data/', delimiter: '/', cursor, limit });
      const batchCities: string[] = [];
      for (const p of list.delimitedPrefixes) {
        const m = p.match(/^data\/([a-z0-9_-]+)-2d\/$/);
        if (m) batchCities.push(m[1]);
      }

      const results: Record<string, any> = {};
      for (const c of batchCities) {
        try {
          results[c] = await transformCityInR2(c, env);
        } catch (err: any) {
          results[c] = { error: err.message };
        }
      }

      return Response.json({
        processedCount: batchCities.length,
        cities: batchCities,
        truncated: list.truncated,
        cursor: list.cursor,
        results
      }, { headers: corsHeaders });
    }

    // Serve /data/:slug/:file directly from R2
    const dataMatch = path.match(/^\/data\/([a-z0-9_-]+)\/([a-z0-9_.-]+)$/);
    if (dataMatch) {
      const [, folder, file] = dataMatch;
      const key = `data/${folder}/${file}`;
      const obj = await env.GLOBE.get(key);
      if (!obj) return new Response('Not Found', { status: 404, headers: corsHeaders });

      const isBin = file.endsWith('.bin');
      const contentType = isBin ? 'application/octet-stream' : 'application/json; charset=utf-8';
      return new Response(obj.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, s-maxage=604800'
        }
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
