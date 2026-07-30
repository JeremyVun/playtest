export const id = "f-bundle-threshold-off-by-one";

export const patches = [
  {
    "file": "src/rules.js",
    "find": "    unitCount >= BUNDLE_MIN_UNITS ? roundCents(baseChargeCents * BUNDLE_DISCOUNT_RATE) : 0;",
    "replace": "    unitCount > BUNDLE_MIN_UNITS ? roundCents(baseChargeCents * BUNDLE_DISCOUNT_RATE) : 0;"
  }
];

export default { id, patches };
