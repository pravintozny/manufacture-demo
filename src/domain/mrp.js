import { allocate, toMinutes, toIso } from './scheduling.js';
import { dailyCapacityMinutes } from '../services/workCenters.js';
import { round, money } from '../validate.js';

export const OPEN_STATUSES = ['planned', 'released', 'in_progress'];
const startedQty = (o) => o.goodQty + o.rejectedQty + o.defectiveQty;
export const remainingQty = (o) => Math.max(0, o.quantity - startedQty(o));

/**
 * Dependency-aware plan over ALL open production orders.
 *  - Orders are processed in (plannedStart, priority, id) order; each order draws from the stock left by earlier ones,
 *    so a shortage caused by an earlier order is visible to later orders.
 *  - Operations of an order run strictly in sequence (each starts after the previous ends), and each work center
 *    is finite capacity: operations from different orders queue behind each other.
 * Pure function: it never mutates its inputs.
 */
export function buildPlan({ orders, boms, workCenters, materials, now = new Date() }) {
  const bomById = new Map(boms.map((b) => [b.id, b]));
  const wcById = new Map(workCenters.map((w) => [w.id, w]));
  const matById = new Map(materials.map((m) => [m.id, m]));
  const stock = new Map(materials.map((m) => [m.id, m.stockOnHand]));
  const wcFree = new Map();

  const open = orders.filter((o) => OPEN_STATUSES.includes(o.status))
    .sort((a, b) => a.plannedStart.localeCompare(b.plannedStart) || a.priority - b.priority || a.id.localeCompare(b.id));

  const demand = new Map(); // materialId -> {gross, needBy}
  const planOrders = open.map((order) => {
    const bom = bomById.get(order.bomId);
    const remaining = remainingQty(order);
    const issues = [];

    const requirements = bom.components.map((c) => {
      const required = round(c.quantity * (1 + c.scrapPercent / 100) * remaining);
      const avail = stock.get(c.materialId) ?? 0;
      const allocated = round(Math.min(avail, required));
      const shortage = round(required - allocated);
      stock.set(c.materialId, round(avail - allocated));
      const m = matById.get(c.materialId);
      if (shortage > 0) issues.push({ type: 'MATERIAL_SHORTAGE', materialId: c.materialId, code: m?.code, shortage });
      return { materialId: c.materialId, code: m?.code, required, allocated, shortage, unitCost: m?.unitCost ?? 0, estimatedCost: money(required * (m?.unitCost ?? 0)) };
    });

    // Schedule
    let prevEnd = toMinutes(order.plannedStart);
    const operations = [];
    for (const op of bom.operations) {
      const wc = wcById.get(op.workCenterId);
      const duration = (startedQty(order) === 0 ? op.setupMinutes : 0) + op.runMinutesPerUnit * remaining;
      if (!wc || wc.status !== 'active') {
        issues.push({ type: 'WORK_CENTER_UNAVAILABLE', workCenterId: op.workCenterId, status: wc?.status ?? 'missing' });
        operations.push({ sequence: op.sequence, name: op.name, workCenterId: op.workCenterId, durationMinutes: duration, start: null, end: null });
        continue;
      }
      const { start, end } = allocate(dailyCapacityMinutes(wc), Math.max(prevEnd, wcFree.get(wc.id) ?? 0), duration);
      wcFree.set(wc.id, end);
      prevEnd = end;
      operations.push({ sequence: op.sequence, name: op.name, workCenterId: wc.id, durationMinutes: round(duration, 2), start: toIso(start), end: toIso(end) });
    }
    const timed = operations.filter((o) => o.start);
    const plannedStart = timed.length ? timed[0].start : order.plannedStart;
    const plannedEnd = timed.length ? timed[timed.length - 1].end : order.plannedStart;
    const dueEnd = new Date(order.dueDate).getTime() / 60000 + 1440 - 1;
    const late = timed.length > 0 && toMinutes(plannedEnd) > dueEnd;
    if (late) issues.push({ type: 'LATE', plannedEnd, dueDate: order.dueDate });

    for (const r of requirements) {
      const d = demand.get(r.materialId) ?? { gross: 0, shortageNeedBy: null, firstNeedBy: null };
      d.gross = round(d.gross + r.required);
      d.firstNeedBy ??= plannedStart;
      if (r.shortage > 0) d.shortageNeedBy ??= plannedStart;
      demand.set(r.materialId, d);
    }
    return {
      orderId: order.id, number: order.id, productId: order.productId, status: order.status, remainingQty: remaining,
      requirements, operations, plannedStart, plannedEnd, late, issues,
      feasible: !issues.some((i) => i.type !== 'LATE'),
    };
  });

  // Material roll-up and purchase recommendations
  const nowIso = now.toISOString();
  const materialsOut = [];
  const purchaseRecommendations = [];
  for (const m of materials) {
    const d = demand.get(m.id);
    const gross = d?.gross ?? 0;
    const shortage = round(Math.max(0, gross - m.stockOnHand));
    const projectedBalance = round(m.stockOnHand - gross);
    const belowReorder = m.reorderLevel > 0 && projectedBalance <= m.reorderLevel; // reorder point triggers at-or-below
    materialsOut.push({
      materialId: m.id, code: m.code, name: m.name, unit: m.unit, stockOnHand: m.stockOnHand,
      grossRequirement: gross, availableStock: m.stockOnHand, shortage, projectedBalance, reorderLevel: m.reorderLevel,
    });
    if (shortage > 0 || belowReorder) {
      const netNeed = round(Math.max(shortage, m.reorderLevel - projectedBalance));
      const lot = m.reorderQty > 0 ? m.reorderQty : 0;
      const quantity = lot ? round(Math.ceil(netNeed / lot - 1e-9) * lot) : netNeed;
      const needBy = d?.shortageNeedBy ?? d?.firstNeedBy ?? nowIso;
      const lead = m.supplier?.leadTimeDays ?? 0;
      const orderBy = toIso(toMinutes(needBy) - lead * 1440);
      purchaseRecommendations.push({
        materialId: m.id, code: m.code, name: m.name, unit: m.unit,
        reason: shortage > 0 ? 'SHORTAGE' : 'BELOW_REORDER_LEVEL',
        shortage, projectedBalance, quantity, unitCost: m.unitCost, estimatedCost: money(quantity * m.unitCost),
        supplier: m.supplier, needBy, orderBy, overdue: orderBy < nowIso,
      });
    }
  }

  return {
    generatedAt: nowIso,
    orders: planOrders,
    materials: materialsOut,
    shortages: materialsOut.filter((m) => m.shortage > 0),
    purchaseRecommendations,
  };
}
