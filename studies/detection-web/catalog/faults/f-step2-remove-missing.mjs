export const id = "f-step2-remove-missing";

export const patches = [
  {
    "file": "public/views/new-loan.js",
    "find": "              el(\"td\", {}, [\n                el(\"button\", {\n                  class: \"button button--link\",\n                  type: \"button\",\n                  text: \"Remove\",\n                  \"aria-label\": `Remove ${item ? item.name : line.equipmentId}`,\n                  onclick: () => {\n                    lines.splice(index, 1);\n                    paintLines();\n                    paintPicker();\n                  },\n                }),\n              ]),",
    "replace": "              el(\"td\", {}),"
  }
];

export default { id, patches };
