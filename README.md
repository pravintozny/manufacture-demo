# manufacture-demo

Manufacturing & production planning system: product catalog, versioned BOMs, raw-material inventory,
production orders with finite-capacity scheduling, MRP, shop-floor execution, costing, quality and analytics.

Zero runtime dependencies. Requires Node.js >= 20 (developed on Node 24).

## Quick start

```bash
npm test                 # run the automated test suite (node:test)
npm run seed             # start API on :3000 with demo data (oak chair, 3-step routing)
PORT=8080 DATA_FILE=./data/db.json npm start   # optional JSON snapshot persistence
```

Send `x-actor: <name>` on requests; it is recorded in the audit log.

## Feature map

| # | Capability | Where | Key endpoints |
|---|-----------|-------|---------------|
| 1 | Product management (SKU, specs, categories) | `services/products.js` | `/products`, `/categories` |
| 2 | Bill of materials (versions, components, routing) | `services/boms.js` | `/boms`, `/boms/:id/activate`, `/materials/:id/where-used` |
| 3 | Raw-material inventory (stock, suppliers, cost, reorder) | `services/materials.js` | `/materials`, `/materials/:id/receive`, `/materials/low-stock` |
| 4 | Production planning (orders, schedule) | `services/planning.js` | `/production-orders`, `/planning/schedule` |
| 5 | Work centers (capacity, availability, time) | `services/workCenters.js` | `/work-centers`, `/work-centers/:id/capacity` |
| 6 | MRP (requirements, stock, shortages, purchase recs) | `domain/mrp.js` | `/planning/mrp` |
| 7 | Production execution | `services/execution.js` | `/production-orders/:id/progress` |
| 8 | Cost management | `services/costs.js` | `/production-orders/:id/cost`, `/products/:id/standard-cost` |
| 9 | Quality (inspection, defects, rework/reject) | `services/quality.js` | `/production-orders/:id/inspections`, `/dispositions`, `/quality/defects` |
| 10 | Analytics | `services/analytics.js` | `/analytics/dashboard?from=&to=` |
| - | Audit history | `store.js` | `/audit?entity=&entityId=` |

## Example flow

```bash
H='content-type: application/json'
curl -XPOST :3000/production-orders -H "$H" -H 'x-actor: planner' \
  -d '{"productId":"PRD-0001","quantity":10,"plannedStart":"2026-11-09T00:00:00Z","dueDate":"2026-11-13"}'
curl :3000/planning/mrp
curl -XPOST :3000/production-orders/PO-0001/release        # blocked with 409 INSUFFICIENT_STOCK if short
curl -XPOST :3000/production-orders/PO-0001/progress -H "$H" \
  -d '{"goodQty":8,"rejectedQty":1,"defectiveQty":1,"workCenterId":"WC-0002","laborHours":3,"machineHours":2.5}'
curl -XPOST :3000/production-orders/PO-0001/dispositions -H "$H" -d '{"reworkQty":1}'
curl -XPOST :3000/production-orders/PO-0001/complete
curl :3000/production-orders/PO-0001/cost
```

Errors are JSON: `{"error":{"code","message","details"}}` with 400 (validation), 404, 409 (conflict / insufficient stock), 405.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design, calculation rules and invariants.
