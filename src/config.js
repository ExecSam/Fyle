import path from 'node:path';

function int(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number >= ${min} (got "${raw}")`);
  }
  return value;
}

// Accepts the same shapes Express does: true/false, a hop count, or a list of IPs/subnets.
function trustProxy(raw) {
  if (raw === undefined || raw.trim() === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function publicUrl(raw) {
  if (!raw || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`PUBLIC_URL must be a full URL like https://files.example.com (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must start with http:// or https://');
  }
  return url.origin;
}

export function loadConfig() {
  const adminPassword = process.env.ADMIN_PASSWORD ?? '';
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is not set. Add it to your .env file and restart.');
  }

  const maxUploadMb = int('MAX_UPLOAD_MB', 500);

  return {
    adminPassword,
    port: int('PORT', 3000),
    dataDir: path.resolve(process.env.DATA_DIR || 'data'),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxUploadMb,
    publicUrl: publicUrl(process.env.PUBLIC_URL),
    trustProxy: trustProxy(process.env.TRUST_PROXY),
    sessionDays: int('SESSION_DAYS', 30),
  };
}
