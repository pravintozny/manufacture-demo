import { round } from '../validate.js';
import { dailyCapacityMinutes } from './workCenters.js';

const pct = (n, d) => (d > 0 ? round((n / d) * 100, 2) : null);

function weekdaysBetween(fromIso, toIso) {
  let n = 0;
  const end = new Date(toIso);
  for (let d = new Date(fromIso); d <= end; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export class AnalyticsService {
  constructor(store, costs) { this.store = store; this.costs = costs; }

  /** All KPIs for entries recorded within [from, to] (defaults: whole history). */
  dashboard({ from, to } = {}) {
    const lo = from ?? '0000-01-01T00:00:00.000Z';
    const hi = to ?? '9999-12-31T23:59:59.999Z';
    const entries = this.store.list('executions', (e) => e.recordedAt >= lo && e.recordedAt <= hi);
    const orders = new Map(this.store.list('orders').map((o) => [o.id, o]));
    const boms = new Map(this.store.list('boms').map((b) => [b.id, b]));

    // ---- output / defects (production entries add units; rework/rejection entries move them) ----
    // Ledger entries carry signed deltas, so sums are net of rework/rejection moves.
    let good = 0, rejected = 0, defective = 0, started = 0, failedFirstPass = 0, reworked = 0;
    for (const e of entries) {
      good += e.goodQty; rejected += e.rejectedQty; defective += e.defectiveQty;
      if (e.type === 'production') started += e.goodQty + e.rejectedQty + e.defectiveQty;
      if (e.type === 'inspection' || (e.type === 'production' && e.defectiveQty > 0)) failedFirstPass += e.defectiveQty;
      if (e.type === 'rework') reworked += e.goodQty;
    }
    // ---- cost ----
    const cost = { material: 0, labor: 0, machine: 0 };
    for (const e of entries) { cost.material += e.materialCost; cost.labor += e.laborCost; cost.machine += e.machineCost; }
    const total = cost.material + cost.labor + cost.machine;

    // ---- time efficiency: standard run hours for units started vs actual machine hours ----
    let standardHours = 0, actualHours = 0;
    for (const e of entries) {
      actualHours += e.machineHours;
      if (e.type !== 'production') continue;
      const bom = boms.get(orders.get(e.orderId)?.bomId);
      const units = e.goodQty + e.rejectedQty + e.defectiveQty;
      if (bom) standardHours += (bom.operations.reduce((s, op) => s + op.runMinutesPerUnit, 0) * units) / 60;
    }

    // ---- material utilization (value-weighted): theoretical need for good units / actual consumption, per order & material ----
    let usefulValue = 0, consumedValue = 0;
    const perOrder = new Map();
    for (const e of entries) for (const c of e.consumed) {
      const k = `${e.orderId}|${c.materialId}`;
      const r = perOrder.get(k) ?? { orderId: e.orderId, materialId: c.materialId, qty: 0, value: 0 };
      r.qty += c.quantity; r.value += c.cost; perOrder.set(k, r);
    }
    for (const r of perOrder.values()) {
      const o = orders.get(r.orderId);
      const comp = boms.get(o.bomId)?.components.find((c) => c.materialId === r.materialId);
      const theoretical = comp ? comp.quantity * o.goodQty : 0;
      const avg = r.qty > 0 ? r.value / r.qty : 0;
      usefulValue += Math.min(theoretical, r.qty) * avg;
      consumedValue += r.value;
    }

    // ---- work center utilization ----
    const fromIso = from ?? entries.map((e) => e.recordedAt).sort()[0];
    const toIso = to ?? entries.map((e) => e.recordedAt).sort().at(-1);
    const days = fromIso && toIso ? weekdaysBetween(fromIso, toIso) : 0;
    const workCenters = this.store.list('workCenters').map((wc) => {
      const used = entries.filter((e) => e.workCenterId === wc.id).reduce((s, e) => s + e.machineHours, 0);
      const available = (days * dailyCapacityMinutes(wc) * wc.machines) / 60;
      return { workCenterId: wc.id, code: wc.code, usedHours: round(used, 4), availableHours: round(available, 4), utilizationPct: pct(used, available) };
    });

    // ---- per product cost ----
    const byProduct = {};
    for (const e of entries) {
      const p = (byProduct[e.productId] ??= { productId: e.productId, totalCost: 0, goodQty: 0 });
      p.totalCost += e.materialCost + e.laborCost + e.machineCost;
      p.goodQty += e.goodQty;
    }
    const costByProduct = Object.values(byProduct).map((p) => ({ ...p, totalCost: round(p.totalCost, 4), costPerFinishedUnit: p.goodQty > 0 ? round(p.totalCost / p.goodQty, 4) : null }));

    return {
      period: { from: from ?? null, to: to ?? null },
      output: { unitsStarted: started, goodQty: good, rejectedQty: rejected, pendingDefectiveQty: defective, reworkedQty: reworked },
      productionEfficiency: { yieldPct: pct(good, started), timeEfficiencyPct: pct(standardHours, actualHours), standardHours: round(standardHours, 4), actualMachineHours: round(actualHours, 4) },
      materialUtilizationPct: pct(usefulValue, consumedValue),
      defectRatePct: pct(rejected + defective, started),
      firstPassDefectRatePct: pct(failedFirstPass, started),
      costs: { material: round(cost.material, 4), labor: round(cost.labor, 4), machine: round(cost.machine, 4), total: round(total, 4), costPerFinishedUnit: good > 0 ? round(total / good, 4) : null },
      costByProduct,
      workCenterUtilization: workCenters,
    };
  }
}
