import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// games/ is served as static files, so the replay always shows what the arena saved.
// GAMES_DIR overrides it (e.g. to view smoke-test games in a tmp dir).
const gamesDir = process.env.GAMES_DIR ?? '../games';

// campaign.json lives in the repo root, outside publicDir. Serve it at /campaign.json in dev
// (read on every request, so the header follows level changes) and copy it into the build,
// so the UI can show which Elo levels the campaign runner is currently playing.
function campaignJson(): Plugin {
  const file = fileURLToPath(new URL('../campaign.json', import.meta.url));
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : '{"slots":[]}');
  return {
    name: 'campaign-json',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/campaign.json') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(read());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'campaign.json', source: read() });
    },
  };
}

export default defineConfig({
  publicDir: gamesDir,
  plugins: [campaignJson()],
});
