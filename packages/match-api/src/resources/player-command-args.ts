import type { ArgsJsonSchema } from './gamemode'

/**
 * **The corner of JSON Schema a command's `args` uses**, checked in
 * TypeScript the way the SDK's `ArgsValidator` checks it in C#: `type`
 * (object, string, number, integer, boolean, array, null), `properties`,
 * `required`, `additionalProperties`, `enum`, `const`, `minimum`/`maximum`,
 * `minLength`/`maxLength`, `items`, `minItems`/`maxItems`. A widget validates
 * a tap against the manifest's document before it sends, the simulated
 * server before it answers, the plugin before it acts — one document, the
 * same verdict on every side. A keyword outside this set is ignored, never
 * refused: the manifest was validated at parse time, so what arrives is a
 * schema its author meant.
 *
 * Answers the first problem found as a sentence, or `null` when the args fit.
 */
export function validatePlayerCommandArgs(
  schema: ArgsJsonSchema | undefined,
  args: Record<string, unknown> | undefined,
): string | null {
  if (schema === undefined) {
    // A verb without an args schema takes none; an empty object is "none" too.
    return args === undefined || Object.keys(args).length === 0
      ? null
      : 'this command takes no arguments'
  }
  return check(schema, args ?? {}, 'args')
}

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (isSchema(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sorted(value[key])]),
    )
  return value
}

function check(schema: Schema, value: unknown, path: string): string | null {
  if ('const' in schema && !same(schema.const, value))
    return `${path} must be ${JSON.stringify(schema.const)}`
  if (Array.isArray(schema.enum) && !schema.enum.some(choice => same(choice, value)))
    return `${path} must be one of ${JSON.stringify(schema.enum)}`
  if (typeof schema.type === 'string') {
    const problem = checkType(schema.type, value, path)
    if (problem) return problem
  }
  if (Array.isArray(value)) return checkArray(schema, value, path)
  if (isSchema(value)) return checkObject(schema, value, path)
  return checkScalar(schema, value, path)
}

function checkType(type: string, value: unknown, path: string): string | null {
  const fits = (() => {
    switch (type) {
      case 'object':
        return isSchema(value)
      case 'array':
        return Array.isArray(value)
      case 'null':
        return value === null || value === undefined
      case 'string':
        return typeof value === 'string'
      case 'boolean':
        return typeof value === 'boolean'
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      default:
        return true
    }
  })()
  return fits ? null : `${path} must be ${type === 'integer' ? 'an integer' : `a ${type}`}`
}

function checkObject(schema: Schema, value: Schema, path: string): string | null {
  const properties = isSchema(schema.properties) ? schema.properties : undefined
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string' && !(name in value)) return `${path}.${name} is required`
    }
  }
  for (const [name, child] of Object.entries(value)) {
    const childSchema = properties?.[name]
    if (isSchema(childSchema)) {
      const problem = check(childSchema, child, `${path}.${name}`)
      if (problem) return problem
    } else if (schema.additionalProperties === false) {
      return `${path}.${name} is not allowed`
    }
  }
  return null
}

function checkArray(schema: Schema, value: unknown[], path: string): string | null {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems)
    return `${path} needs at least ${schema.minItems} items`
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    return `${path} allows at most ${schema.maxItems} items`
  if (isSchema(schema.items)) {
    for (const [index, item] of value.entries()) {
      const problem = check(schema.items, item, `${path}[${index}]`)
      if (problem) return problem
    }
  }
  return null
}

function checkScalar(schema: Schema, value: unknown, path: string): string | null {
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return `${path} must be at least ${schema.minimum}`
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return `${path} must be at most ${schema.maximum}`
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      return `${path} must be at least ${schema.minLength} characters`
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      return `${path} must be at most ${schema.maxLength} characters`
  }
  return null
}
