export const id = "f-overview-units-total";

export const patches = [
  {
    "file": "src/rules.js",
    "find": "    unitsTotal += item.totalUnits;",
    "replace": "    unitsTotal += available.get(item.id) || 0;"
  }
];

export default { id, patches };
