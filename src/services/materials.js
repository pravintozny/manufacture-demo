import { ConflictError, StockError, ValidationError } from '../errors.js';
import { str, num, plainObject, round, money } from '../validate.js';

function supplier(s, optional = true) {
  const o = plainObject(s, 'supplier', { optional });
  if (!o) return undefined;
  return {
    name: str(o.name, 'supplier.name'),
    contact: str(o.contact, 'supplier.contact', { optional: true }),
    email: str(o.email, 'supplier.email', { optional: true }),
    leadTimeDays: num(o.leadTimeDays, 'supplier.leadTimeDays', { min: 0, def: 0 }),
  };
}

export class MaterialService {
  constructor(store) { this.store = store; }

  create(input) {
    const code = str(input.code, 'code', { max: 32 }).toUpperCase();
    if (this.store.list('materials', (m) => m.code === code).length) throw new ConflictError(`Material code already exists: ${code}`);
    return this.store.insert('materials', {
      code, name: str(input.name, 'name'), unit: str(input.unit ?? 'pcs', 'unit', { max: 16 }),
      unitCost: num(input.unitCost, 'unitCost', { min: 0 }),
      stockOnHand: num(input.stockOnHand, 'stockOnHand', { min: 0, def: 0 }),
      reorderLevel: num(input.reorderLevel, 'reorderLevel', { min: 0, def: 0 }),
      reorderQty: num(input.reorderQty, 'reorderQty', { min: 0, def: 0 }),
      supplier: supplier(input.supplier) ?? null,
    });
  }

  update(id, input) {
    this.store.require('materials', id, 'Material');
    const patch = {};
    if (input.name !== undefined) patch.name = str(input.name, 'name');
    if (input.unitCost !== undefined) patch.unitCost = num(input.unitCost, 'unitCost', { min: 0 });
    if (input.reorderLevel !== undefined) patch.reorderLevel = num(input.reorderLevel, 'reorderLevel', { min: 0 });
    if (input.reorderQty !== undefined) patch.reorderQty = num(input.reorderQty, 'reorderQty', { min: 0 });
    if (input.supplier !== undefined) patch.supplier = supplier(input.supplier, false);
    if (input.stockOnHand !== undefined || input.code !== undefined)
      throw new ValidationError('code is immutable; change stock via /receive or /adjust');
    return this.store.update('materials', id, 'update', (m) => Object.assign(m, patch));
  }

  /** Goods receipt: increases stock and re-averages unit cost (weighted average cost). */
  receive(id, input) {
    const m = this.store.require('materials', id, 'Material');
    const qty = num(input.quantity, 'quantity', { gt: 0 });
    const cost = num(input.unitCost, 'unitCost', { min: 0, def: m.unitCost });
    const newStock = m.stockOnHand + qty;
    const avg = money((m.stockOnHand * m.unitCost + qty * cost) / newStock);
    return this.store.update('materials', id, 'receive', (x) => { x.stockOnHand = round(newStock); x.unitCost = avg; });
  }

  /** Manual correction (cycle count, damage). Rejects any adjustment that would make stock negative. */
  adjust(id, input) {
    const m = this.store.require('materials', id, 'Material');
    const delta = num(input.delta, 'delta');
    if (delta === 0) throw new ValidationError('delta must be non-zero');
    str(input.reason, 'reason');
    if (m.stockOnHand + delta < 0)
      throw new StockError(`Adjustment would make stock negative for ${m.code}`, { materialId: id, onHand: m.stockOnHand, delta });
    return this.store.update('materials', id, `adjust:${input.reason}`, (x) => { x.stockOnHand = round(x.stockOnHand + delta); });
  }

  get(id) { return this.store.require('materials', id, 'Material'); }
  list() { return this.store.list('materials'); }
  lowStock() { return this.list().filter((m) => m.stockOnHand <= m.reorderLevel); }
}
