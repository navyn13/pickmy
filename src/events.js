import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
export const emit = (type, data = {}) => bus.emit('event', { type, ...data });
