import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError } from './errors.js';

const actorStore = new AsyncLocalStorage();
/** Run fn with an actor identity attached to every audit record written inside it. */
export const withActor = (actor, fn) => actorStore.run(actor, fn);
export const currentActor = () => actorStore.getStore() ?? 'system';

const PREFIX = {
  categories: 'CAT', products: 'PRD', materials: 'MAT', boms: 'BOM', workCenters: 'WC',
  orders: 'PO', executions: 'EXE', inspections: 'QI', audit: 'AUD',
};
const clone = (o) => (o === undefined ? undefined : structuredClone(o));

/**
 * In-memory document store with optional JSON-file snapshot persistence.
 * Every mutation (insert/update) is recorded in an append-only audit log with before/after snapshots.
 * Reads always return deep copies, so callers cannot mutate state without going through update().
 */
export class Store {
  constructor({ file = null, now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { seq: {} };
    for (const c of Object.keys(PREFIX)) this.data[c] = [];
    if (file && fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  nextId(coll) {
    const n = (this.data.seq[coll] = (this.data.seq[coll] ?? 0) + 1);
    return `${PREFIX[coll]}-${String(n).padStart(4, '0')}`;
  }

  insert(coll, doc) {
    const ts = this.now().toISOString();
    const rec = { id: this.nextId(coll), ...clone(doc), createdAt: ts, updatedAt: ts };
    this.data[coll].push(rec);
    this.#audit(coll, rec.id, 'create', undefined, rec);
    this.persist();
    return clone(rec);
  }

  get(coll, id) { return clone(this.data[coll].find((d) => d.id === id)); }

  require(coll, id, label = coll) {
    const d = this.get(coll, id);
    if (!d) throw new NotFoundError(`${label} not found: ${id}`);
    return d;
  }

  list(coll, pred = () => true) { return this.data[coll].filter(pred).map(clone); }

  /** Mutate a document inside fn(liveDoc); validate BEFORE mutating inside fn. Audited. */
  update(coll, id, action, fn) {
    const live = this.data[coll].find((d) => d.id === id);
    if (!live) throw new NotFoundError(`${coll} record not found: ${id}`);
    const before = clone(live);
    fn(live);
    live.updatedAt = this.now().toISOString();
    this.#audit(coll, id, action, before, live);
    this.persist();
    return clone(live);
  }

  history(entity, entityId) {
    return this.list('audit', (a) => (!entity || a.entity === entity) && (!entityId || a.entityId === entityId));
  }

  #audit(entity, entityId, action, before, after) {
    if (entity === 'audit') return;
    this.data.audit.push({
      id: this.nextId('audit'), at: this.now().toISOString(), actor: currentActor(),
      entity, entityId, action, before: clone(before), after: clone(after),
    });
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
