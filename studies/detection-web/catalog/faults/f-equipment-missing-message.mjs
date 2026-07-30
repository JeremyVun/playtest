export const id = "f-equipment-missing-message";

export const patches = [
  {
    "file": "src/api.js",
    "find": "  if (!item) return notFound(\"That equipment item does not exist.\");",
    "replace": "  if (!item) return notFound(\"That loan does not exist.\");"
  }
];

export default { id, patches };
