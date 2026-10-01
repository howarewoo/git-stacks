/**
 * The authoring-time validator for the contract schemas.
 *
 * It implements only the JSON Schema keywords the flatten-pr-graph schemas use, so
 * the contract stays machine-checkable without adding a runtime dependency to the
 * application. An unsupported keyword is an error rather than a silent pass: a
 * schema that quietly stops checking is worse than no schema.
 */

export interface SchemaError {
  path: string
  message: string
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
])

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function resolveRef(ref: string, root: unknown): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/$defs/')) {
    throw new Error(`flatten-pr-graph validator supports only local $ref, got ${ref}`)
  }
  const defs = (root as { $defs?: Record<string, unknown> }).$defs
  const name = ref.slice('#/$defs/'.length)
  const resolved = defs?.[name]
  if (resolved === undefined) throw new Error(`flatten-pr-graph validator: unknown $ref ${ref}`)
  return resolved
}

function checkSchemaShape(schema: unknown, path: string, errors: SchemaError[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push({ path, message: 'schema must be an object' })
    return
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      errors.push({ path: `${path}.${keyword}`, message: `unsupported schema keyword ${keyword}` })
    }
  }
  const record = schema as Record<string, unknown>
  for (const [name, child] of Object.entries((record.properties as object) ?? {})) {
    checkSchemaShape(child, `${path}.properties.${name}`, errors)
  }
  for (const [name, child] of Object.entries((record.$defs as object) ?? {})) {
    checkSchemaShape(child, `${path}.$defs.${name}`, errors)
  }
  if (record.items !== undefined) checkSchemaShape(record.items, `${path}.items`, errors)
  for (const branch of [
    ...((record.oneOf as unknown[]) ?? []),
    ...((record.anyOf as unknown[]) ?? []),
  ]) {
    checkSchemaShape(branch, `${path}[branch]`, errors)
  }
  if (record.not !== undefined) checkSchemaShape(record.not, `${path}.not`, errors)
}

function validateAgainst(
  schema: unknown,
  value: unknown,
  root: unknown,
  path: string,
  errors: SchemaError[],
): void {
  if (schema === true) return
  if (schema === false) {
    errors.push({ path, message: 'schema forbids any value here' })
    return
  }
  if (typeof schema !== 'object' || schema === null) {
    errors.push({ path, message: 'schema must be an object' })
    return
  }
  const node = schema as Record<string, unknown>

  if (typeof node.$ref === 'string') {
    validateAgainst(resolveRef(node.$ref, root), value, root, path, errors)
  }

  if (node.type !== undefined) {
    const expected = Array.isArray(node.type) ? (node.type as string[]) : [node.type as string]
    if (!expected.some((candidate) => matchesType(value, candidate))) {
      errors.push({ path, message: `expected type ${expected.join('|')}, saw ${typeOf(value)}` })
      return
    }
  }

  if ('const' in node && !deepEqual(value, node.const)) {
    errors.push({ path, message: `expected constant ${JSON.stringify(node.const)}` })
  }

  if (Array.isArray(node.enum) && !node.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push({ path, message: `expected one of ${JSON.stringify(node.enum)}` })
  }

  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push({ path, message: `shorter than minLength ${node.minLength}` })
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      errors.push({ path, message: `longer than maxLength ${node.maxLength}` })
    }
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      errors.push({ path, message: `does not match ${node.pattern}` })
    }
  }

  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) {
      errors.push({ path, message: `below minimum ${node.minimum}` })
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      errors.push({ path, message: `above maximum ${node.maximum}` })
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push({ path, message: `needs at least ${node.minItems} items` })
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      errors.push({ path, message: `allows at most ${node.maxItems} items` })
    }
    if (
      node.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      errors.push({ path, message: 'items must be unique' })
    }
    if (node.items !== undefined) {
      value.forEach((item, index) =>
        validateAgainst(node.items, item, root, `${path}/${index}`, errors),
      )
    }
  }

  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>
    for (const name of (node.required as string[]) ?? []) {
      if (!Object.hasOwn(object, name) || object[name] === undefined) {
        errors.push({ path: `${path}/${name}`, message: 'required property is missing' })
      }
    }
    const properties = (node.properties as Record<string, unknown>) ?? {}
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(object, name) && object[name] !== undefined) {
        validateAgainst(child, object[name], root, `${path}/${name}`, errors)
      }
    }
    if (node.additionalProperties === false) {
      for (const name of Object.keys(object)) {
        if (!Object.hasOwn(properties, name)) {
          errors.push({ path: `${path}/${name}`, message: 'property is not allowed here' })
        }
      }
    }
  }

  for (const branch of (node.allOf as unknown[]) ?? []) {
    validateAgainst(branch, value, root, path, errors)
  }
  for (const branch of (node.anyOf as unknown[]) ?? []) {
    if (collect(branch, value, root, path).length > 0) {
      errors.push({ path, message: 'no anyOf branch matched' })
      break
    }
  }
  if (Array.isArray(node.oneOf)) {
    const outcomes = node.oneOf.map((branch) => collect(branch, value, root, path))
    const passing = outcomes.filter((branchErrors) => branchErrors.length === 0)
    if (passing.length !== 1) {
      const firstFailure = outcomes[0]?.map((error) => `${error.path} ${error.message}`).join('; ')
      errors.push({
        path,
        message:
          `exactly one shape branch must match, ${passing.length} of ${node.oneOf.length} matched` +
          (passing.length === 0 && firstFailure ? `; first failure: ${firstFailure}` : ''),
      })
    }
  }
  if (node.not !== undefined && collect(node.not, value, root, path).length === 0) {
    errors.push({ path, message: 'value matches a forbidden shape' })
  }
}

function collect(schema: unknown, value: unknown, root: unknown, path: string): SchemaError[] {
  const errors: SchemaError[] = []
  validateAgainst(schema, value, root, path, errors)
  return errors
}

export interface LoadedSchema {
  document: unknown
  root: unknown
  shapeErrors: SchemaError[]
}

export function loadSchema(document: unknown): LoadedSchema {
  const shapeErrors: SchemaError[] = []
  checkSchemaShape(document, '#', shapeErrors)
  return { document, root: document, shapeErrors }
}

/** Validates `value`; `pointer` selects a `$defs` entry, e.g. `#/$defs/snapshot`. */
export function validateAgainstPointer(
  schema: LoadedSchema,
  pointer: string,
  value: unknown,
): SchemaError[] {
  const target = pointer === '#' ? schema.root : resolveRef(pointer, schema.root)
  return collect(target, value, schema.root, '$')
}

export function formatErrors(errors: SchemaError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join('\n')
}
