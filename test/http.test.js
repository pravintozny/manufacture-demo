import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createServer } from '../src/http.js';

test('HTTP API end-to-end', async (t) => {
  const server = createServer(createApp()).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, actor = 'tester') => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-actor': actor }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  const cat = await call('POST', '/categories', { name: 'Widgets' });
  assert.equal(cat.status, 201);
  const mat = (await call('POST', '/materials', { code: 'steel', name: 'Steel', unit: 'kg', unitCost: 2, stockOnHand: 100 })).body;
  const wc = (await call('POST', '/work-centers', { code: 'press', name: 'Press', machineRatePerHour: 10 })).body;
  const prod = (await call('POST', '/products', { sku: 'wid-1', name: 'Widget', categoryId: cat.body.id })).body;
  const bom = (await call('POST', '/boms', { productId: prod.id, components: [{ materialId: mat.id, quantity: 2 }], operations: [{ workCenterId: wc.id, runMinutesPerUnit: 6 }] })).body;
  assert.equal((await call('POST', `/boms/${bom.id}/activate`)).body.status, 'active');
  const po = (await call('POST', '/production-orders', { productId: prod.id, quantity: 10, plannedStart: '2026-11-09T00:00:00Z', dueDate: '2026-11-10' })).body;
  assert.equal((await call('GET', '/planning/mrp')).body.materials[0].grossRequirement, 20);
  assert.equal((await call('POST', `/production-orders/${po.id}/release`)).body.status, 'released');
  assert.equal((await call('POST', `/production-orders/${po.id}/progress`, { goodQty: 10 })).status, 201);
  const cost = (await call('GET', `/production-orders/${po.id}/cost`)).body;
  assert.equal(cost.materialCost, 40);
  assert.equal(cost.costPerFinishedUnit, 4);

  const bad = await call('POST', `/production-orders/${po.id}/progress`, { goodQty: 1 });
  assert.equal(bad.status, 400); // exceeds planned quantity
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('DELETE', '/products')).status, 405);
  const audit = (await call('GET', `/audit?entity=orders&entityId=${po.id}`)).body;
  assert.ok(audit.length >= 3 && audit.every((a) => a.actor === 'tester'));
});
