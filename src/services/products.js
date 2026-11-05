import { ConflictError, ValidationError } from '../errors.js';
import { str, oneOf, plainObject } from '../validate.js';

const SKU_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export class ProductService {
  constructor(store) { this.store = store; }

  createCategory(input) {
    const name = str(input.name, 'name', { max: 80 });
    if (this.store.list('categories', (c) => c.name.toLowerCase() === name.toLowerCase()).length)
      throw new ConflictError(`Category already exists: ${name}`);
    return this.store.insert('categories', { name, description: str(input.description, 'description', { optional: true, max: 500 }) });
  }
  listCategories() { return this.store.list('categories'); }

  createProduct(input) {
    const sku = str(input.sku, 'sku', { max: 32 }).toUpperCase();
    if (!SKU_RE.test(sku)) throw new ValidationError('sku must be 2-32 chars of A-Z, 0-9, "-" or "_"');
    if (this.store.list('products', (p) => p.sku === sku).length) throw new ConflictError(`SKU already exists: ${sku}`);
    const categoryId = str(input.categoryId, 'categoryId');
    this.store.require('categories', categoryId, 'Category');
    return this.store.insert('products', {
      sku, name: str(input.name, 'name'), categoryId,
      description: str(input.description, 'description', { optional: true, max: 1000 }),
      unit: str(input.unit ?? 'pcs', 'unit', { max: 16 }),
      specifications: plainObject(input.specifications, 'specifications') ?? {},
      status: 'active',
    });
  }

  updateProduct(id, input) {
    this.store.require('products', id, 'Product');
    const patch = {};
    if (input.name !== undefined) patch.name = str(input.name, 'name');
    if (input.description !== undefined) patch.description = str(input.description, 'description', { max: 1000 });
    if (input.specifications !== undefined) patch.specifications = plainObject(input.specifications, 'specifications', { optional: false });
    if (input.status !== undefined) patch.status = oneOf(input.status, 'status', ['active', 'discontinued']);
    if (input.categoryId !== undefined) {
      this.store.require('categories', input.categoryId, 'Category');
      patch.categoryId = input.categoryId;
    }
    if (input.sku !== undefined) throw new ValidationError('sku is immutable');
    return this.store.update('products', id, 'update', (p) => Object.assign(p, patch));
  }

  getProduct(id) { return this.store.require('products', id, 'Product'); }
  listProducts({ categoryId, status } = {}) {
    return this.store.list('products', (p) => (!categoryId || p.categoryId === categoryId) && (!status || p.status === status));
  }
  getBySku(sku) { return this.store.list('products', (p) => p.sku === String(sku).toUpperCase())[0]; }
}
