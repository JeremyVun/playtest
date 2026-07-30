export const id = "f-booking-no-redirect";

export const patches = [
  {
    "file": "public/views/new-loan.js",
    "find": "        ctx.setFlash(\"success\", result.message);\n        await ctx.refreshChrome();\n        ctx.navigate(`/loans/${result.loan.id}`);",
    "replace": "        await ctx.refreshChrome();"
  }
];

export default { id, patches };
