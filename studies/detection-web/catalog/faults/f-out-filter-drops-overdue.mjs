export const id = "f-out-filter-drops-overdue";

export const patches = [
  {
    "file": "src/api.js",
    "find": "  out: (loan) => loan.status === \"out\",",
    "replace": "  out: (loan) => loan.status === \"out\" && !loan.overdue,"
  }
];

export default { id, patches };
