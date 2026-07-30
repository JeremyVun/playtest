# Arm C bug report — round 1

End reason: finished. Bugs reported: 12.

Agent summary: Covered session, overview, equipment catalogue/detail/filtering, loan list/detail/filtering, approvals, draft creation/update/submit, pickup, cancel, decline, check-in, and extension flows across the supplied stories and edge missions. Reported 12 verified bugs covering wrong stock totals, filtering, late-day/fee math, action availability, bundle discount pricing, repeated extension, booked-today charges, not-found messaging, and weekend due-date rolling.

## Bug 1: Overview reports unitsTotal as available units instead of catalogue total

- Severity: medium
- Steps:
1. Send GET /api/overview
- Expected: metrics.unitsTotal should be 53, the total units owned across the 12-item catalogue, while metrics.unitsAvailable should be 40.
- Observed: Response has metrics.unitsAvailable = 40 and metrics.unitsTotal = 40, contradicting the documented catalogue total and the story expectation of 53 total units.

## Bug 2: Loan register status=out filter omits overdue out loans

- Severity: medium
- Steps:
1. Send GET /api/overview and note the overdue queue contains L-1042 with stored status "out".
2. Send GET /api/loans?status=out
- Expected: The out filter should list every loan whose stored status is out, including overdue loans. Initially this should include L-1048, L-1042, and L-1041, with shownCount 3.
- Observed: GET /api/loans?status=out returns only L-1048 and L-1041 with shownCount 2. It omits L-1042 even though /api/overview shows L-1042 has status "out" and is overdue.

## Bug 3: Overdue late-business-day count and late fee include the due date

- Severity: high
- Steps:
1. Send GET /api/overview.
2. Send GET /api/loans/L-1042.
- Expected: Loan L-1042 was due on Wed 2026-03-11. With the desk clock on Mon 2026-03-16, late business days should be Thu 2026-03-12, Fri 2026-03-13, and Mon 2026-03-16: 3 days. At $5.00 per unit per late business day across 3 units, lateFeePreviewCents should be 4500.
- Observed: Both responses report lateBusinessDays = 4 and lateFeePreviewCents = 6000 for L-1042, apparently counting the due date as a late day.

## Bug 4: Pending approval loan detail says cancellation is unavailable

- Severity: medium
- Steps:
1. Create and submit a draft that needs approval: POST /api/loan-drafts with Nadia Ferrer, then PATCH /api/loan-drafts/D-1 with 1 cam-c70, loanDays 14, pickupDate 2026-03-18, then POST /api/loan-drafts/D-1/submit.
2. Send GET /api/loans/L-1049.
- Expected: A loan awaiting approval should expose actions.canCancel = true because cancellation is allowed for loans awaiting approval or ready for pickup.
- Observed: L-1049 is returned with status "pending_approval" / "Awaiting approval", but actions.canCancel is false.

## Bug 5: Draft quote does not apply bundle discount at three units

- Severity: high
- Steps:
1. Create a draft: POST /api/loan-drafts with body {"name":"Ada Byron","email":"ada.byron@fairmont.edu","department":"Design","purpose":"Studio test shoot."}
2. Update the schedule: PATCH /api/loan-drafts/D-2 with body {"step":"schedule","lines":[{"equipmentId":"cam-gopro","quantity":2},{"equipmentId":"aud-h6","quantity":1}],"loanDays":3,"pickupDate":"2026-03-17"}
- Expected: The draft has 3 units total, so the 10% bundle discount should apply. Base charge should be 5100 cents, bundleDiscountCents should be 510, and totalDueCents should be 4590.
- Observed: The draft preview returns baseChargeCents = 5100, bundleDiscountCents = 0, and totalDueCents = 5100, so it fails to apply the documented bundle discount at the 3-unit threshold.

## Bug 6: Cancelled loan detail still advertises cancellation as available

- Severity: medium
- Steps:
1. Send POST /api/loans/L-1043/cancel with no body.
2. Inspect the returned loan detail in the 200 response.
- Expected: After L-1043 moves to status "cancelled", actions.canCancel should be false because only loans awaiting approval or ready for pickup may be cancelled.
- Observed: The cancel response returns L-1043 with status "cancelled" but actions.canCancel = true.

## Bug 7: Loan extension can be applied more than once

- Severity: high
- Steps:
1. Send GET /api/loans/L-1048 and note it is out, not overdue, due 2026-03-19, with extensionsUsed = 0.
2. Send POST /api/loans/L-1048/extend with no body.
3. Send POST /api/loans/L-1048/extend with no body again.
- Expected: The first extension should succeed, moving the due date to 2026-03-26 and setting extensionsUsed to 1. The second extension should be refused with HTTP 409 and a message saying this loan has already used its one extension.
- Observed: The first extension succeeds, but the response still advertises actions.canExtend = true and extendedDueDate = 2026-04-02. The second POST also succeeds with HTTP 200, moves the due date to 2026-04-02, and sets extensionsUsed = 2.

## Bug 8: Overview chargesBookedTodayCents does not include late fees recorded today

- Severity: medium
- Steps:
1. Send POST /api/loans/L-1042/checkin with body {"condition":"damaged","note":"Lens hood cracked on the front element."}.
2. Note the response reports lateFeeCents = 6000.
3. Send GET /api/overview.
- Expected: chargesBookedTodayCents should include total due for loans booked on the desk date that are not cancelled or declined, plus late fees recorded on the desk date. After the check-in, it should increase by the recorded late fee.
- Observed: The check-in succeeds and records a late fee, but the next overview still reports chargesBookedTodayCents = 118400, unchanged from before the check-in.

## Bug 9: Equipment availableOnly filter includes items with zero available units

- Severity: medium
- Steps:
1. Send GET /api/equipment?availableOnly=1.
2. Inspect the returned items.
- Expected: When availableOnly is 1, only catalogue items with at least one available unit should be returned. Items with availableUnits = 0, such as DJI RS 4 Pro Gimbal, should be omitted.
- Observed: The response includes sup-gimbal / DJI RS 4 Pro Gimbal with availableUnits = 0 even though filters.availableOnly is true.

## Bug 10: Loans due today report a nonzero lateBusinessDays value

- Severity: medium
- Steps:
1. Send GET /api/overview.
2. Send GET /api/loans/L-1041 before extending or returning it.
- Expected: L-1041 is due on the desk date, so it is not overdue and lateBusinessDays should be 0. The schema says lateBusinessDays is 0 otherwise for loans that are not past due.
- Observed: The dueToday entry for L-1041 and the loan detail both show overdue = false but lateBusinessDays = 1.

## Bug 11: Missing equipment item returns loan-not-found message

- Severity: low
- Steps:
1. Send GET /api/equipment/cam-nonexistent.
- Expected: The API should return HTTP 404 with an equipment-specific message such as "That equipment item does not exist."
- Observed: The API returns HTTP 404, but the JSON body says {"error":{"message":"That loan does not exist."}}, which would mislead clients and operators because the request was for an equipment item, not a loan.

## Bug 12: One-day Friday pickup draft is due on Sunday instead of rolling to Monday

- Severity: high
- Steps:
1. Create a draft: POST /api/loan-drafts with body {"name":"Ravi Anand","email":"ravi.anand@fairmont.edu","department":"Journalism","purpose":"Friday afternoon interview kit."}
2. Update it once: PATCH /api/loan-drafts/D-3 with body {"step":"schedule","lines":[{"equipmentId":"aud-lav","quantity":1}],"loanDays":3,"pickupDate":"2026-03-19"} and note the due date correctly rolls to 2026-03-23.
3. Update it again: PATCH /api/loan-drafts/D-3 with body {"step":"schedule","lines":[{"equipmentId":"aud-lav","quantity":1}],"loanDays":1,"pickupDate":"2026-03-20"}.
- Expected: A 1-day loan picked up on Friday 2026-03-20 lands on Saturday 2026-03-21, so the due date should roll forward to Monday 2026-03-23 at 17:00.
- Observed: The second schedule update returns preview.dueDate = "2026-03-22" and preview.dueAt = "2026-03-22T17:00:00Z", which is Sunday while the desk is closed.