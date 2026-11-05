import { ConflictError, StockError, ValidationError } from '../errors.js';
import { str, num, array, isoDate, round, money } from '../validate.js';

export class ExecutionService {
  constructor(store, boms) { this.store = store; this.boms = boms; }

  start(orderId) {
    const o = this.store.require('orders', orderId, 'Production order');
    if (o.status !== 'released') throw new ConflictError(`Only released orders can be started (status: ${o.status})`);
    return this.store.update('orders', orderId, 'start', (x) => { x.status = 'in_progress'; x.startedAt = this.store.now().toISOString(); });
  }

  /**
   * Record production output. Materials default to a BOM backflush for every unit processed
   * (good + rejected + defective, incl. scrap allowance); pass `consumed` to record actuals instead.
   */
  recordProgress(orderId, input) {
    const o = this.store.require('orders', orderId, 'Production order');
    if (!['released', 'in_progress'].includes(o.status)) throw new ConflictError(`Cannot record production on an order with status ${o.status}`);
    const good = num(input.goodQty, 'goodQty', { integer: true, min: 0, def: 0 });
    const rejected = num(input.rejectedQty, 'rejectedQty', { integer: true, min: 0, def: 0 });
    const defective = num(input.defectiveQty, 'defectiveQty', { integer: true, min: 0, def: 0 });
    const units = good + rejected + defective;
    if (units === 0) throw new ValidationError('At least one of goodQty, rejectedQty, defectiveQty must be > 0');
    const started = o.goodQty + o.rejectedQty + o.defectiveQty;
    if (started + units > o.quantity)
      throw new ValidationError(`Recorded units (${started + units}) would exceed planned quantity (${o.quantity})`);

    let consumed = input.consumed;
    if (consumed === undefined) {
      const bom = this.boms.get(o.bomId);
      consumed = this.boms.explode(bom, units).map((r) => ({ materialId: r.materialId, quantity: r.required }));
    }
    const entry = this.#commit(o, { type: 'production', deltas: { good, rejected, defective }, consumed, input });
    return entry;
  }

  /** Mark order complete. Defective units must be dispositioned (rework/reject) first. */
  complete(orderId) {
    const o = this.store.require('orders', orderId, 'Production order');
    if (!['released', 'in_progress'].includes(o.status)) throw new ConflictError(`Cannot complete an order with status ${o.status}`);
    if (o.defectiveQty > 0) throw new ConflictError(`${o.defectiveQty} defective unit(s) await rework/reject disposition`);
    if (o.goodQty + o.rejectedQty === 0) throw new ConflictError('Nothing has been produced yet');
    return this.store.update('orders', orderId, 'complete', (x) => { x.status = 'completed'; x.completedAt = this.store.now().toISOString(); });
  }

  /**
   * Shared ledger write used by production and quality dispositions.
   * Validates everything (units, stock, work center) before mutating anything.
   */
  commit(order, spec) { return this.#commit(order, spec); }

  #commit(order, { type, deltas, consumed, input }) {
    const { good = 0, rejected = 0, defective = 0 } = deltas;
    const lines = array(consumed ?? [], 'consumed').map((c, i) => ({
      materialId: str(c.materialId, `consumed[${i}].materialId`),
      quantity: num(c.quantity, `consumed[${i}].quantity`, { gt: 0 }),
    }));
    const merged = new Map();
    for (const l of lines) merged.set(l.materialId, round((merged.get(l.materialId) ?? 0) + l.quantity));
    const shortages = [];
    const mats = new Map();
    for (const [materialId, quantity] of merged) {
      const m = this.store.require('materials', materialId, 'Material');
      mats.set(materialId, m);
      if (m.stockOnHand < quantity) shortages.push({ materialId, code: m.code, required: quantity, onHand: m.stockOnHand });
    }
    if (shortages.length) throw new StockError('Insufficient raw material stock for this transaction', { shortages });

    const laborHours = num(input.laborHours, 'laborHours', { min: 0, def: 0 });
    const machineHours = num(input.machineHours, 'machineHours', { min: 0, def: 0 });
    let wc = null;
    if (input.workCenterId !== undefined || laborHours > 0 || machineHours > 0) {
      wc = this.store.require('workCenters', str(input.workCenterId, 'workCenterId'), 'Work center');
    }
    const recordedAt = isoDate(input.recordedAt, 'recordedAt', { optional: true }) ?? this.store.now().toISOString();

    // ---- apply ----
    const consumedOut = [...merged].map(([materialId, quantity]) => {
      const m = mats.get(materialId);
      return { materialId, code: m.code, quantity, unitCost: m.unitCost, cost: money(quantity * m.unitCost) };
    });
    for (const c of consumedOut) this.store.update('materials', c.materialId, `consume:${order.id}`, (m) => { m.stockOnHand = round(m.stockOnHand - c.quantity); });
    const entry = this.store.insert('executions', {
      orderId: order.id, productId: order.productId, type, recordedAt,
      goodQty: good, rejectedQty: rejected, defectiveQty: defective,
      consumed: consumedOut, materialCost: money(consumedOut.reduce((s, c) => s + c.cost, 0)),
      workCenterId: wc?.id ?? null, laborHours, machineHours,
      laborCost: money(laborHours * (wc?.laborRatePerHour ?? 0)),
      machineCost: money(machineHours * (wc?.machineRatePerHour ?? 0)),
      note: str(input.note, 'note', { optional: true, max: 500 }),
    });
    this.store.update('orders', order.id, `progress:${type}`, (o) => {
      o.goodQty += good;
      o.rejectedQty += rejected;
      o.defectiveQty += defective;
      if (o.status === 'released') { o.status = 'in_progress'; o.startedAt = recordedAt; }
    });
    return entry;
  }

  listEntries(orderId) { return this.store.list('executions', (e) => !orderId || e.orderId === orderId); }

  progress(orderId) {
    const o = this.store.require('orders', orderId, 'Production order');
    const started = o.goodQty + o.rejectedQty + o.defectiveQty;
    const entries = this.listEntries(orderId);
    const consumed = {};
    for (const e of entries) for (const c of e.consumed) consumed[c.materialId] = round((consumed[c.materialId] ?? 0) + c.quantity);
    return {
      orderId, status: o.status, plannedQty: o.quantity, goodQty: o.goodQty, rejectedQty: o.rejectedQty, defectiveQty: o.defectiveQty,
      remainingQty: o.quantity - started, percentComplete: round((started / o.quantity) * 100, 2),
      consumedMaterials: consumed, entries: entries.length,
    };
  }
}
