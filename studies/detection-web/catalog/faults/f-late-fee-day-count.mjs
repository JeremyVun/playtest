export const id = "f-late-fee-day-count";

export const patches = [
  {
    "file": "src/rules.js",
    "find": "  return businessDaysBetween(loan.dueDate, today);",
    "replace": "  return businessDaysBetween(addDays(loan.dueDate, -1), today);"
  }
];

export default { id, patches };
