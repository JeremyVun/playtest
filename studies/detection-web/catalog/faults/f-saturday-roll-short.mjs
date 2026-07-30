export const id = "f-saturday-roll-short";

export const patches = [
  {
    "file": "src/time.js",
    "find": "  if (day === 6) return addDays(date, 2);",
    "replace": "  if (day === 6) return addDays(date, 1);"
  }
];

export default { id, patches };
