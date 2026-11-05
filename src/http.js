import http from 'node:http';
import { AppError, NotFoundError, ValidationError } from './errors.js';
import { withActor } from './store.js';

/** Route table: [method, path pattern, handler(app, {params, query, body})]. */
function routes(a) {
  const R = [];
  const on = (m, p, h) => R.push([m, new RegExp(`^${p.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), h]);

  on('GET', '/health', () => ({ status: 'ok' }));

  // Product management
  on('GET', '/categories', () => a.products.listCategories());
  on('POST', '/categories', ({ body }) => a.products.createCategory(body));
  on('GET', '/products', ({ query }) => a.products.listProducts(query));
  on('POST', '/products', ({ body }) => a.products.createProduct(body));
  on('GET', '/products/:id', ({ params }) => a.products.getProduct(params.id));
  on('PATCH', '/products/:id', ({ params, body }) => a.products.updateProduct(params.id, body));
  on('GET', '/products/:id/materials', ({ params }) => a.boms.materialsFor(params.id));
  on('GET', '/products/:id/standard-cost', ({ params }) => a.costs.standardCost(params.id));

  // BOM
  on('GET', '/boms', ({ query }) => a.boms.list(query));
  on('POST', '/boms', ({ body }) => a.boms.create(body));
  on('GET', '/boms/:id', ({ params }) => a.boms.get(params.id));
  on('PATCH', '/boms/:id', ({ params, body }) => a.boms.update(params.id, body));
  on('POST', '/boms/:id/activate', ({ params }) => a.boms.activate(params.id));
  on('POST', '/boms/:id/new-version', ({ params }) => a.boms.newVersionFrom(params.id));

  // Raw materials
  on('GET', '/materials', () => a.materials.list());
  on('POST', '/materials', ({ body }) => a.materials.create(body));
  on('GET', '/materials/low-stock', () => a.materials.lowStock());
  on('GET', '/materials/:id', ({ params }) => a.materials.get(params.id));
  on('PATCH', '/materials/:id', ({ params, body }) => a.materials.update(params.id, body));
  on('POST', '/materials/:id/receive', ({ params, body }) => a.materials.receive(params.id, body));
  on('POST', '/materials/:id/adjust', ({ params, body }) => a.materials.adjust(params.id, body));
  on('GET', '/materials/:id/where-used', ({ params }) => a.boms.whereUsed(params.id));

  // Work centers
  on('GET', '/work-centers', () => a.workCenters.list());
  on('POST', '/work-centers', ({ body }) => a.workCenters.create(body));
  on('GET', '/work-centers/:id', ({ params }) => a.workCenters.get(params.id));
  on('PATCH', '/work-centers/:id', ({ params, body }) => a.workCenters.update(params.id, body));
  on('GET', '/work-centers/:id/capacity', ({ params }) => a.workCenters.capacity(params.id));

  // Production planning, MRP, scheduling
  on('GET', '/production-orders', ({ query }) => a.planning.listOrders(query));
  on('POST', '/production-orders', ({ body }) => a.planning.createOrder(body));
  on('GET', '/production-orders/:id', ({ params }) => a.planning.getOrder(params.id));
  on('POST', '/production-orders/:id/release', ({ params }) => a.planning.release(params.id));
  on('POST', '/production-orders/:id/cancel', ({ params, body }) => a.planning.cancel(params.id, body?.reason));
  on('GET', '/planning/mrp', () => a.planning.mrp());
  on('GET', '/planning/schedule', () => a.planning.schedule());

  // Execution
  on('POST', '/production-orders/:id/start', ({ params }) => a.execution.start(params.id));
  on('POST', '/production-orders/:id/progress', ({ params, body }) => a.execution.recordProgress(params.id, body));
  on('GET', '/production-orders/:id/progress', ({ params }) => a.execution.progress(params.id));
  on('POST', '/production-orders/:id/complete', ({ params }) => a.execution.complete(params.id));
  on('GET', '/production-orders/:id/entries', ({ params }) => a.execution.listEntries(params.id));

  // Quality
  on('POST', '/production-orders/:id/inspections', ({ params, body }) => a.quality.inspect(params.id, body));
  on('GET', '/production-orders/:id/inspections', ({ params }) => a.quality.listInspections(params.id));
  on('POST', '/production-orders/:id/dispositions', ({ params, body }) => a.quality.disposition(params.id, body));
  on('GET', '/quality/defects', () => a.quality.defectSummary());

  // Cost & analytics
  on('GET', '/production-orders/:id/cost', ({ params }) => a.costs.orderCost(params.id));
  on('GET', '/analytics/dashboard', ({ query }) => a.analytics.dashboard(query));

  // Audit
  on('GET', '/audit', ({ query }) => a.store.history(query.entity, query.entityId));
  return R;
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new ValidationError('Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Invalid JSON body'); }
}

export function createServer(app) {
  const table = routes(app);
  return http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathMatched = false;
      for (const [method, re, handler] of table) {
        const m = re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (method !== req.method) continue;
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : undefined;
        const actor = req.headers['x-actor'] ? String(req.headers['x-actor']).slice(0, 80) : 'anonymous';
        const result = withActor(actor, () => handler({ params: m.groups ?? {}, query: Object.fromEntries(url.searchParams), body }));
        return send(req.method === 'POST' && result?.id && !/\/(release|start|complete|cancel|activate|receive|adjust)$/.test(url.pathname) ? 201 : 200, result ?? null);
      }
      throw pathMatched ? new AppError('Method not allowed', 405, 'METHOD_NOT_ALLOWED') : new NotFoundError(`No route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof AppError) return send(err.status, { error: { code: err.code, message: err.message, details: err.details } });
      console.error(err);
      send(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });
}
