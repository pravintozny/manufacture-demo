import { ConflictError } from '../errors.js';
import { str, num, oneOf } from '../validate.js';

export const dailyCapacityMinutes = (wc) => (wc.hoursPerDay * 60 * wc.availabilityPct) / 100;

export class WorkCenterService {
  constructor(store) { this.store = store; }

  create(input) {
    const code = str(input.code, 'code', { max: 32 }).toUpperCase();
    if (this.store.list('workCenters', (w) => w.code === code).length) throw new ConflictError(`Work center code already exists: ${code}`);
    return this.store.insert('workCenters', {
      code, name: str(input.name, 'name'),
      type: oneOf(input.type, 'type', ['machine', 'assembly', 'manual', 'inspection'], { def: 'machine' }),
      machines: num(input.machines, 'machines', { integer: true, min: 1, def: 1 }),
      hoursPerDay: num(input.hoursPerDay, 'hoursPerDay', { gt: 0, max: 16, def: 8 }),
      availabilityPct: num(input.availabilityPct, 'availabilityPct', { gt: 0, max: 100, def: 100 }),
      laborRatePerHour: num(input.laborRatePerHour, 'laborRatePerHour', { min: 0, def: 0 }),
      machineRatePerHour: num(input.machineRatePerHour, 'machineRatePerHour', { min: 0, def: 0 }),
      status: 'active',
    });
  }

  update(id, input) {
    this.store.require('workCenters', id, 'Work center');
    const patch = {};
    if (input.name !== undefined) patch.name = str(input.name, 'name');
    if (input.machines !== undefined) patch.machines = num(input.machines, 'machines', { integer: true, min: 1 });
    if (input.hoursPerDay !== undefined) patch.hoursPerDay = num(input.hoursPerDay, 'hoursPerDay', { gt: 0, max: 16 });
    if (input.availabilityPct !== undefined) patch.availabilityPct = num(input.availabilityPct, 'availabilityPct', { gt: 0, max: 100 });
    if (input.laborRatePerHour !== undefined) patch.laborRatePerHour = num(input.laborRatePerHour, 'laborRatePerHour', { min: 0 });
    if (input.machineRatePerHour !== undefined) patch.machineRatePerHour = num(input.machineRatePerHour, 'machineRatePerHour', { min: 0 });
    if (input.status !== undefined) patch.status = oneOf(input.status, 'status', ['active', 'maintenance', 'inactive']);
    return this.store.update('workCenters', id, 'update', (w) => Object.assign(w, patch));
  }

  get(id) { return this.store.require('workCenters', id, 'Work center'); }
  list() { return this.store.list('workCenters'); }

  /** Effective capacity: minutes/day = hoursPerDay x 60 x availability%; machines multiply parallel capacity for reporting. */
  capacity(id) {
    const w = this.get(id);
    const minutesPerDay = dailyCapacityMinutes(w);
    return { workCenterId: id, status: w.status, minutesPerDay, hoursPerDay: minutesPerDay / 60, machines: w.machines };
  }
}
