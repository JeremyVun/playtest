export const id = "f-extension-block-missing";

export const patches = [
  {
    "file": "public/views/loan-detail.js",
    "find": "        el(\"h2\", { id: \"actions-heading\", text: \"Out with the borrower\" }),\n        extensionBlock(loan),\n        el(\"hr\", { style: \"border:none;border-top:1px solid var(--line);margin:1.1rem 0\" }),",
    "replace": "        el(\"h2\", { id: \"actions-heading\", text: \"Out with the borrower\" }),"
  }
];

export default { id, patches };
