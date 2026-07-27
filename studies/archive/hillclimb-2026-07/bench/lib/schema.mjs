function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(expected, value) {
  if (Array.isArray(expected)) return expected.some((type) => matchesType(type, value));
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function pathJoin(base, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))) return `${base}.${key}`;
  return `${base}[${JSON.stringify(String(key))}]`;
}

function formatTypes(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

export function validateSchema(schema, value, path = '$') {
  const errors = [];

  function visit(node, current, currentPath) {
    if (!node || typeof node !== 'object') return;

    if (node.type !== undefined && !matchesType(node.type, current)) {
      errors.push(`${currentPath}: expected ${formatTypes(node.type)}, got ${typeName(current)}`);
      return;
    }

    if (node.enum && !node.enum.some((candidate) => Object.is(candidate, current))) {
      errors.push(`${currentPath}: expected one of ${node.enum.map((x) => JSON.stringify(x)).join(', ')}`);
    }

    if (typeof current === 'number') {
      if (node.minimum !== undefined && current < node.minimum) {
        errors.push(`${currentPath}: must be >= ${node.minimum}`);
      }
      if (node.maximum !== undefined && current > node.maximum) {
        errors.push(`${currentPath}: must be <= ${node.maximum}`);
      }
    }

    if (typeof current === 'string' && node.pattern !== undefined) {
      const re = new RegExp(node.pattern);
      if (!re.test(current)) errors.push(`${currentPath}: must match /${node.pattern}/`);
    }

    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          errors.push(`${pathJoin(currentPath, key)}: required property missing`);
        }
      }

      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            errors.push(`${pathJoin(currentPath, key)}: unknown property`);
          }
        }
      }

      for (const [key, child] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          visit(child, current[key], pathJoin(currentPath, key));
        }
      }
    }

    if (Array.isArray(current) && node.items) {
      current.forEach((item, index) => visit(node.items, item, `${currentPath}[${index}]`));
    }
  }

  visit(schema, value, path);
  return { ok: errors.length === 0, errors };
}

export default validateSchema;
