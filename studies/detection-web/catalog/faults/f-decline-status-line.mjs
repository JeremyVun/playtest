export const id = "f-decline-status-line";

export const patches = [
  {
    "file": "public/views/approvals.js",
    "find": "                confirmButton,\n                \"Declining…\",\n                statusHost,\n                \"Recording your decision…\",",
    "replace": "                confirmButton,\n                \"Declining…\",\n                null,\n                \"Recording your decision…\","
  }
];

export default { id, patches };
