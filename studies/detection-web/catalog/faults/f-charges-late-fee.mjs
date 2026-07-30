export const id = "f-charges-late-fee";

export const patches = [
  {
    "file": "src/rules.js",
    "find": "    if (loan.returnedAt && loan.returnedAt.slice(0, 10) === today) {",
    "replace": "    if (loan.returnedAt && loan.bookedAt.slice(0, 10) === today) {"
  }
];

export default { id, patches };
