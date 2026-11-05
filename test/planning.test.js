import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/domain/scheduling.js';
import { fixture, order, rejects } from './helpers.js';

test('allocate: spills over shift end and skips weekends', () => {
  const fri = Date.parse('2026-11-06T08:00:00Z') / 60000; // Friday
  const { start, end } = allocate(480, fri, 600); // 10h on 8h shifts
  assert.equal(new Date(start * 60000).toISOString(), '2026-11-06T08:00:00.000Z');
  assert.equal(new Date(end * 60000).toISOString(), '2026-11-09T10:00:00.000Z'); // Monday
});

test('order pins active BOM; requires an active BOM', async () => {
  const { app, product, bom, category } = fixture();
  const o = order({ app, product });
  assert.equal(o.bomId, bom.id);
  const p2 = app.products.createProduct({ sku: 'NOBOM', name: 'x', categoryId: category.id });
  await rejects(() => app.planning.createOrder({ productId: p2.id, quantity: 1, plannedStart: '2026-11-09T00:00:00Z', dueDate: '2026-11-10' }), 'CONFLICT');
  await rejects(() => order({ app, product }, { quantity: 0 }), 'VALIDATION_ERROR');
  await rejects(() => order({ app, product }, { dueDate: '2026-11-01' }), 'VALIDATION_ERROR');
});

test('MRP: required quantities include scrap; sequential stock allocation across orders', () => {
  const f = fixture();
  // wood stock 500; each chair needs 4.2 m. 100 chairs = 420, next 30 chairs = 126 -> shortage 46
  const a = order(f, { quantity: 100 });
  const b = order(f, { quantity: 30, plannedStart: '2026-11-10T00:00:00Z' });
  const mrp = f.app.planning.mrp();
  const ra = mrp.orders.find((o) => o.orderId === a.id).requirements.find((r) => r.code === 'WOOD-OAK');
  const rb = mrp.orders.find((o) => o.orderId === b.id).requirements.find((r) => r.code === 'WOOD-OAK');
  assert.equal(ra.required, 420); assert.equal(ra.shortage, 0);
  assert.equal(rb.required, 126); assert.equal(rb.allocated, 80); assert.equal(rb.shortage, 46);
  const wood = mrp.materials.find((m) => m.code === 'WOOD-OAK');
  assert.equal(wood.grossRequirement, 546);
  assert.equal(wood.shortage, 46);
  assert.equal(wood.projectedBalance, -46);
  // Purchase rec: need max(shortage, reorderLevel - projected) = 146 -> lot size 200
  const rec = mrp.purchaseRecommendations.find((r) => r.code === 'WOOD-OAK');
  assert.equal(rec.reason, 'SHORTAGE');
  assert.equal(rec.quantity, 200);
  assert.equal(rec.estimatedCost, 2400);
  assert.equal(rec.supplier.name, 'Timber Co');
  // Order b's cutting queues behind order a on the finite-capacity work center, so need-by is its scheduled start.
  const bStart = f.app.planning.plan().orders.find((o) => o.orderId === b.id).plannedStart;
  assert.equal(rec.needBy, bStart);
  assert.ok(bStart > '2026-11-10T08:00:00.000Z');
  assert.equal(Date.parse(rec.needBy) - Date.parse(rec.orderBy), 7 * 86400000); // 7-day lead time
});

test('MRP: recommends replenishment when projected balance falls to reorder level without shortage', () => {
  const f2 = fixture();
  order(f2, { quantity: 100 }); // varnish 25 -> projected 15, reorder level 10: fine
  assert.ok(!f2.app.planning.mrp().purchaseRecommendations.some((r) => r.code === 'VARNISH'));
  order(f2, { quantity: 50 }); // varnish total 37.5 -> projected 2.5 <= 10
  const rec = f2.app.planning.mrp().purchaseRecommendations.find((r) => r.code === 'VARNISH');
  assert.equal(rec.reason, 'BELOW_REORDER_LEVEL');
  assert.equal(rec.quantity, 20); // need 10-2.5=7.5 -> one lot of 20
});

test('release is blocked by insufficient stock and succeeds once stock is received', async () => {
  const f = fixture();
  const o = order(f, { quantity: 200 }); // wood 840 > 500
  const e = await rejects(() => f.app.planning.release(o.id), 'INSUFFICIENT_STOCK');
  assert.equal(e.details.shortages[0].code, 'WOOD-OAK');
  assert.equal(e.details.shortages[0].shortage, 340);
  f.app.materials.receive(f.materials.wood.id, { quantity: 400 });
  await rejects(() => f.app.planning.release(o.id), 'INSUFFICIENT_STOCK'); // varnish 50 > 40 still short
  f.app.materials.receive(f.materials.varnish.id, { quantity: 10 });
  assert.equal(f.app.planning.release(o.id).status, 'released');
});

test('release respects earlier orders claim on stock', async () => {
  const f = fixture();
  const first = order(f, { quantity: 100 });
  const second = order(f, { quantity: 30, plannedStart: '2026-11-10T00:00:00Z' });
  await rejects(() => f.app.planning.release(second.id), 'INSUFFICIENT_STOCK');
  assert.equal(f.app.planning.release(first.id).status, 'released');
});

test('schedule: operations are sequential and work centers are finite capacity', () => {
  const f = fixture();
  const a = order(f, { quantity: 10 });
  const b = order(f, { quantity: 10 });
  const s = f.app.planning.schedule().orders;
  const ops = (id) => s.find((o) => o.orderId === id).operations;
  for (const id of [a.id, b.id]) for (let i = 1; i < 3; i++) assert.ok(ops(id)[i].start >= ops(id)[i - 1].end);
  // order b cutting waits for order a cutting on the same work center
  assert.ok(ops(b.id)[0].start >= ops(a.id)[0].end);
});

test('late orders are flagged; unavailable work center blocks release', async () => {
  const f = fixture();
  const o = order(f, { quantity: 100, dueDate: '2026-11-09' });
  assert.equal(f.app.planning.getOrder(o.id).plan.late, true);
  f.app.workCenters.update(f.workCenters.asm.id, { status: 'maintenance' });
  const e = await rejects(() => f.app.planning.release(o.id), 'CONFLICT');
  assert.match(e.message, /WORK_CENTER_UNAVAILABLE/);
});

test('cancel only before production', () => {
  const f = fixture();
  const o = order(f);
  assert.equal(f.app.planning.cancel(o.id, 'customer').status, 'cancelled');
  assert.throws(() => f.app.planning.cancel(o.id), /Cannot cancel/);
});
