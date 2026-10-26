// `wrangler dev` for networks that require an HTTPS proxy (see DECISIONS.md, "Network").
// Usage: npm run dev:proxied  ->  http://localhost:8787
import { startProxiedWorker } from './proxied-worker.ts';

const port = Number(process.env.PORT ?? 8787);
const worker = await startProxiedWorker({ port });
console.log(`music-links dev server (proxied outbound) on http://localhost:${port}`);
const stop = async () => {
  await worker.dispose();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
