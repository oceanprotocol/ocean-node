import EventEmitter from 'node:events'

// a database backend emits these when it loses and restores its connection
export const DB_EVENTS = {
  CONNECTION_LOST: 'db:connection:lost',
  CONNECTION_RESTORED: 'db:connection:restored'
} as const
export const DB_CONNECTION_EVENTS = new EventEmitter()
