export const id = "f-extend-limit-off-by-one";

export const patches = [
  {
    "file": "src/rules.js",
    "find": "  if (loan.extensionsUsed >= MAX_EXTENSIONS) {",
    "replace": "  if (loan.extensionsUsed > MAX_EXTENSIONS) {"
  }
];

export default { id, patches };
