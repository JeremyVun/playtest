export const id = "f-overdue-empty-state";

export const patches = [
  {
    "file": "public/views/overview.js",
    "find": "      : emptyState(\"No overdue loans\", \"Every loan that is out is still within its due date.\"),",
    "replace": "      : null,"
  }
];

export default { id, patches };
