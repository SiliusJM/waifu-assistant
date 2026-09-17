import type {
  ToolArgumentProperty,
  ToolArgumentSchema,
  ToolValidationResult,
} from './tool-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: ToolArgumentProperty['type']): boolean {
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'object') {
    return isRecord(value);
  }
  return typeof value === type;
}

export function validateToolArguments<T extends object>(
  schema: ToolArgumentSchema,
  value: unknown,
): ToolValidationResult<T> {
  if (!isRecord(value)) {
    return { valid: false, issues: [{ path: '$', reason: 'Arguments must be an object.' }] };
  }

  const issues: Array<{ readonly path: string; readonly reason: string }> = [];
  const properties = schema.properties;
  for (const [name, definition] of Object.entries(properties)) {
    const propertyValue = value[name];
    if (propertyValue === undefined) {
      if (definition.required) {
        issues.push({ path: name, reason: 'Argument is required.' });
      }
      continue;
    }
    if (!matchesType(propertyValue, definition.type)) {
      issues.push({ path: name, reason: 'Argument has an invalid type.' });
      continue;
    }
    if (definition.enum && (typeof propertyValue !== 'string' && typeof propertyValue !== 'number'
      && typeof propertyValue !== 'boolean' || !definition.enum.includes(propertyValue))) {
      issues.push({ path: name, reason: 'Argument has an invalid value.' });
    }
    if (typeof propertyValue === 'string') {
      if (definition.minLength !== undefined && propertyValue.length < definition.minLength) {
        issues.push({ path: name, reason: 'Argument is shorter than allowed.' });
      }
      if (definition.maxLength !== undefined && propertyValue.length > definition.maxLength) {
        issues.push({ path: name, reason: 'Argument is longer than allowed.' });
      }
    }
    if (typeof propertyValue === 'number') {
      if (definition.minimum !== undefined && propertyValue < definition.minimum) {
        issues.push({ path: name, reason: 'Argument is below the minimum.' });
      }
      if (definition.maximum !== undefined && propertyValue > definition.maximum) {
        issues.push({ path: name, reason: 'Argument is above the maximum.' });
      }
    }
  }

  if (!schema.allowUnknown) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) {
        issues.push({ path: name, reason: 'Unknown argument.' });
      }
    }
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: value as T };
}
