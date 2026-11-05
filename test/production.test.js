import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, order, rejects } from './helpers.js';

function released(f, over) {
  const o = order(f, over);
  f.app.planning.release(o.id);
  return o;
}

test('progress backflushes materials, validates quantity and stock, auto-starts the order', async () => {
  const f = fixture();
  const o = released(f, { quantity: 10 });
  const e = f.app.execution.recordProgress(o.id, { goodQty: 4, rejectedQty: 1, workCenterId: f.workCenters.asm.id, laborHours: 2, machineHours: 1.5 });
  assert.equal(e.consumed.find((c) => c.code === 'WOOD-OAK').quantity, 21); // 5 units * 4.2
  assert.equal(f.app.materials.get(f.materials.wood.id).stockOnHand, 479);
  const p = f.app.execution.progress(o.id);
  assert.equal(p.status, 'in_progress');
  assert.equal(p.remainingQty, 5);
  assert.equal(p.percentComplete, 50);
  await rejects(() => f.app.execution.recordProgress(o.id, { goodQty: 6 }), 'VALIDATION_ERROR');
  f.app.execution.recordProgress(o.id, { goodQty: 5 });
  await rejects(() => f.app.execution.recordProgress(o.id, { goodQty: 1 }), 'VALIDATION_ERROR');
});

test('actual consumption must be covered by stock; nothing changes on failure', async () => {
  const f = fixture();
  const o = released(f, { quantity: 10 });
  const before = f.app.store.list('executions').length;
  const e = await rejects(() => f.app.execution.recordProgress(o.id, { goodQty: 1, consumed: [{ materialId: f.materials.varnish.id, quantity: 41 }, { materialId: f.materials.wood.id, quantity: 4 }] }), 'INSUFFICIENT_STOCK');
  assert.equal(e.details.shortages[0].code, 'VARNISH');
  assert.equal(f.app.store.list('executions').length, before);
  assert.equal(f.app.materials.get(f.materials.wood.id).stockOnHand, 500);
  assert.equal(f.app.execution.progress(o.id).goodQty, 0);
});

test('hours require a work center', async () => {
  const f = fixture();
  const o = released(f);
  await rejects(() => f.app.execution.recordProgress(o.id, { goodQty: 1, laborHours: 1 }), 'VALIDATION_ERROR');
});

test('cost: material + labor + machine, cost per finished unit absorbs rejects', () => {
  const f = fixture();
  const o = released(f, { quantity: 10 });
  const asm = f.workCenters.asm; // labor 22, machine 5
  f.app.execution.recordProgress(o.id, { goodQty: 8, rejectedQty: 2, workCenterId: asm.id, laborHours: 5, machineHours: 4 });
  const c = f.app.costs.orderCost(o.id);
  // materials for 10 units: wood 42*12=504, screws 160*.1=16, varnish 2.5*20=50
  assert.equal(c.materialCost, 570);
  assert.equal(c.laborCost, 110);
  assert.equal(c.machineCost, 20);
  assert.equal(c.totalCost, 700);
  assert.equal(c.costPerFinishedUnit, 87.5);
  const std = f.app.costs.standardCost(f.product.id);
  assert.equal(std.materialCost, 57); // 4.2*12 + 1.6 + 5
  assert.equal(std.laborCost, round((12 * 20 + 20 * 22 + 15 * 24) / 60));
});
const round = (n) => Math.round(n * 1e4) / 1e4;

test('quality: inspection moves failed units to defective; rework/reject dispositions; completion gate', async () => {
  const f = fixture();
  const o = released(f, { quantity: 10 });
  f.app.execution.recordProgress(o.id, { goodQty: 10 });
  await rejects(() => f.app.quality.inspect(o.id, { inspectedQty: 11 }), 'VALIDATION_ERROR');
  await rejects(() => f.app.quality.inspect(o.id, { inspectedQty: 5, failedQty: 2 }), 'VALIDATION_ERROR'); // needs a defect
  const qi = f.app.quality.inspect(o.id, { inspectedQty: 10, failedQty: 3, inspector: 'sam', defects: [{ code: 'scratch', quantity: 2 }, { code: 'crack', quantity: 1 }] });
  assert.equal(qi.result, 'fail');
  let p = f.app.execution.progress(o.id);
  assert.deepEqual([p.goodQty, p.defectiveQty], [7, 3]);
  await rejects(() => f.app.execution.complete(o.id), 'CONFLICT');
  await rejects(() => f.app.quality.disposition(o.id, { reworkQty: 4 }), 'VALIDATION_ERROR');
  f.app.quality.disposition(o.id, { inspectionId: qi.id, reworkQty: 2, rejectQty: 1, workCenterId: f.workCenters.fin.id, laborHours: 1 });
  p = f.app.execution.progress(o.id);
  assert.deepEqual([p.goodQty, p.rejectedQty, p.defectiveQty], [9, 1, 0]);
  assert.deepEqual(f.app.quality.listInspections(o.id)[0].disposition, { reworked: 2, rejected: 1, pending: 0 });
  assert.equal(f.app.costs.orderCost(o.id).reworkCost, 24);
  assert.equal(f.app.quality.defectSummary()[0].code, 'SCRATCH');
  assert.equal(f.app.execution.complete(o.id).status, 'completed');
  await rejects(() => f.app.execution.recordProgress(o.id, { goodQty: 1 }), 'CONFLICT');
});

test('analytics: yield, defect rate, utilization, costs', () => {
  const f = fixture();
  const o = released(f, { quantity: 10 });
  const at = '2026-11-09T12:00:00Z';
  f.app.execution.recordProgress(o.id, { goodQty: 8, rejectedQty: 1, defectiveQty: 1, workCenterId: f.workCenters.saw.id, laborHours: 3, machineHours: 4.32, recordedAt: at });
  const d = f.app.analytics.dashboard({ from: '2026-11-09T00:00:00Z', to: '2026-11-09T23:59:59Z' });
  assert.equal(d.output.unitsStarted, 10);
  assert.equal(d.productionEfficiency.yieldPct, 80);
  assert.equal(d.defectRatePct, 20);
  // standard hours = 10 units * 47 min / 60; actual 4.32h
  assert.equal(d.productionEfficiency.standardHours, round(470 / 60));
  const saw = d.workCenterUtilization.find((w) => w.code === 'CUT');
  assert.equal(saw.availableHours, 7.2); // 1 weekday * 8h * 90%
  assert.equal(saw.utilizationPct, 60);
  assert.equal(d.costs.labor, 60);
  assert.equal(d.costs.machine, round(4.32 * 35));
  // Useful material value for 8 good units (no scrap allowance): wood 32*12 + screws 128*.1 + varnish 2*20 = 436.8
  // vs consumed for 10 units incl. scrap allowance: 570 -> 76.63%
  assert.equal(d.materialUtilizationPct, 76.63);
  assert.equal(d.costs.costPerFinishedUnit, round(d.costs.total / 8));
});

test('audit trail covers stock consumption and order lifecycle', () => {
  const f = fixture();
  const o = released(f);
  f.app.execution.recordProgress(o.id, { goodQty: 1 });
  const actions = f.app.store.history('orders', o.id).map((h) => h.action);
  assert.deepEqual(actions, ['create', 'release', 'progress:production']);
  assert.ok(f.app.store.history('materials', f.materials.wood.id).some((h) => h.action === `consume:${o.id}`));
});
