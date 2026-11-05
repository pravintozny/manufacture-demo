import { withActor } from './store.js';

/** Demo data: a wooden chair with a 3-step routing. Used by `npm run seed` and tests. */
export function seed(app) {
  return withActor('seed', () => {
    const cat = app.products.createCategory({ name: 'Furniture' });
    const wood = app.materials.create({ code: 'WOOD-OAK', name: 'Oak plank', unit: 'm', unitCost: 12, stockOnHand: 500, reorderLevel: 100, reorderQty: 200, supplier: { name: 'Timber Co', leadTimeDays: 7 } });
    const screws = app.materials.create({ code: 'SCREW-M5', name: 'M5 screw', unit: 'pcs', unitCost: 0.1, stockOnHand: 5000, reorderLevel: 1000, reorderQty: 5000, supplier: { name: 'Fastener Ltd', leadTimeDays: 3 } });
    const varnish = app.materials.create({ code: 'VARNISH', name: 'Varnish', unit: 'l', unitCost: 20, stockOnHand: 40, reorderLevel: 10, reorderQty: 20, supplier: { name: 'Coatings Inc', leadTimeDays: 5 } });
    const saw = app.workCenters.create({ code: 'CUT', name: 'Cutting', type: 'machine', hoursPerDay: 8, availabilityPct: 90, laborRatePerHour: 20, machineRatePerHour: 35 });
    const asm = app.workCenters.create({ code: 'ASM', name: 'Assembly', type: 'assembly', hoursPerDay: 8, availabilityPct: 100, laborRatePerHour: 22, machineRatePerHour: 5 });
    const fin = app.workCenters.create({ code: 'FIN', name: 'Finishing', type: 'manual', hoursPerDay: 8, availabilityPct: 95, laborRatePerHour: 24, machineRatePerHour: 8 });
    const chair = app.products.createProduct({ sku: 'CHAIR-OAK-01', name: 'Oak dining chair', categoryId: cat.id, specifications: { heightCm: 90, weightKg: 6.5, finish: 'natural varnish' } });
    const bom = app.boms.create({
      productId: chair.id,
      components: [
        { materialId: wood.id, quantity: 4, scrapPercent: 5 },
        { materialId: screws.id, quantity: 16 },
        { materialId: varnish.id, quantity: 0.25 },
      ],
      operations: [
        { sequence: 10, name: 'Cut', workCenterId: saw.id, setupMinutes: 30, runMinutesPerUnit: 12 },
        { sequence: 20, name: 'Assemble', workCenterId: asm.id, setupMinutes: 15, runMinutesPerUnit: 20 },
        { sequence: 30, name: 'Finish', workCenterId: fin.id, setupMinutes: 10, runMinutesPerUnit: 15 },
      ],
    });
    app.boms.activate(bom.id);
    return { category: cat, materials: { wood, screws, varnish }, workCenters: { saw, asm, fin }, product: chair, bom };
  });
}
