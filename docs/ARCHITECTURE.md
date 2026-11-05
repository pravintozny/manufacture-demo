# Architecture

## Layers

```
HTTP (src/http.js)  ->  Services (src/services/*)  ->  Domain calcs (src/domain/*)  ->  Store (src/store.js)
```

* **http.js** – route table, JSON parsing (1 MB cap), error mapping, `x-actor` header -> `AsyncLocalStorage`.
* **services** – one class per bounded area; validate input (`src/validate.js`), enforce business rules, mutate via the store.
* **domain** – pure functions with no I/O: `scheduling.js` (finite-capacity calendar) and `mrp.js` (plan + MRP).
* **store.js** – in-memory collections with optional atomic JSON snapshot (`DATA_FILE`). Reads return deep copies; all writes go through `insert`/`update`, which append to the **audit log**.
* **app.js** – composition root. Swapping the store for a database means re-implementing `Store`'s small API (`insert/get/list/update/history`).

## Data model

| Collection | Notes |
|---|---|
| categories, products | SKU unique + immutable, free-form `specifications`, `active/discontinued` |
| materials | `unitCost` (weighted average on receipt), `stockOnHand`, `reorderLevel/Qty`, `supplier{leadTimeDays}` |
| workCenters | `hoursPerDay`, `availabilityPct`, `machines`, labor & machine hourly rates, `active/maintenance/inactive` |
| boms | per product, `version` auto-increments, `draft -> active -> obsolete`; holds `components` (qty, scrap%) and routing `operations` (sequence, work center, setup + run minutes) |
| orders | production order; pins `bomId`/`bomVersion` at creation; counters `goodQty/rejectedQty/defectiveQty/inspectedPassedQty` |
| executions | append-only ledger of signed unit deltas, consumed materials (with cost snapshot), hours and costs |
| inspections | pass/fail, defect codes, disposition tracking |
| audit | `{at, actor, entity, entityId, action, before, after}` for every change |

## Dependency-aware production calculations

`buildPlan` (domain/mrp.js) plans **all open orders together**, which is what makes it dependency-aware:

1. **Order sequencing** – orders are processed by `(plannedStart, priority, id)`.
2. **Material dependency** – stock is a shared pool; each order draws what remains after earlier orders, so an early big order creates shortages for later ones. Requirement per component = `qty x (1 + scrap%) x remainingUnits`.
3. **Operation dependency** – operations run in routing sequence; operation *n+1* cannot start before *n* ends.
4. **Capacity dependency** – work centers are finite capacity (Mon–Fri, 08:00 UTC shift of `hoursPerDay x availability%`). Operations from different orders queue on the same work center; work spills into following working days.
5. **Resource availability** – a work center not `active` yields a `WORK_CENTER_UNAVAILABLE` issue.
6. **Lateness** – `LATE` is flagged when the last operation ends after the due date (non-blocking).
7. **BOM versioning** – an order keeps its pinned BOM even if a new version is activated later.

Remaining quantity for an in-flight order is `quantity - (good + rejected + defective)`; setup time is only charged before production starts.

### MRP & purchase recommendations

Per material: `gross = Σ requirements`, `shortage = max(0, gross - stock)`, `projected = stock - gross`.
A recommendation is raised when `shortage > 0` (`SHORTAGE`) or `reorderLevel > 0 && projected <= reorderLevel` (`BELOW_REORDER_LEVEL`):
`netNeed = max(shortage, reorderLevel - projected)`, rounded **up to a multiple of `reorderQty`** (lot size).
`needBy` = scheduled start of the first order that is short; `orderBy = needBy - supplier.leadTimeDays` and `overdue` if already past.
Open purchase orders/inbound supply are not modelled (see limitations).

## Stock validations

* Releasing an order requires the sequential plan to fully cover materials and have active work centers (`409 INSUFFICIENT_STOCK` with per-material shortages; `409 CONFLICT` for work centers).
* Consumption (BOM backflush or explicit `consumed`) is validated against `stockOnHand` for *all* lines before anything is written – failures leave no partial state.
* `adjust` can never drive stock negative; recorded units can never exceed the planned quantity; hours need a work center.
* BOM `active`/`obsolete` versions are immutable; one active version per product.

## Execution, quality, rework

Units flow `good | rejected | defective(pending)`; `good+rejected+defective <= planned`.

* **Progress** adds units (+ consumption, labor/machine hours).
* **Inspection** takes uninspected *good* units; failures move `good -> defective` (ledger entry type `inspection`) and require defect codes.
* **Disposition** resolves defective units: **rework** (`defective -> good`, rework labor/material cost captured, type `rework`) or **reject** (`defective -> rejected`, type `rejection`).
* **Complete** requires zero pending defectives.

## Cost management

From the ledger: `material` (qty x unit cost *at consumption time*), `labor` (hours x work-center labor rate), `machine` (hours x machine rate). `costPerFinishedUnit = total / goodQty`, so scrap and rework cost are absorbed by good units. `standardCost` estimates the unit cost from the active BOM and routing at current prices (setup excluded).

## Analytics (`/analytics/dashboard`)

| KPI | Definition |
|---|---|
| yieldPct | net good / units started |
| timeEfficiencyPct | standard run hours for started units / actual machine hours |
| materialUtilizationPct | value of theoretical material for good units (BOM qty, no scrap) / value consumed |
| defectRatePct | (rejected + pending defective) / started; `firstPassDefectRatePct` counts all initial failures |
| workCenterUtilization | machine hours / (weekdays in period x daily capacity x machines) |
| costs, costByProduct | material/labor/machine totals and cost per finished unit |

Period filters on ledger `recordedAt` (`from`, `to` ISO). `recordedAt` can be supplied when back-filling shop-floor entries.

## Audit

Every `insert`/`update` appends an immutable audit record (actor from `x-actor`, default `anonymous`, `system` outside a request). Includes stock movements (`consume:<order>`, `receive`, `adjust:<reason>`) and order lifecycle (`release`, `progress:*`, `complete`...). Query with `GET /audit?entity=&entityId=`.

## Known limitations / next steps

* No authentication/authorization – `x-actor` is trusted; place behind an authenticating gateway.
* Single-process JSON snapshot persistence; swap `Store` for a database for multi-instance use.
* MRP ignores open purchase orders/inbound receipts and multi-level (sub-assembly) BOMs; working calendar is fixed Mon–Fri 08:00 UTC and has no holidays.
* No UI; REST API only.
