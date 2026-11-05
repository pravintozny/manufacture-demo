import { ConflictError, ValidationError } from '../errors.js';
import { str, num, array, round } from '../validate.js';

export class BomService {
  constructor(store) { this.store = store; }

  #normalize(input) {
    const components = array(input.components ?? [], 'components').map((c, i) => {
      const materialId = str(c.materialId, `components[${i}].materialId`);
      this.store.require('materials', materialId, 'Material');
      return {
        materialId,
        quantity: num(c.quantity, `components[${i}].quantity`, { gt: 0 }),
        scrapPercent: num(c.scrapPercent, `components[${i}].scrapPercent`, { min: 0, max: 100, def: 0 }),
      };
    });
    if (new Set(components.map((c) => c.materialId)).size !== components.length)
      throw new ValidationError('components must not repeat a material');
    const operations = array(input.operations ?? [], 'operations').map((o, i) => {
      const workCenterId = str(o.workCenterId, `operations[${i}].workCenterId`);
      this.store.require('workCenters', workCenterId, 'Work center');
      return {
        sequence: num(o.sequence, `operations[${i}].sequence`, { integer: true, min: 1, def: (i + 1) * 10 }),
        name: str(o.name, `operations[${i}].name`, { optional: true }),
        workCenterId,
        setupMinutes: num(o.setupMinutes, `operations[${i}].setupMinutes`, { min: 0, def: 0 }),
        runMinutesPerUnit: num(o.runMinutesPerUnit, `operations[${i}].runMinutesPerUnit`, { min: 0, def: 0 }),
      };
    }).sort((a, b) => a.sequence - b.sequence);
    if (new Set(operations.map((o) => o.sequence)).size !== operations.length)
      throw new ValidationError('operation sequences must be unique');
    return { components, operations };
  }

  /** Creates the next version (draft). Only one version per product may be active at a time. */
  create(input) {
    const product = this.store.require('products', str(input.productId, 'productId'), 'Product');
    if (product.status !== 'active') throw new ConflictError('Cannot create a BOM for a discontinued product');
    const version = this.store.list('boms', (b) => b.productId === product.id).length + 1;
    return this.store.insert('boms', {
      productId: product.id, version, status: 'draft',
      notes: str(input.notes, 'notes', { optional: true, max: 1000 }), ...this.#normalize(input),
    });
  }

  /** Drafts are editable; active/obsolete versions are immutable so existing orders keep a stable recipe. */
  update(id, input) {
    const bom = this.get(id);
    if (bom.status !== 'draft') throw new ConflictError(`BOM v${bom.version} is ${bom.status} and immutable; create a new version`);
    const n = this.#normalize({ components: input.components ?? bom.components, operations: input.operations ?? bom.operations });
    return this.store.update('boms', id, 'update', (b) => {
      Object.assign(b, n);
      if (input.notes !== undefined) b.notes = str(input.notes, 'notes', { max: 1000 });
    });
  }

  activate(id) {
    const bom = this.get(id);
    if (bom.status === 'active') return bom;
    if (bom.status === 'obsolete') throw new ConflictError('Obsolete BOMs cannot be re-activated; clone as a new version');
    if (!bom.components.length) throw new ValidationError('A BOM needs at least one component to be activated');
    for (const old of this.store.list('boms', (b) => b.productId === bom.productId && b.status === 'active'))
      this.store.update('boms', old.id, 'obsolete', (b) => { b.status = 'obsolete'; b.obsoletedAt = this.store.now().toISOString(); });
    return this.store.update('boms', id, 'activate', (b) => { b.status = 'active'; b.activatedAt = this.store.now().toISOString(); });
  }

  /** New draft copied from an existing version. */
  newVersionFrom(id) {
    const b = this.get(id);
    return this.create({ productId: b.productId, components: b.components, operations: b.operations, notes: `Copied from v${b.version}` });
  }

  get(id) { return this.store.require('boms', id, 'BOM'); }
  list({ productId, status } = {}) {
    return this.store.list('boms', (b) => (!productId || b.productId === productId) && (!status || b.status === status));
  }
  getActive(productId) { return this.store.list('boms', (b) => b.productId === productId && b.status === 'active')[0]; }

  /** Required raw material quantities (including scrap allowance) for `quantity` finished units. */
  explode(bom, quantity) {
    return bom.components.map((c) => ({
      materialId: c.materialId,
      perUnit: c.quantity,
      scrapPercent: c.scrapPercent,
      required: round(c.quantity * (1 + c.scrapPercent / 100) * quantity),
    }));
  }

  /** Product <-> material relationships. */
  whereUsed(materialId) {
    this.store.require('materials', materialId, 'Material');
    return this.list({ status: 'active' }).filter((b) => b.components.some((c) => c.materialId === materialId))
      .map((b) => ({ productId: b.productId, bomId: b.id, version: b.version, quantity: b.components.find((c) => c.materialId === materialId).quantity }));
  }
  materialsFor(productId) {
    const bom = this.getActive(productId);
    return bom ? bom.components : [];
  }
}
