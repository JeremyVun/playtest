export const id = "f-equipment-empty-copy";

export const patches = [
  {
    "file": "public/views/equipment-list.js",
    "find": "      current.q\n        ? `Nothing in the catalogue matches “${current.q}”.`\n        : \"No catalogue item matches the filters you picked.\",",
    "replace": "      \"No catalogue item matches the filters you picked.\","
  }
];

export default { id, patches };
