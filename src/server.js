import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createAuth } from './auth.js';
import { createFiles } from './files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const vendor = (...parts) => path.join(root, 'node_modules', ...parts);

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const store = new Store(path.join(config.dataDir, 'fyle.json'));
store.load();

const auth = createAuth({ config, store });
await auth.checkPasswordRotation();
const files = createFiles({ config, store, requireAuth: auth.requireAuth });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const pageHeaders = (req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex',
  });
  next();
};

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(publicDir, 'assets', 'favicon.svg')));

// Fonts and the WebAuthn helper ship inside the image — no third-party requests.
const longCache = { maxAge: '30d', immutable: true };
app.use(
  '/assets/fonts/inter',
  express.static(vendor('@fontsource-variable/inter/files'), longCache),
);
app.use(
  '/assets/fonts/jetbrains-mono',
  express.static(vendor('@fontsource-variable/jetbrains-mono/files'), longCache),
);
app.get('/assets/vendor/webauthn.js', (req, res) =>
  res.sendFile(vendor('@simplewebauthn/browser/dist/bundle/index.umd.min.js')),
);
app.use('/assets', express.static(path.join(publicDir, 'assets')));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', auth.loadSession, auth.csrfGuard);
app.use('/api/files', files.api);
app.use('/api', auth.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('/', pageHeaders, (req, res) =>
  res.sendFile(path.join(publicDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
);

// Anything else is treated as a share link: /<slug> streams the file directly.
app.use(files.downloads);

app.use(pageHeaders, (req, res) => {
  res.status(404).sendFile(path.join(publicDir, '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.destroy();
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  if (req.originalUrl.startsWith('/api/')) {
    return res
      .status(status)
      .json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  }
  if (status === 404) return res.status(404).sendFile(path.join(publicDir, '404.html'));
  res
    .status(status)
    .type('text')
    .send(status >= 500 ? 'Something went wrong.' : err.message);
});

const server = app.listen(config.port, () => {
  console.log(`Fyle is listening on port ${config.port}`);
  if (config.publicUrl) console.log(`  public url: ${config.publicUrl}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  max upload: ${config.maxUploadMb} MB`);
  console.log(`  sign-in: ${store.data.settings.method}`);
});
// Large uploads over slow connections can take a long time; don't cut them off.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

async function shutdown() {
  server.close();
  server.closeIdleConnections();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
