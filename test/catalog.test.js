import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, rejects } from './helpers.js';

test('products: SKU normalized, unique, validated; category required', async () => {
  const { app, category } = fixture();
  const p = app.products.createProduct({ sku: 'tbl-01', name: 'Table', categoryId: category.id, specifications: { w: 1 } });
  assert.equal(p.sku, 'TBL-01');
  await rejects(() => app.products.createProduct({ sku: 'TBL-01', name: 'x', categoryId: category.id }), 'CONFLICT');
  await rejects(() => app.products.createProduct({ sku: '!!', name: 'x', categoryId: category.id }), 'VALIDATION_ERROR');
  await rejects(() => app.products.createProduct({ sku: 'OK-1', name: 'x', categoryId: 'CAT-9999' }), 'NOT_FOUND');
  await rejects(() => app.products.updateProduct(p.id, { sku: 'NEW' }), 'VALIDATION_ERROR');
  assert.equal(app.products.listProducts({ categoryId: category.id }).length, 2);
  assert.equal(app.products.getBySku('tbl-01').id, p.id);
});

test('materials: receive uses weighted-average cost; adjust cannot go negative', async () => {
  const { app, materials } = fixture();
  const m = app.materials.receive(materials.varnish.id, { quantity: 40, unitCost: 30 }); // 40@20 + 40@30
  assert.equal(m.stockOnHand, 80);
  assert.equal(m.unitCost, 25);
  await rejects(() => app.materials.adjust(m.id, { delta: -81, reason: 'count' }), 'INSUFFICIENT_STOCK');
  assert.equal(app.materials.adjust(m.id, { delta: -80, reason: 'count' }).stockOnHand, 0);
  assert.ok(app.materials.lowStock().some((x) => x.id === m.id));
});

test('BOM: versions, single active, immutability, relationships', async () => {
  const { app, product, bom, materials } = fixture();
  assert.equal(bom.version, 1);
  const v2 = app.boms.newVersionFrom(bom.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'draft');
  app.boms.update(v2.id, { components: [{ materialId: materials.wood.id, quantity: 5 }] });
  app.boms.activate(v2.id);
  assert.equal(app.boms.get(bom.id).status, 'obsolete');
  assert.equal(app.boms.getActive(product.id).id, v2.id);
  await rejects(() => app.boms.update(v2.id, { notes: 'x' }), 'CONFLICT');
  await rejects(() => app.boms.activate(bom.id), 'CONFLICT');
  assert.equal(app.boms.whereUsed(materials.wood.id)[0].version, 2);
  assert.equal(app.boms.whereUsed(materials.screws.id).length, 0);
  assert.equal(app.boms.materialsFor(product.id).length, 1);
});

test('BOM validation: duplicate materials, unknown refs, empty activation', async () => {
  const { app, product, materials } = fixture();
  const dup = { materialId: materials.wood.id, quantity: 1 };
  await rejects(() => app.boms.create({ productId: product.id, components: [dup, dup] }), 'VALIDATION_ERROR');
  await rejects(() => app.boms.create({ productId: product.id, components: [{ materialId: 'MAT-9', quantity: 1 }] }), 'NOT_FOUND');
  const empty = app.boms.create({ productId: product.id });
  await rejects(() => app.boms.activate(empty.id), 'VALIDATION_ERROR');
});

test('work center capacity reflects availability', () => {
  const { app, workCenters } = fixture();
  const c = app.workCenters.capacity(workCenters.saw.id);
  assert.equal(c.minutesPerDay, 432); // 8h * 90%
  assert.throws(() => app.workCenters.create({ code: 'cut', name: 'dup' }), /already exists/);
});

test('audit history records create/update with actor and before/after', async () => {
  const { app, materials } = fixture();
  const { withActor } = await import('../src/store.js');
  withActor('alice', () => app.materials.update(materials.wood.id, { unitCost: 15 }));
  const h = app.store.history('materials', materials.wood.id);
  assert.deepEqual(h.map((x) => x.action), ['create', 'update']);
  assert.equal(h[0].actor, 'seed');
  assert.equal(h[1].actor, 'alice');
  assert.equal(h[1].before.unitCost, 12);
  assert.equal(h[1].after.unitCost, 15);
});
