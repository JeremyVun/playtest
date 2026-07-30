export const id = "f-booking-error-swallowed";
export const title = "A refused booking reports the reason on step 3";

const ERROR_BANNER = `      } catch (error) {
        feedback.appendChild(banner("error", error.message));
      }
    },
  });

  const chargeRows`;

export async function check(c) {
  await c.reset();
  const first = await c.draft();
  const second = await c.draft({
    name: "Rosa Lind",
    email: "rosa.lind@fairmont.edu",
    department: "Film & Media",
    purpose: "Night exteriors for the documentary unit.",
  });
  const line = {
    step: "schedule",
    lines: [{ equipmentId: "cam-c70", quantity: 1 }],
    loanDays: 3,
    pickupDate: "2026-03-16",
  };
  c.assert((await c.api("PATCH", `/api/loan-drafts/${first}`, line)).status === 200, "step 2 failed");
  c.assert((await c.api("PATCH", `/api/loan-drafts/${second}`, line)).status === 200, "step 2 failed");

  const booked = await c.api("POST", `/api/loan-drafts/${first}/submit`);
  c.assert(booked.status === 201, `the first booking returned ${booked.status}`);

  const refused = await c.api("POST", `/api/loan-drafts/${second}/submit`);
  c.assert(refused.status === 409, `the second booking returned ${refused.status}, expected 409`);
  c.assert(
    refused.body.error.message === "Canon C70 Cinema Camera has no units available.",
    `the refusal says "${refused.body.error?.message}"`,
  );

  const source = await c.asset("/views/new-loan.js");
  c.assert(
    source.includes(ERROR_BANNER),
    "the served new-loan module swallows a refused confirmation instead of showing the error banner (SPEC §7.3)",
  );
}
