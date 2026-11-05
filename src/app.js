import { Store } from './store.js';
import { ProductService } from './services/products.js';
import { MaterialService } from './services/materials.js';
import { WorkCenterService } from './services/workCenters.js';
import { BomService } from './services/boms.js';
import { PlanningService } from './services/planning.js';
import { ExecutionService } from './services/execution.js';
import { QualityService } from './services/quality.js';
import { CostService } from './services/costs.js';
import { AnalyticsService } from './services/analytics.js';

/** Composition root: wires the store and all domain services. */
export function createApp({ file = null, now } = {}) {
  const store = new Store({ file, now });
  const products = new ProductService(store);
  const materials = new MaterialService(store);
  const workCenters = new WorkCenterService(store);
  const boms = new BomService(store);
  const planning = new PlanningService(store, boms);
  const execution = new ExecutionService(store, boms);
  const quality = new QualityService(store, execution);
  const costs = new CostService(store, boms);
  const analytics = new AnalyticsService(store, costs);
  return { store, products, materials, workCenters, boms, planning, execution, quality, costs, analytics };
}
