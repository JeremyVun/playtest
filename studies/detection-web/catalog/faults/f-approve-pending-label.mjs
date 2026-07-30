export const id = "f-approve-pending-label";

export const patches = [
  {
    "file": "public/views/approvals.js",
    "find": "            approveButton,\n            \"Approving…\",\n            feedbackHost,\n            \"Recording your approval…\",",
    "replace": "            approveButton,\n            \"Declining…\",\n            feedbackHost,\n            \"Recording your approval…\","
  }
];

export default { id, patches };
