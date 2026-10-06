# city-network

> **19 Granular Urban Dataset Pipeline for Global City Atlases**
> Automated transformation and synchronization of granular urban layers directly to Cloudflare R2 (`geo-datalake` and `globe`).

---

## 🌆 19-File Granular Architecture

Modern web atlases load granular spatial and network layers individually and in parallel over HTTP/2, reducing time-to-first-render and enabling fine-grained layer caching:

| File | Type | Source / Decomposition | Purpose |
|---|---|---|---|
| `areas.json` | GeoJSON Polygon/Point | `neighborhoods.json` | Neighborhood boundaries & centroid hierarchy |
| `baseline.json` | GeoJSON MultiLineString | `transit-lines.json` | Core heavy rail and transit corridors |
| `buildings.bin` | Binary FlatGeobuf/PBF | Raw building pack | High-density 3D building extents |
| `buildings.json` | GeoJSON Polygon | Raw building pack | Vector polygon footprints |
| `demand-streets.json` | GeoJSON LineString | Demand model | Street segments weighted by mobility demand |
| `demand.json` | GeoJSON FeatureCollection | Demand model | Centroid origin-destination demand points |
| `districts.json` | GeoJSON FeatureCollection | `places.json` (`district`) | Administrative districts and boroughs |
| `extent.json` | GeoJSON Polygon | City bounding box | City boundary and viewport clipping extents |
| `landmarks.json` | GeoJSON Point | `places.json` (`landmark`, `employment`) | Major landmarks, civic centres, airports |
| `model.json` | JSON Object | Network model parameters | Simulation parameters & baseline configs |
| `pack.json` | JSON Metadata | Dataset manifest | Ingestion manifest, layer counts & hashes |
| `pois.json` | GeoJSON Point | `places.json` (`shop`, `edu`, `health`, etc.) | Points of interest and urban amenities |
| `purposes.bin.json` | JSON Array | Activity categories | Classification lookup for trip purposes |
| `streets.bin` | Binary LineString | High-density street geometry | Fast binary line segments for WebGL rendering |
| `streets.json` | GeoJSON LineString | `street-geoms.json` | Named road network with hierarchy and tags |
| `tram-streets.bin` | Binary LineString | Tram track segments | Fast binary light-rail & tram line geometry |
| `tram-streets.json` | GeoJSON LineString | Transit track geometry | Tram, trolley, and surface rail lines |
| `water-rings.json` | GeoJSON MultiPolygon | Waterway boundary rings | Island contours, riverbanks, canal perimeters |
| `water.json` | GeoJSON Polygon | Hydrography polygons | Water bodies, rivers, lakes, and harbors |

---

## ⚡ Non-Destructive Ingestion

This pipeline **never deletes or modifies** legacy files (`places.json`, `neighborhoods.json`, `street-geoms.json`, `transit-lines.json`). Instead, it generates and stages the new granular files alongside the existing ones, ensuring zero downtime and complete backwards compatibility for existing clients.

---

## 🚀 Running via GitHub Actions

This repository is **public** and runs on free GitHub Actions runners.

### Via GitHub CLI:

```bash
# Sync all 1,248 cities:
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=all -f concurrency=8

# Sync a single city (e.g., Amsterdam or Berlin):
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=amsterdam
gh workflow run city-network-granular-sync.yml --repo ayeeff/city-network -f city=berlin
```

### Via GitHub Web UI:
1. Navigate to **Actions** → **city-network-granular-sync**.
2. Click **Run workflow**.
3. Choose the city slug (`all` or comma-separated city slugs) and concurrency.

---

## 🛠️ Local Development & CLI Runner

```bash
# Install dependencies
bun install

# Run single city
bun run scripts/transform-all-to-granular-19.mjs --city amsterdam

# Run full batch with concurrency
bun run scripts/transform-all-to-granular-19.mjs --city all --concurrency 8

# Dry-run mode (verifies without writing to R2)
bun run scripts/transform-all-to-granular-19.mjs --city amsterdam --dry-run
```

---

## 🔐 Required Secrets

The GitHub Actions workflow requires the following repository secrets:
- `R2_DATALAKE_ACCOUNT_ID`: Cloudflare account ID
- `R2_DATALAKE_ACCESS_KEY_ID`: Cloudflare R2 API token access key ID
- `R2_DATALAKE_SECRET_ACCESS_KEY`: Cloudflare R2 API token secret access key
