export const id = "f-cancel-confirm-noop";

export const patches = [
  {
    "file": "public/views/loan-detail.js",
    "find": "            text: \"Yes, cancel loan\",\n            onclick: async () => {\n              try {\n                const result = await post(`/api/loans/${loan.id}/cancel`);\n                await ctx.refreshChrome();\n                await paint({ tone: \"success\", message: result.message });\n              } catch (error) {\n                await paint({ tone: \"error\", message: error.message });\n              }\n            },",
    "replace": "            text: \"Yes, cancel loan\","
  }
];

export default { id, patches };
