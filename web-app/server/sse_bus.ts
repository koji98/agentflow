import { EventEmitter } from 'node:events';

export type BusEvent = any;

const buses = new Map<string, EventEmitter>();

export function getBus(runId: string): EventEmitter {
  let bus = buses.get(runId);
  if (!bus) {
    bus = new EventEmitter();
    buses.set(runId, bus);
  }
  return bus;
}

export function removeBus(runId: string): void {
  const bus = buses.get(runId);
  if (bus) {
    bus.removeAllListeners();
    buses.delete(runId);
  }
}
