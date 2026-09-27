import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import mime from 'mime-types';
import { HttpError } from './auth.js';

// No 0/o, 1/l/i — links are easy to read out loud and type on a TV remote.
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SLUG_LENGTH = 6;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set([
  'api',
  'assets',
  'healthz',
  'favicon.ico',
  'robots.txt',
  'index.html',
  'admin',
  'login',
  'logout',
  'settings',
]);

function randomSlug() {
  let slug = '';
  for (const byte of randomBytes(SLUG_LENGTH)) slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  return slug;
}

export function cleanName(raw) {
  let name = String(raw ?? '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded; use as-is.
  }
  name = name
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (/^\.*$/.test(name)) return 'file';
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

const contentType = (name) => mime.lookup(name) || 'application/octet-stream';

/** attachment; filename="ascii"; filename*=UTF-8''… — so every client gets a sensible name. */
function contentDisposition(name) {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  let header = `attachment; filename="${ascii}"`;
  if (ascii !== name) {
    const encoded = encodeURIComponent(name).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    header += `; filename*=UTF-8''${encoded}`;
  }
  return header;
}

const publicFile = ({ id, slug, name, size, createdAt, updatedAt, downloads, lastDownloadAt }) => ({
  id,
  slug,
  name,
  size,
  createdAt,
  updatedAt,
  downloads,
  lastDownloadAt,
});

export function createFiles({ config, store, requireAuth }) {
  const db = store.data;
  const filesDir = path.join(config.dataDir, 'files');
  const tmpDir = path.join(filesDir, '.tmp');

  // Leftovers from uploads interrupted by a restart.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const blobPath = (id) => path.join(filesDir, id);
  const findFile = (id) => db.files.find((f) => f.id === id);

  function slugTaken(slug, exceptId) {
    return RESERVED_SLUGS.has(slug) || db.files.some((f) => f.slug === slug && f.id !== exceptId);
  }

  function newSlug() {
    let slug;
    do slug = randomSlug();
    while (slugTaken(slug));
    return slug;
  }

  async function diskSpace() {
    const used = db.files.reduce((sum, f) => sum + f.size, 0);
    try {
      const stats = await fsp.statfs(filesDir);
      return { used, free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch {
      return { used, free: null, total: null };
    }
  }

  /**
   * Streams the raw request body to a temp file. The browser sends the file as
   * the body (no multipart) with its name in the X-File-Name header.
   */
  async function receiveUpload(req, res) {
    const header = req.get('content-length');
    const length = Number(header);
    const reject = (status, message) => {
      // Don't let Node drain a huge body we already refused.
      res.set('Connection', 'close');
      throw new HttpError(status, message);
    };
    if (!header || !Number.isSafeInteger(length) || length < 0) {
      reject(411, 'Upload size is missing.');
    }
    if (length > config.maxUploadBytes) {
      reject(413, `Files can be up to ${config.maxUploadMb} MB.`);
    }
    const { free } = await diskSpace();
    if (free !== null && length > free) reject(507, 'Not enough disk space for that file.');

    const name = cleanName(req.get('x-file-name'));
    const tmp = path.join(tmpDir, randomBytes(12).toString('hex'));
    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > length) callback(new HttpError(400, 'Upload is larger than announced.'));
        else callback(null, chunk);
      },
    });

    try {
      await pipeline(req, counter, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (received !== length) throw new HttpError(400, 'Upload was cut short. Please try again.');
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      // The uploader closed the tab or cancelled: nothing to report.
      if (req.destroyed || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        throw new HttpError(400, 'Upload cancelled.');
      }
      throw err;
    }
    return { tmp, name, size: received };
  }

  // ── Admin API ──────────────────────────────────────────────────────────

  const api = express.Router();
  api.use(requireAuth);

  api.get('/', async (req, res) => {
    res.json({
      files: db.files.map(publicFile),
      storage: await diskSpace(),
      maxUploadBytes: config.maxUploadBytes,
      publicUrl: config.publicUrl,
    });
  });

  api.post('/', async (req, res) => {
    const upload = await receiveUpload(req, res);
    const id = randomBytes(12).toString('hex');
    await fsp.rename(upload.tmp, blobPath(id));
    const now = Date.now();
    const file = {
      id,
      slug: newSlug(),
      name: upload.name,
      size: upload.size,
      createdAt: now,
      updatedAt: now,
      downloads: 0,
      lastDownloadAt: null,
    };
    db.files.unshift(file);
    store.save();
    res.status(201).json(publicFile(file));
  });

  // Swap the file behind an existing link — handy for pushing a new APK version.
  api.put('/:id/content', async (req, res) => {
    if (!findFile(req.params.id)) throw new HttpError(404, 'File not found.');
    const upload = await receiveUpload(req, res);
    const file = findFile(req.params.id);
    if (!file) {
      await fsp.rm(upload.tmp, { force: true });
      throw new HttpError(404, 'File was deleted during upload.');
    }
    await fsp.rename(upload.tmp, blobPath(file.id));
    Object.assign(file, { name: upload.name, size: upload.size, updatedAt: Date.now() });
    store.save();
    res.json(publicFile(file));
  });

  api.patch('/:id', express.json({ limit: '16kb' }), (req, res) => {
    const file = findFile(req.params.id);
    if (!file) throw new HttpError(404, 'File not found.');
    const { slug, name } = req.body ?? {};

    if (slug !== undefined) {
      const next = String(slug).trim().toLowerCase();
      if (!SLUG_PATTERN.test(next)) {
        throw new HttpError(
          400,
          'Links can use a–z, 0–9, dots, dashes and underscores, and must start and end with a letter or number.',
        );
      }
      if (slugTaken(next, file.id)) throw new HttpError(409, `“${next}” is already taken.`);
      file.slug = next;
    }
    if (name !== undefined) {
      const next = cleanName(name);
      if (!String(name).trim()) throw new HttpError(400, 'The file name can’t be empty.');
      file.name = next;
    }
    file.updatedAt = Date.now();
    store.save();
    res.json(publicFile(file));
  });

  api.delete('/:id', async (req, res) => {
    const file = findFile(req.params.id);
    if (!file) throw new HttpError(404, 'File not found.');
    db.files = db.files.filter((f) => f.id !== file.id);
    store.save();
    await fsp.rm(blobPath(file.id), { force: true });
    res.json({ ok: true });
  });

  // ── Public direct downloads ────────────────────────────────────────────
  // GET /<slug> (or /<slug>/<anything>) streams the file itself: no landing
  // page, no redirects, Range + HEAD supported. Works in Downloader on Fire TV,
  // wget/curl, VLC, and behind link shorteners.

  const downloads = express.Router();

  downloads.get('/:slug{/:name}', (req, res, next) => {
    const slug = req.params.slug.toLowerCase();
    const file = db.files.find((f) => f.slug === slug);
    if (!file) return next();

    const range = req.headers.range;
    if (req.method === 'GET' && (!range || /^bytes=0-/.test(range))) {
      file.downloads += 1;
      file.lastDownloadAt = Date.now();
      store.save();
    }

    res.set({
      'Content-Type': contentType(file.name),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Robots-Tag': 'noindex',
    });
    res.sendFile(file.id, { root: filesDir, cacheControl: false }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  return { api, downloads };
}
