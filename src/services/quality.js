import { ConflictError, ValidationError } from '../errors.js';
import { str, num, array } from '../validate.js';

export class QualityService {
  constructor(store, execution) { this.store = store; this.execution = execution; }

  /**
   * Inspect good (not yet inspected) units. Failed units move good -> defective and must be dispositioned
   * by rework (back to good) or rejection (scrap).
   */
  inspect(orderId, input) {
    const o = this.store.require('orders', orderId, 'Production order');
    if (!['released', 'in_progress'].includes(o.status)) throw new ConflictError(`Cannot inspect an order with status ${o.status}`);
    const inspected = num(input.inspectedQty, 'inspectedQty', { integer: true, gt: 0 });
    const failed = num(input.failedQty, 'failedQty', { integer: true, min: 0, def: 0 });
    const uninspected = o.goodQty - o.inspectedPassedQty;
    if (inspected > uninspected) throw new ValidationError(`Only ${uninspected} good unit(s) await inspection`);
    if (failed > inspected) throw new ValidationError('failedQty cannot exceed inspectedQty');
    const defects = array(input.defects ?? [], 'defects').map((d, i) => ({
      code: str(d.code, `defects[${i}].code`, { max: 32 }).toUpperCase(),
      description: str(d.description, `defects[${i}].description`, { optional: true, max: 300 }),
      quantity: num(d.quantity, `defects[${i}].quantity`, { integer: true, min: 1, max: failed || 1 }),
    }));
    if (failed > 0 && !defects.length) throw new ValidationError('Failed inspections must record at least one defect');
    if (failed === 0 && defects.length) throw new ValidationError('defects require failedQty > 0');
    const passed = inspected - failed;
    const inspection = this.store.insert('inspections', {
      orderId, productId: o.productId, inspector: str(input.inspector, 'inspector', { optional: true }),
      inspectedQty: inspected, passedQty: passed, failedQty: failed, result: failed ? 'fail' : 'pass',
      defects, disposition: { reworked: 0, rejected: 0, pending: failed },
      notes: str(input.notes, 'notes', { optional: true, max: 500 }),
    });
    // Failed units move good -> defective through the ledger so period analytics see them.
    if (failed > 0) this.execution.commit(o, { type: 'inspection', deltas: { good: -failed, defective: failed }, consumed: [], input: { note: `Inspection ${inspection.id}` } });
    this.store.update('orders', orderId, 'inspect', (x) => {
      x.inspectedPassedQty += passed;
      if (x.status === 'released') x.status = 'in_progress';
    });
    return inspection;
  }

  /**
   * Resolve defective units: `reworkQty` return to good stock (rework labor/material costs are captured),
   * `rejectQty` become scrap. Costs of rework accrue to the order.
   */
  disposition(orderId, input) {
    const o = this.store.require('orders', orderId, 'Production order');
    if (!['released', 'in_progress'].includes(o.status)) throw new ConflictError(`Cannot disposition on an order with status ${o.status}`);
    const rework = num(input.reworkQty, 'reworkQty', { integer: true, min: 0, def: 0 });
    const reject = num(input.rejectQty, 'rejectQty', { integer: true, min: 0, def: 0 });
    if (rework + reject === 0) throw new ValidationError('reworkQty or rejectQty must be > 0');
    if (rework + reject > o.defectiveQty) throw new ValidationError(`Only ${o.defectiveQty} defective unit(s) are pending disposition`);
    let inspection;
    if (input.inspectionId) {
      inspection = this.store.require('inspections', input.inspectionId, 'Inspection');
      if (inspection.orderId !== orderId) throw new ValidationError('Inspection belongs to another order');
      if (rework + reject > inspection.disposition.pending) throw new ValidationError(`Inspection has only ${inspection.disposition.pending} unit(s) pending`);
    }
    const entry = this.execution.commit(o, {
      type: rework && !reject ? 'rework' : reject && !rework ? 'rejection' : 'rework',
      deltas: { good: rework, rejected: reject, defective: -(rework + reject) },
      consumed: input.consumed ?? [], input,
    });
    if (inspection) this.store.update('inspections', inspection.id, 'disposition', (i) => {
      i.disposition.reworked += rework; i.disposition.rejected += reject; i.disposition.pending -= rework + reject;
    });
    return entry;
  }

  listInspections(orderId) { return this.store.list('inspections', (i) => !orderId || i.orderId === orderId); }

  /** Defect tracking: Pareto of defect codes with quantities and affected products. */
  defectSummary() {
    const by = {};
    for (const i of this.store.list('inspections')) for (const d of i.defects) {
      const r = (by[d.code] ??= { code: d.code, quantity: 0, inspections: 0, products: new Set(), description: d.description });
      r.quantity += d.quantity; r.inspections += 1; r.products.add(i.productId);
    }
    return Object.values(by).map((r) => ({ ...r, products: [...r.products] })).sort((a, b) => b.quantity - a.quantity);
  }
}
