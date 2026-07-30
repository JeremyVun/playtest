export const id = "f-cancel-button-missing";

export const patches = [
  {
    "file": "src/present.js",
    "find": "      canCancel: loan.status === \"pending_approval\" || loan.status === \"ready\",",
    "replace": "      canCancel: loan.status === \"cancelled\","
  }
];

export default { id, patches };
