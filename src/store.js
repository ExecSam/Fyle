import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EMPTY = () => ({
  version: 1,
  settings: {
    method: 'password',
    pinHash: null,
    pinLength: null,
    webauthnUserId: null,
    passwordCheck: null,
  },
  passkeys: [],
  sessions: {},
  files: [],
});

/**
 * A tiny JSON document store. Everything lives in memory and is flushed to
 * disk with write-to-temp + rename so a crash never leaves a half-written file.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.writing = null;
    this.dirty = false;
    this.timer = null;
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.flushSync();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const base = EMPTY();
    this.data = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...parsed.settings },
    };
  }

  /** Schedule a write. Calls in quick succession are coalesced into one. */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#flush().catch((err) => console.error('Failed to save data:', err));
    }, 200);
  }

  async #flush() {
    if (this.writing) {
      await this.writing;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    this.writing = fsp
      .writeFile(tmp, JSON.stringify(this.data, null, 2))
      .then(() => fsp.rename(tmp, this.file))
      .finally(() => {
        this.writing = null;
      });
    await this.writing;
    if (this.dirty) await this.#flush();
  }

  /** Wait for any in-flight write, then write the latest state. Used on shutdown. */
  async close() {
    if (this.writing) await this.writing.catch(() => {});
    this.flushSync();
  }

  flushSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
