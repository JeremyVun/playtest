export const id = "f-extend-limit-off-by-one";
export const title = "A loan may be extended only once";

export async function check(c) {
  await c.reset();
  const first = await c.api("POST", "/api/loans/L-1048/extend");
  c.assert(first.status === 200, `the first extension returned ${first.status}`);
  c.assert(
    first.body.loan.extensionsUsed === 1,
    `the first extension recorded ${first.body.loan.extensionsUsed} extensions`,
  );

  const second = await c.api("POST", "/api/loans/L-1048/extend");
  c.assert(
    second.status === 409,
    `a second extension returned ${second.status}; SPEC R10 allows one extension per loan`,
  );
  c.assert(
    second.body.error.message === "This loan has already used its one extension.",
    `a second extension says "${second.body.error?.message}"; SPEC §11 requires "This loan has already used its one extension."`,
  );
}
