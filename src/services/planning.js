import { ConflictError, StockError, ValidationError } from '../errors.js';
import { str, num, isoDate } from '../validate.js';
import { buildPlan, OPEN_STATUSES } from '../domain/mrp.js';

export class PlanningService {
  constructor(store, boms) { this.store = store; this.boms = boms; }

  /** Pins the product's ACTIVE BOM version onto the order, so later BOM revisions never change a running order. */
  createOrder(input) {
    const product = this.store.require('products', str(input.productId, 'productId'), 'Product');
    if (product.status !== 'active') throw new ConflictError('Cannot plan production of a discontinued product');
    const bom = this.boms.getActive(product.id);
    if (!bom) throw new ConflictError(`Product ${product.sku} has no active BOM`);
    const quantity = num(input.quantity, 'quantity', { gt: 0, integer: true });
    const plannedStart = isoDate(input.plannedStart, 'plannedStart');
    const dueDate = isoDate(input.dueDate, 'dueDate');
    if (dueDate < plannedStart.slice(0, 10)) throw new ValidationError('dueDate must not be before plannedStart');
    return this.store.insert('orders', {
      productId: product.id, sku: product.sku, bomId: bom.id, bomVersion: bom.version, quantity,
      plannedStart, dueDate, priority: num(input.priority, 'priority', { integer: true, min: 1, max: 5, def: 3 }),
      notes: str(input.notes, 'notes', { optional: true, max: 1000 }), status: 'planned',
      goodQty: 0, rejectedQty: 0, defectiveQty: 0, inspectedPassedQty: 0,
    });
  }

  plan(now = this.store.now()) {
    return buildPlan({
      orders: this.store.list('orders'), boms: this.store.list('boms'),
      workCenters: this.store.list('workCenters'), materials: this.store.list('materials'), now,
    });
  }

  /** Material requirement planning view: requirements, available stock, shortages and purchase recommendations. */
  mrp() {
    const p = this.plan();
    return { generatedAt: p.generatedAt, materials: p.materials, shortages: p.shortages, purchaseRecommendations: p.purchaseRecommendations, orders: p.orders.map((o) => ({ orderId: o.orderId, requirements: o.requirements, feasible: o.feasible })) };
  }

  /** Per work-center queue and load derived from the schedule. */
  schedule() {
    const p = this.plan();
    return { generatedAt: p.generatedAt, orders: p.orders.map(({ orderId, operations, plannedStart, plannedEnd, late, status }) => ({ orderId, status, plannedStart, plannedEnd, late, operations })) };
  }

  getOrder(id) {
    const order = this.store.require('orders', id, 'Production order');
    const entry = OPEN_STATUSES.includes(order.status) ? this.plan().orders.find((o) => o.orderId === id) : undefined;
    return { ...order, plan: entry };
  }
  listOrders({ status, productId } = {}) {
    return this.store.list('orders', (o) => (!status || o.status === status) && (!productId || o.productId === productId));
  }

  /** Stock validation gate: an order releases only if the sequential plan covers all of its materials and work centers. */
  release(id) {
    const order = this.store.require('orders', id, 'Production order');
    if (order.status !== 'planned') throw new ConflictError(`Only planned orders can be released (status: ${order.status})`);
    const entry = this.plan().orders.find((o) => o.orderId === id);
    const blocking = entry.issues.filter((i) => i.type !== 'LATE');
    const short = blocking.filter((i) => i.type === 'MATERIAL_SHORTAGE');
    if (short.length) throw new StockError(`Insufficient stock to release ${id}`, { shortages: short });
    if (blocking.length) throw new ConflictError(`Cannot release ${id}: ${blocking.map((i) => i.type).join(', ')}`, { issues: blocking });
    return this.store.update('orders', id, 'release', (o) => { o.status = 'released'; o.releasedAt = this.store.now().toISOString(); });
  }

  cancel(id, reason) {
    const order = this.store.require('orders', id, 'Production order');
    if (!['planned', 'released'].includes(order.status))
      throw new ConflictError(`Cannot cancel an order with status ${order.status}`);
    if (order.goodQty + order.rejectedQty + order.defectiveQty > 0) throw new ConflictError('Order already has production recorded');
    return this.store.update('orders', id, 'cancel', (o) => { o.status = 'cancelled'; o.cancelReason = str(reason, 'reason', { optional: true }); });
  }
}
