import { round, money } from '../validate.js';

export class CostService {
  constructor(store, boms) { this.store = store; this.boms = boms; }

  /** Actual cost of an order from the execution ledger (material at consumption-time cost, labor, machine). */
  orderCost(orderId) {
    const o = this.store.require('orders', orderId, 'Production order');
    const entries = this.store.list('executions', (e) => e.orderId === orderId);
    const sum = (k) => money(entries.reduce((s, e) => s + e[k], 0));
    const materialCost = sum('materialCost'), laborCost = sum('laborCost'), machineCost = sum('machineCost');
    const totalCost = money(materialCost + laborCost + machineCost);
    const reworkCost = money(entries.filter((e) => e.type !== 'production').reduce((s, e) => s + e.materialCost + e.laborCost + e.machineCost, 0));
    return {
      orderId, productId: o.productId, sku: o.sku, status: o.status, goodQty: o.goodQty, rejectedQty: o.rejectedQty,
      materialCost, laborCost, machineCost, totalCost, reworkCost,
      // Cost of rejects is absorbed by good units, so cost/unit reflects true yield loss.
      costPerFinishedUnit: o.goodQty > 0 ? money(totalCost / o.goodQty) : null,
      laborHours: round(entries.reduce((s, e) => s + e.laborHours, 0), 4),
      machineHours: round(entries.reduce((s, e) => s + e.machineHours, 0), 4),
    };
  }

  /** Standard (estimated) unit cost for a product from its active BOM at current material cost and routing rates. */
  standardCost(productId) {
    const bom = this.boms.getActive(productId);
    if (!bom) return null;
    const materialCost = money(bom.components.reduce((s, c) => {
      const m = this.store.get('materials', c.materialId);
      return s + c.quantity * (1 + c.scrapPercent / 100) * m.unitCost;
    }, 0));
    let laborCost = 0, machineCost = 0;
    for (const op of bom.operations) {
      const wc = this.store.get('workCenters', op.workCenterId);
      const hours = op.runMinutesPerUnit / 60;
      laborCost += hours * wc.laborRatePerHour;
      machineCost += hours * wc.machineRatePerHour;
    }
    laborCost = money(laborCost); machineCost = money(machineCost);
    return { productId, bomId: bom.id, bomVersion: bom.version, materialCost, laborCost, machineCost, totalCost: money(materialCost + laborCost + machineCost), note: 'Excludes one-off setup time' };
  }
}
