export const id = "f-available-filter-ignored";

export const patches = [
  {
    "file": "src/api.js",
    "find": "  const availableOnly = query.availableOnly === \"1\" || query.availableOnly === \"true\";",
    "replace": "  const availableOnly = query.availableOnly === \"true\";"
  }
];

export default { id, patches };
