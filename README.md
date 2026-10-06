# city-network

> **19 Granular Urban Dataset Transformation Pipeline on Cloudflare Workers & R2**
> High-performance Cloudflare Worker executing directly inside Cloudflare's network against `globe/data/` R2 storage across all 1,248 global cities.

---

## ⚡ Architecture: Edge Execution on Cloudflare R2

Instead of running heavy transformations locally over consumer internet or consuming GitHub Actions runners:
1. A dedicated Cloudflare Worker (`city-network`) runs natively in V8 at Cloudflare's edge.
2. It has direct zero-latency R2 bucket bindings to `env.GLOBE` (`globe`) and `env.DATALAKE` (`geo-datalake`).
3. It discovers all `<slug>-2d/` city folders directly in `globe/data/`, reads the legacy layers, decomposes them in-memory, and writes the 19 granular JSON and binary (`.bin`) layers directly into `globe/data/<slug>-2d/`.

---

## 🌐 Worker Endpoints

**Live Worker:** `https://city-network.foodstarmelbourne.workers.dev`

| Endpoint | Method | Description |
|---|---|---|
| `GET /` | `GET` | Service overview, status, and route catalog |
| `GET /cities` | `GET` | Lists all cities discovered in `globe/data/` (supports `limit`, `cursor`) |
| `GET /status?city=<slug>` | `GET` | Checks presence of all 19 granular files for a city |
| `POST /sync?city=<slug>` | `POST` | Decomposes and generates granular files for one or more cities |
| `POST /sync-all?limit=15&cursor=...` | `POST` | Processes a batch of cities in `globe/data/` and returns next cursor |
| `GET /data/:slug/:file` | `GET` | Directly serves the granular `.json` or `.bin` layer from R2 |

---

## 🌆 19-File Granular Architecture

| File | Type | Source / Decomposition | Purpose |
|---|---|---|---|
| `areas.json` | GeoJSON Polygon/Point | `neighborhoods.json` | Neighborhood boundaries & centroid hierarchy |
| `baseline.json` | GeoJSON MultiLineString | `transit-lines.json` | Core heavy rail and transit corridors |
| `buildings.bin` | Binary FlatGeobuf/PBF | Raw building pack | High-density 3D building extents |
| `buildings.json` | GeoJSON Polygon | Raw building pack | Vector polygon footprints |
| `demand-streets.json` | GeoJSON LineString | Demand model | Street segments weighted by mobility demand |
| `demand.json` | GeoJSON FeatureCollection | Demand model | Centroid origin-destination demand points |
| `districts.json` | GeoJSON FeatureCollection | `places.json` + `neighborhoods.json` | Administrative districts and boroughs |
| `extent.json` | GeoJSON Polygon | City bounding box | City boundary and viewport clipping extents |
| `landmarks.json` | GeoJSON Point | `places.json` (`landmark`, `employment`) | Major landmarks, civic centres, airports |
| `model.json` | JSON Object | Network model parameters | Simulation parameters & baseline configs |
| `pack.json` | JSON Metadata | Dataset manifest | Ingestion manifest, layer counts & hashes |
| `pois.json` | GeoJSON Point | `places.json` (`shop`, `edu`, `health`, etc.) | Points of interest and urban amenities |
| `purposes.bin.json` | JSON Array | Activity categories | Classification lookup for trip purposes |
| `streets.bin` | Binary (TKST) | `street-geoms.json` | Fast binary line segments for WebGL rendering |
| `streets.json` | GeoJSON LineString | `street-geoms.json` | Named road network with hierarchy and tags |
| `tram-streets.bin` | Binary (TKST) | `transit-lines.json` (trams) | Fast binary light-rail & tram line geometry |
| `tram-streets.json` | GeoJSON LineString | `transit-lines.json` (trams) | Tram, trolley, and surface rail lines |
| `water-rings.json` | GeoJSON MultiPolygon | Waterway boundary rings | Island contours, riverbanks, canal perimeters |
| `water.json` | GeoJSON Polygon | Hydrography polygons | Water bodies, rivers, lakes, and harbors |

---

## 🚀 Automated GitHub Actions Dispatch

To trigger transformation across all cities or specific cities:

```bash
# Transform all cities in batches:
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=all -f batch=15

# Transform a specific city:
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=amsterdam
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=berlin
```

---

## 🛠️ Deploying the Worker

```bash
bunx wrangler deploy
```
