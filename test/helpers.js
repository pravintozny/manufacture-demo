import { createApp } from '../src/app.js';
import { seed } from '../src/seed.js';

export function fixture() {
  let t = Date.parse('2026-11-02T09:00:00Z');
  const app = createApp({ now: () => new Date((t += 1000)) });
  return { app, ...seed(app) };
}
export const order = (f, over = {}) => f.app.planning.createOrder({
  productId: f.product.id, quantity: 10, plannedStart: '2026-11-09T00:00:00Z', dueDate: '2026-11-13', ...over,
});
export const rejects = async (fn, code) => {
  try { await fn(); } catch (e) { if (e.code === code) return e; throw e; }
  throw new Error(`expected ${code}`);
};
