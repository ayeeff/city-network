// scripts/dispatch-worker.mjs
//
// Triggers the Cloudflare Worker (https://city-network.foodstarmelbourne.workers.dev)
// to transform cities directly inside Cloudflare R2 (globe/data/).

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};

const city = flag('city', 'all');
const batchSize = parseInt(flag('batch', '15'), 10);
const WORKER_URL = process.env.WORKER_URL || 'https://city-network.foodstarmelbourne.workers.dev';

async function syncSingleCity(slug) {
  console.log(`[Worker R2] Transforming ${slug}...`);
  const res = await fetch(`${WORKER_URL}/sync?city=${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`Worker returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  console.log(`  ✓ ${slug} finished:`, Object.keys(data.results?.[slug]?.files || {}).join(', '));
}

async function syncAll() {
  console.log(`[Worker R2] Starting full dataset transformation across globe/data/...`);
  let cursor = undefined;
  let page = 1;
  let totalProcessed = 0;

  do {
    const url = new URL(`${WORKER_URL}/sync-all`);
    url.searchParams.set('limit', String(batchSize));
    if (cursor) url.searchParams.set('cursor', cursor);

    console.log(`\nBatch #${page} (fetching up to ${batchSize} cities)...`);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      console.error(`Batch #${page} failed with ${res.status}:`, await res.text());
      break;
    }

    const data = await res.json();
    const cities = data.cities || [];
    totalProcessed += cities.length;

    console.log(`  Processed ${cities.length} cities: [${cities.join(', ')}]`);
    for (const [c, r] of Object.entries(data.results || {})) {
      if (r.error) {
        console.warn(`    ✗ ${c}: ${r.error}`);
      } else {
        console.log(`    ✓ ${c}: ${Object.keys(r.files || {}).length} files generated`);
      }
    }

    if (data.truncated && data.cursor) {
      cursor = data.cursor;
      page++;
      // Small pause between batches
      await new Promise(r => setTimeout(r, 500));
    } else {
      break;
    }
  } while (cursor);

  console.log(`\n🎉 Full transformation complete! Total cities processed: ${totalProcessed}`);
}

async function main() {
  if (city === 'all') {
    await syncAll();
  } else {
    const list = city.split(',').map(s => s.trim().replace(/-city-atlas$/, ''));
    for (const c of list) {
      await syncSingleCity(c);
    }
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
