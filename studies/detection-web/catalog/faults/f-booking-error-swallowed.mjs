export const id = "f-booking-error-swallowed";

export const patches = [
  {
    "file": "public/views/new-loan.js",
    "find": "      } catch (error) {\n        feedback.appendChild(banner(\"error\", error.message));\n      }\n    },\n  });\n\n  const chargeRows = [[\"Base charge\", money(preview.quote.baseChargeCents)]];",
    "replace": "      } catch {\n        clear(feedback);\n      }\n    },\n  });\n\n  const chargeRows = [[\"Base charge\", money(preview.quote.baseChargeCents)]];"
  }
];

export default { id, patches };
