export const id = "f-approvals-empty-action";

export const patches = [
  {
    "file": "public/views/approvals.js",
    "find": "          \"Every request has been decided. New requests appear here when a loan is worth $2,500 or more, or runs for 14 days.\",\n          el(\"a\", { class: \"button\", href: \"/loans\", text: \"View all loans\" }),",
    "replace": "          \"Every request has been decided. New requests appear here when a loan is worth $2,500 or more, or runs for 14 days.\","
  }
];

export default { id, patches };
