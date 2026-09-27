import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const scrypt = promisify(scryptCb);

const SESSION_COOKIE = 'fyle_session';
const METHODS = ['password', 'pin', 'passkey'];
const PIN_PATTERN = /^\d{4,8}$/;

// Per-IP lockout: 5 free attempts, then an exponentially growing wait (1 min … 1 h).
const FREE_ATTEMPTS = 5;
const MAX_LOCK_MS = 60 * 60 * 1000;
// Across all IPs: this many wrong PINs within an hour pauses PIN sign-in (password still works).
const PIN_GLOBAL_LIMIT = 30;
const HOUR = 60 * 60 * 1000;

const sha256 = (value) => createHash('sha256').update(value).digest();

export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifySecret(secret, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(secret, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

/** "Chrome on macOS" — good enough to tell your own devices apart. */
export function describeDevice(ua = '') {
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/SamsungBrowser/.test(ua) && 'Samsung Internet') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    null;
  const os =
    (/iPhone/.test(ua) && 'iPhone') ||
    (/iPad/.test(ua) && 'iPad') ||
    (/Android/.test(ua) && 'Android') ||
    (/CrOS/.test(ua) && 'ChromeOS') ||
    (/Mac OS X|Macintosh/.test(ua) && 'macOS') ||
    (/Windows/.test(ua) && 'Windows') ||
    (/Linux/.test(ua) && 'Linux') ||
    null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

class LoginThrottle {
  constructor() {
    this.byIp = new Map();
    this.pinFailures = [];
    setInterval(() => this.#prune(), 10 * 60 * 1000).unref();
  }

  /** Milliseconds until this IP may try again (0 = allowed now). */
  wait(ip) {
    const entry = this.byIp.get(ip);
    return entry ? Math.max(0, entry.lockedUntil - Date.now()) : 0;
  }

  fail(ip) {
    const entry = this.byIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    entry.last = Date.now();
    if (entry.fails >= FREE_ATTEMPTS) {
      const lockMs = Math.min(60_000 * 2 ** (entry.fails - FREE_ATTEMPTS), MAX_LOCK_MS);
      entry.lockedUntil = Date.now() + lockMs;
    }
    this.byIp.set(ip, entry);
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }

  pinPaused() {
    const cutoff = Date.now() - HOUR;
    this.pinFailures = this.pinFailures.filter((t) => t > cutoff);
    return this.pinFailures.length >= PIN_GLOBAL_LIMIT;
  }

  pinFailed() {
    this.pinFailures.push(Date.now());
  }

  #prune() {
    const cutoff = Date.now() - 24 * HOUR;
    for (const [ip, entry] of this.byIp) {
      if (entry.lockedUntil < Date.now() && entry.last < cutoff) this.byIp.delete(ip);
    }
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function createAuth({ config, store }) {
  const db = store.data;
  const sessionTtl = config.sessionDays * 24 * HOUR;
  const throttle = new LoginThrottle();
  const challenges = new Map();

  if (!db.settings.webauthnUserId) {
    db.settings.webauthnUserId = randomBytes(16).toString('base64url');
    store.save();
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  function setSessionCookie(req, res, token) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: sessionTtl,
      path: '/',
    });
  }

  function startSession(req, res) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    db.sessions[sha256(token).toString('base64url')] = {
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + sessionTtl,
      device: describeDevice(req.get('user-agent')),
    };
    store.save();
    setSessionCookie(req, res, token);
  }

  function pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of Object.entries(db.sessions)) {
      if (session.expiresAt < now) {
        delete db.sessions[key];
        changed = true;
      }
    }
    if (changed) store.save();
  }
  pruneSessions();
  setInterval(pruneSessions, HOUR).unref();

  /** Attaches req.sessionKey when the request carries a valid session; slides expiry hourly. */
  function loadSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const key = sha256(token).toString('base64url');
      const session = db.sessions[key];
      const now = Date.now();
      if (session && session.expiresAt > now) {
        req.sessionKey = key;
        if (now - session.lastSeenAt > HOUR) {
          session.lastSeenAt = now;
          session.expiresAt = now + sessionTtl;
          store.save();
          setSessionCookie(req, res, token);
        }
      } else if (session) {
        delete db.sessions[key];
        store.save();
      }
    }
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.sessionKey) return res.status(401).json({ error: 'Please sign in.' });
    next();
  }

  // Browsers can't add custom headers to cross-site requests without a CORS
  // preflight (which we never approve), so this blocks CSRF on every write.
  function csrfGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('x-fyle') !== '1')
      return res.status(403).json({ error: 'Missing request header.' });
    next();
  }

  // ── Credentials ─────────────────────────────────────────────────────────

  function passwordMatches(input) {
    return timingSafeEqual(sha256(String(input)), sha256(config.adminPassword));
  }

  // Changing ADMIN_PASSWORD in .env signs out every device on next start.
  async function checkPasswordRotation() {
    const check = db.settings.passwordCheck;
    if (check && (await verifySecret(config.adminPassword, check))) return;
    if (check) {
      db.sessions = {};
      console.log('ADMIN_PASSWORD changed — all devices have been signed out.');
    }
    db.settings.passwordCheck = await hashSecret(config.adminPassword);
    store.save();
  }

  function guardThrottle(req) {
    const wait = throttle.wait(req.ip);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${formatWait(seconds)}.`, {
        retryAfter: seconds,
      });
    }
  }

  function rejectLogin(req, message) {
    throttle.fail(req.ip);
    const wait = throttle.wait(req.ip);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpError(401, `${message} Try again in ${formatWait(seconds)}.`, {
        retryAfter: seconds,
      });
    }
    throw new HttpError(401, message);
  }

  // ── WebAuthn helpers ───────────────────────────────────────────────────

  // Passkeys are bound to a domain. PUBLIC_URL pins it; otherwise we use the
  // browser's Origin header, which keeps working behind reverse proxies that
  // rewrite Host or terminate TLS. A spoofed Origin gains nothing: the
  // authenticator only signs for the domain the passkey was created on.
  function relyingParty(req) {
    let origin = config.publicUrl;
    if (!origin) {
      try {
        const url = new URL(req.get('origin'));
        if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
      } catch {
        // No usable Origin header.
      }
    }
    origin ??= `${req.protocol}://${req.host}`;
    return { origin, rpID: new URL(origin).hostname };
  }

  function rememberChallenge(kind, challenge, rp) {
    const now = Date.now();
    for (const [id, entry] of challenges) {
      if (entry.expiresAt < now) challenges.delete(id);
    }
    // Keep the map bounded; unauthenticated visitors can request login challenges.
    while (challenges.size >= 200) challenges.delete(challenges.keys().next().value);
    const id = randomBytes(16).toString('base64url');
    challenges.set(id, { kind, challenge, ...rp, expiresAt: now + 5 * 60 * 1000 });
    return id;
  }

  function takeChallenge(id, kind) {
    const entry = challenges.get(id);
    challenges.delete(id);
    if (!entry || entry.kind !== kind || entry.expiresAt < Date.now()) {
      throw new HttpError(400, 'That passkey request expired. Please try again.');
    }
    return entry;
  }

  const toBytes = (b64url) => new Uint8Array(Buffer.from(b64url, 'base64url'));

  // ── Routes ─────────────────────────────────────────────────────────────

  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/session', (req, res) => {
    const method = db.settings.method;
    res.json({
      authenticated: Boolean(req.sessionKey),
      method,
      pinLength: method === 'pin' ? db.settings.pinLength : null,
      hasPasskeys: db.passkeys.length > 0,
    });
  });

  router.post('/login/password', async (req, res) => {
    guardThrottle(req);
    if (!passwordMatches(req.body?.password ?? '')) rejectLogin(req, 'Wrong password.');
    throttle.succeed(req.ip);
    startSession(req, res);
    res.json({ ok: true });
  });

  router.post('/login/pin', async (req, res) => {
    if (db.settings.method !== 'pin' || !db.settings.pinHash) {
      throw new HttpError(400, 'PIN sign-in is turned off.');
    }
    guardThrottle(req);
    if (throttle.pinPaused()) {
      throw new HttpError(
        429,
        'PIN sign-in is paused after too many wrong PINs. Use the admin password.',
      );
    }
    const pin = String(req.body?.pin ?? '');
    if (!PIN_PATTERN.test(pin) || !(await verifySecret(pin, db.settings.pinHash))) {
      throttle.pinFailed();
      rejectLogin(req, 'Wrong PIN.');
    }
    throttle.succeed(req.ip);
    startSession(req, res);
    res.json({ ok: true });
  });

  router.post('/login/passkey/options', async (req, res) => {
    if (db.passkeys.length === 0) throw new HttpError(400, 'No passkeys have been added yet.');
    guardThrottle(req);
    const rp = relyingParty(req);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'required',
      allowCredentials: db.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    res.json({ challengeId: rememberChallenge('login', options.challenge, rp), options });
  });

  router.post('/login/passkey/verify', async (req, res) => {
    guardThrottle(req);
    const { challengeId, response } = req.body ?? {};
    const expected = takeChallenge(challengeId, 'login');
    const passkey = db.passkeys.find((p) => p.id === response?.id);
    if (!passkey) rejectLogin(req, 'That passkey isn’t registered here.');

    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.origin,
        expectedRPID: expected.rpID,
        credential: {
          id: passkey.id,
          publicKey: toBytes(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
      });
    } catch (err) {
      rejectLogin(req, `Passkey check failed: ${err.message}`);
    }
    if (!result.verified) rejectLogin(req, 'Passkey check failed.');

    passkey.counter = result.authenticationInfo.newCounter;
    passkey.lastUsedAt = Date.now();
    throttle.succeed(req.ip);
    startSession(req, res);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionKey) {
      delete db.sessions[req.sessionKey];
      store.save();
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Everything below needs a signed-in admin.
  router.use(['/settings', '/passkeys', '/sessions'], requireAuth);

  function settingsPayload(req) {
    return {
      method: db.settings.method,
      pin: { set: Boolean(db.settings.pinHash), length: db.settings.pinLength },
      passkeys: db.passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({
        id,
        name,
        createdAt,
        lastUsedAt,
      })),
      sessions: Object.entries(db.sessions)
        .map(([key, s]) => ({
          device: s.device,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          current: key === req.sessionKey,
        }))
        .sort((a, b) => b.current - a.current || b.lastSeenAt - a.lastSeenAt),
      passkeyDomain: config.publicUrl ? new URL(config.publicUrl).hostname : null,
    };
  }

  router.get('/settings', (req, res) => res.json(settingsPayload(req)));

  router.put('/settings/method', (req, res) => {
    const method = req.body?.method;
    if (!METHODS.includes(method)) throw new HttpError(400, 'Unknown sign-in method.');
    if (method === 'pin' && !db.settings.pinHash) throw new HttpError(400, 'Set a PIN first.');
    if (method === 'passkey' && db.passkeys.length === 0) {
      throw new HttpError(400, 'Add a passkey first.');
    }
    db.settings.method = method;
    store.save();
    res.json(settingsPayload(req));
  });

  router.put('/settings/pin', async (req, res) => {
    const pin = String(req.body?.pin ?? '');
    if (!PIN_PATTERN.test(pin)) throw new HttpError(400, 'A PIN is 4 to 8 digits.');
    db.settings.pinHash = await hashSecret(pin);
    db.settings.pinLength = pin.length;
    if (req.body?.activate) db.settings.method = 'pin';
    store.save();
    res.json(settingsPayload(req));
  });

  router.delete('/settings/pin', (req, res) => {
    db.settings.pinHash = null;
    db.settings.pinLength = null;
    if (db.settings.method === 'pin') db.settings.method = 'password';
    store.save();
    res.json(settingsPayload(req));
  });

  router.post('/passkeys/options', async (req, res) => {
    const rp = relyingParty(req);
    const options = await generateRegistrationOptions({
      rpName: 'Fyle',
      rpID: rp.rpID,
      userName: 'admin',
      userDisplayName: 'Fyle admin',
      userID: toBytes(db.settings.webauthnUserId),
      attestationType: 'none',
      excludeCredentials: db.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    res.json({ challengeId: rememberChallenge('register', options.challenge, rp), options });
  });

  router.post('/passkeys', async (req, res) => {
    const { challengeId, response, activate } = req.body ?? {};
    const expected = takeChallenge(challengeId, 'register');
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.origin,
        expectedRPID: expected.rpID,
      });
    } catch (err) {
      throw new HttpError(400, `Couldn’t add passkey: ${err.message}`);
    }
    if (!result.verified) throw new HttpError(400, 'Couldn’t verify that passkey.');

    const { credential } = result.registrationInfo;
    if (!db.passkeys.some((p) => p.id === credential.id)) {
      db.passkeys.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? response?.response?.transports ?? [],
        name: describeDevice(req.get('user-agent')),
        createdAt: Date.now(),
        lastUsedAt: null,
      });
    }
    if (activate) db.settings.method = 'passkey';
    store.save();
    res.json(settingsPayload(req));
  });

  router.delete('/passkeys/:id', (req, res) => {
    const before = db.passkeys.length;
    db.passkeys = db.passkeys.filter((p) => p.id !== req.params.id);
    if (db.passkeys.length === before) throw new HttpError(404, 'Passkey not found.');
    if (db.passkeys.length === 0 && db.settings.method === 'passkey') {
      db.settings.method = 'password';
    }
    store.save();
    res.json(settingsPayload(req));
  });

  router.delete('/sessions/others', (req, res) => {
    for (const key of Object.keys(db.sessions)) {
      if (key !== req.sessionKey) delete db.sessions[key];
    }
    store.save();
    res.json(settingsPayload(req));
  });

  return { router, loadSession, requireAuth, csrfGuard, checkPasswordRotation };
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export { HttpError };
