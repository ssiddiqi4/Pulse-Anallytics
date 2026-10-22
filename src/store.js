import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const FILE_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

function fileFor(ts) {
  return `events-${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Append-only event store: one JSONL file per UTC day, an in-memory index for
 * queries, and batched writes. Good for up to a few hundred thousand events;
 * see DESIGN.md for the scale-out path.
 */
export class EventStore {
  constructor({ dir, maxEvents = 250_000, retentionDays = 400, flushIntervalMs = 500, logger = console } = {}) {
    this.dir = dir;
    this.maxEvents = maxEvents;
    this.retentionDays = retentionDays;
    this.flushIntervalMs = flushIntervalMs;
    this.logger = logger;
    this.events = [];
    this.pending = [];
    this.writeChain = Promise.resolve();
    this.flushTimer = null;
    this.writeErrors = 0;
    this.loaded = { events: 0, files: 0, skipped: 0 };
    this.ready = false;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await this.#load();
    this.ready = true;
    this.maintenanceTimer = setInterval(() => {
      this.purge().catch((err) => this.logger.error('[store] purge failed:', err.message));
    }, DAY_MS);
    this.maintenanceTimer.unref?.();
    this.purge().catch(() => {});
    return this;
  }

  async #load() {
    const cutoffDay = new Date(Date.now() - this.retentionDays * DAY_MS).toISOString().slice(0, 10);
    let files = [];
    try {
      files = (await fsp.readdir(this.dir))
        .filter((name) => {
          const match = FILE_RE.exec(name);
          return match && match[1] >= cutoffDay;
        })
        .sort();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    let skipped = 0;
    for (const name of files) {
      const stream = fs.createReadStream(path.join(this.dir, name), { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event && Number.isFinite(event.ts) && typeof event.site === 'string') {
              this.events.push(event);
            } else {
              skipped += 1;
            }
          } catch {
            skipped += 1;
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }

    this.events.sort((a, b) => a.ts - b.ts);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    this.loaded = { events: this.events.length, files: files.length, skipped };
    if (skipped) this.logger.warn(`[store] skipped ${skipped} malformed line(s)`);
  }

  record(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.pending.push(event);
    if (this.pending.length >= 200) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeChain = this.writeChain.then(() => this.#writePending());
    return this.writeChain;
  }

  async #writePending() {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    const byFile = new Map();
    for (const event of batch) {
      const name = fileFor(event.ts);
      if (!byFile.has(name)) byFile.set(name, []);
      byFile.get(name).push(`${JSON.stringify(event)}\n`);
    }
    for (const [name, lines] of byFile) {
      try {
        await fsp.appendFile(path.join(this.dir, name), lines.join(''));
      } catch (err) {
        this.writeErrors += 1;
        this.logger.error(`[store] could not persist ${name}: ${err.message}`);
      }
    }
  }

  query(siteId, from, to) {
    const list = this.events;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].ts < from) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < list.length; i += 1) {
      const event = list[i];
      if (event.ts >= to) break;
      if (event.site === siteId) out.push(event);
    }
    return out;
  }

  async purge() {
    const cutoffTs = Date.now() - this.retentionDays * DAY_MS;
    const cutoffDay = new Date(cutoffTs).toISOString().slice(0, 10);
    let files = [];
    try {
      files = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of files) {
      const match = FILE_RE.exec(name);
      if (match && match[1] < cutoffDay) {
        await fsp.unlink(path.join(this.dir, name)).catch(() => {});
      }
    }
    if (this.events.length && this.events[0].ts < cutoffTs) {
      this.events = this.events.filter((event) => event.ts >= cutoffTs);
    }
  }

  status() {
    return {
      events: this.events.length,
      pending: this.pending.length,
      writeErrors: this.writeErrors,
      files: this.loaded.files,
      skipped: this.loaded.skipped,
      dir: this.dir,
    };
  }

  async close() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    await this.flush();
  }
}
