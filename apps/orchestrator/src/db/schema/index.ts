/**
 * Every table — a table is not real until it is exported here. The round's
 * one schema, designed once (PRD-02 T2): later tasks add columns and tables
 * only where this file names none, and every change is an additive migration
 * (`../additive-safe.ts`).
 */
export * from './api-keys'
export * from './matches'
export * from './servers'
