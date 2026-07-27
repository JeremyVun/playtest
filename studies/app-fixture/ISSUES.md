# Planted defects — home loan applicant capture fixture

This inventory lists every deliberate defect in `tests/app-fixture`.
Issues are intentional. Do not “fix” them unless a playtest story or
eval is specifically about healing them.

Format: id · title · category · location · repro · wrong behavior · source

---

## LOAN-001 — Brand misspells “Mortgage” as “Mortage”

- **Category:** copy
- **Where:** Header brand, landing lede, consent sentence, footer copyright
- **Repro:** Open the app. Read the header brand, landing body copy, property-step consent text, and footer.
- **Wrong behavior:** “Mortage” / “mortage” appears in all four places instead of “Mortgage” / “mortgage” (header and footer “Northbridge **Mortage**”; landing “residential **mortage** product”; consent “Northbridge **Mortage** processing…”).
- **Source:** `public/index.html` (`.brand-name`, landing `.lede`, `.consent-text`, `.site-footer`)

## LOAN-002 — Primary start CTA is “Click here”

- **Category:** copy / UX
- **Where:** Landing step primary button (`#start-btn`)
- **Repro:** Load the landing page; inspect the main call-to-action.
- **Wrong behavior:** Button label is the non-descriptive “Click here” instead of something like “Start application”.
- **Source:** `public/index.html`

## LOAN-003 — Footer low contrast and skip link off-screen forever

- **Category:** a11y / CSS
- **Where:** `.site-footer` text color; `.skip-link` positioning
- **Repro:** Inspect footer styles (`#d5d0c6` on `#ebe6dc`). Tab to the page start or inspect `.skip-link` — it stays at `left: -9999px` with no focus reveal.
- **Wrong behavior:** Footer text is nearly unreadable; skip link cannot be used by keyboard users.
- **Source:** `public/styles.css`, `public/index.html`

## LOAN-004 — Review Cancel looks primary; Submit looks secondary

- **Category:** UI
- **Where:** Review step action buttons
- **Repro:** Complete steps through review. Observe Cancel vs Submit styling.
- **Wrong behavior:** Cancel uses the green primary style; Submit uses muted gray secondary styling, reversing visual hierarchy.
- **Source:** `public/index.html` (`#cancel-btn` has `btn-primary`; `#submit-btn` has `btn-muted`)

## LOAN-005 — Email field has no associated label

- **Category:** a11y
- **Where:** Contact step email control
- **Repro:** Inspect the email field. There is a `div.pseudo-label` but no `<label for="email">`.
- **Wrong behavior:** Screen readers and click-to-focus label association fail; only a non-semantic div presents the name.
- **Source:** `public/index.html`

## LOAN-006 — Global rule removes all focus rings

- **Category:** a11y / CSS
- **Where:** Global stylesheet
- **Repro:** Tab through inputs/buttons; no focus outline appears.
- **Wrong behavior:** `*:focus { outline: none !important; }` removes focus indication for keyboard users.
- **Source:** `public/styles.css`

## LOAN-007 — Phone accepts any non-empty string

- **Category:** form / validation
- **Where:** Contact step phone field validation
- **Repro:** Enter `abc-not-a-phone` as phone; leave other fields valid; advance.
- **Wrong behavior:** Validation only checks non-empty; letters and free-form garbage are accepted.
- **Source:** `public/app.js` (`validateContact`)

## LOAN-008 — Empty first name highlights last name

- **Category:** form / UX
- **Where:** Identity step validation
- **Repro:** Leave first name empty, fill last name, submit Identity.
- **Wrong behavior:** Error message “First name is required.” is attached to the **last name** field (`#last-name`), not first name.
- **Source:** `public/app.js` (`validateIdentity`)

## LOAN-009 — Income label vs placeholder conflict

- **Category:** copy
- **Where:** Identity step income field
- **Repro:** Read the label “Monthly income” and the placeholder “full year salary”.
- **Wrong behavior:** Label claims monthly; placeholder implies annual salary — applicant cannot tell which unit to enter.
- **Source:** `public/index.html`

## LOAN-010 — parseMoney only strips the first comma

- **Category:** form / validation
- **Where:** `parseMoney` helper used for income, property value, loan amount
- **Repro:** Enter property value `1,250,000` and attempt to continue (or inspect `parseMoney` in source).
- **Wrong behavior:** Only the first comma is removed, then `Number()` is applied — so `1,250,000` becomes `1250,000`, which is `NaN` (remaining comma breaks parsing). Single-comma values like `450,000` still parse correctly.
- **Source:** `public/app.js` (`parseMoney`)

## LOAN-011 — Back from property wipes contact data

- **Category:** UX
- **Where:** Property step Back control
- **Repro:** Fill contact, go to property, press Back. Contact fields are empty.
- **Wrong behavior:** Back navigates to contact **and** `form.reset()` clears all contact inputs and `state.contact`.
- **Source:** `public/app.js` (back handler for step 3)

## LOAN-012 — Progress labels swapped and wrong step highlighted

- **Category:** UI
- **Where:** Progress indicator (`#progress`)
- **Repro:** On Identity step, progress shows label “Contact” for step 2 slot and “Identity” for step 3 slot; active highlight is offset (step N marks N+1 active).
- **Wrong behavior:** Identity/Contact labels are swapped in markup; JS highlights the wrong step while mid-flow.
- **Source:** `public/index.html`, `public/app.js` (`updateProgress`)

## LOAN-013 — Consent text is not a label

- **Category:** a11y
- **Where:** Property step consent row
- **Repro:** Try clicking the consent sentence; only the small checkbox toggles.
- **Wrong behavior:** Consent copy is a `<span class="consent-text">`, not a `<label for="consent">`, so the clickable target is only the tiny checkbox.
- **Source:** `public/index.html`

## LOAN-014 — Property value errors are color-only

- **Category:** a11y
- **Where:** Property value validation
- **Repro:** Leave property value empty and submit the property step.
- **Wrong behavior:** Input gets a red border / invalid class, but the error element text is empty — no textual explanation for screen reader / color-blind users.
- **Source:** `public/app.js` (`validateProperty`), `public/index.html`

## LOAN-015 — ZIP input type=number strips leading zeros

- **Category:** form
- **Where:** Contact step ZIP field
- **Repro:** Type a New England ZIP like `02108`; browser/number input drops the leading zero.
- **Wrong behavior:** `type="number"` is inappropriate for ZIP codes; leading zeros cannot be preserved.
- **Source:** `public/index.html` (`#zip`)

## LOAN-016 — Two Next buttons on contact; prominent one is fake

- **Category:** UI
- **Where:** Contact step actions
- **Repro:** On contact, click the green “Next”. Nothing advances; phone is focused. The quiet underlined “Next” is the real submit.
- **Wrong behavior:** Fake primary `#fake-next` only focuses phone; real submit `.real-next` is visually de-emphasized.
- **Source:** `public/index.html`, `public/app.js`, `public/styles.css`

## LOAN-017 — Success heading says application “denined”

- **Category:** copy
- **Where:** Confirmation step heading
- **Repro:** Complete happy path to confirmation.
- **Wrong behavior:** Heading reads “Application **denined** — thank you” (typo + denial tone on a success page).
- **Source:** `public/index.html`

## LOAN-018 — First/last name fields fixed 140px and clip overflow

- **Category:** CSS / UI
- **Where:** Identity name row
- **Repro:** Enter a long first name such as “Christopher-Alexander”.
- **Wrong behavior:** `.name-field` / inputs are fixed at 140px with `overflow: hidden`, clipping long names.
- **Source:** `public/styles.css`

## LOAN-019 — SSN uses password masking

- **Category:** UX
- **Where:** Identity SSN input
- **Repro:** Focus SSN field; characters are masked as password dots.
- **Wrong behavior:** `type="password"` hides SSN by default, making typos hard to catch (show toggle exists but is easy to miss).
- **Source:** `public/index.html`

## LOAN-020 — State dropdown unsorted; missing AK, HI, DC

- **Category:** UX
- **Where:** Contact state `<select>`
- **Repro:** Open state list — Texas is first, order is not alphabetical; Alaska, Hawaii, and District of Columbia are absent.
- **Wrong behavior:** Harder to find states; residents of AK/HI/DC cannot select their state.
- **Source:** `public/index.html`

## LOAN-021 — Loan amount min $50,000 but error says “$0”

- **Category:** form / copy
- **Where:** Property step loan amount validation
- **Repro:** Enter loan amount `10000` and continue.
- **Wrong behavior:** Value is rejected (true min 50000) but message says “Loan amount must be at least **$0**”.
- **Source:** `public/app.js` (`validateProperty`)

## LOAN-022 — SSN show toggle has tabindex=99

- **Category:** a11y
- **Where:** SSN show/hide button
- **Repro:** Tab through the identity form; the Show button is visited far out of visual order (`tabindex="99"`).
- **Wrong behavior:** Breaks natural tab order relative to surrounding fields.
- **Source:** `public/index.html` (`#ssn-toggle`)

## LOAN-023 — Income help tooltip clipped by overflow hidden

- **Category:** CSS
- **Where:** Identity income field help control
- **Repro:** Hover/focus the “?” next to income.
- **Wrong behavior:** Tooltip is clipped because `.income-field` / `.income-input-wrap` use `overflow: hidden`.
- **Source:** `public/styles.css`

## LOAN-024 — Submit not disabled during or after submit

- **Category:** UI / form
- **Where:** Review submit handler
- **Repro:** On review, double-click “Submit application” quickly.
- **Wrong behavior:** Button stays enabled; multiple `POST /api/applications` can fire, producing multiple reference numbers.
- **Source:** `public/app.js` (`submitApplication`)

## LOAN-025 — Confirm email never compared to email

- **Category:** form / validation
- **Where:** Contact step
- **Repro:** Enter `a@example.com` and confirm `b@example.com` (or any non-empty confirm that does not match); other fields valid; continue.
- **Wrong behavior:** Confirm email only needs to be non-empty — neither equality with email nor email format is checked, so mismatches and garbage confirms are accepted.
- **Source:** `public/app.js` (`validateContact`)

## LOAN-026 — Document title is just “Portal”

- **Category:** copy
- **Where:** `<title>` in document head
- **Repro:** Look at the browser tab title.
- **Wrong behavior:** Title is generic “Portal” instead of describing the home loan application.
- **Source:** `public/index.html`

## LOAN-027 — Header nav links all point to #dead

- **Category:** UI
- **Where:** Header primary nav
- **Repro:** Click Products, Rates, Help, or Sign in.
- **Wrong behavior:** Every link is `href="#dead"` and does not navigate to real destinations.
- **Source:** `public/index.html`

## LOAN-028 — Landing says starred fields are optional

- **Category:** copy
- **Where:** Landing step hint copy
- **Repro:** Read “Fields marked with * are optional.” then leave a starred field empty on Identity.
- **Wrong behavior:** Copy claims optional; validation treats starred fields as required.
- **Source:** `public/index.html`

## LOAN-029 — ETA claims “2 minutes”

- **Category:** UX / copy
- **Where:** Landing estimated time line
- **Repro:** Read the ETA on landing.
- **Wrong behavior:** Multi-step identity/contact/property/review flow is described as “2 minutes”, which understates effort.
- **Source:** `public/index.html`

## LOAN-030 — DOB free text only accepts M/D/YYYY (rejects ISO)

- **Category:** form
- **Where:** Identity DOB field
- **Repro:** Enter `1988-03-15` (ISO) and submit identity.
- **Wrong behavior:** Only `M/D/YYYY` is accepted; ISO and other common formats fail with a format error.
- **Source:** `public/app.js` (`parseDob`)

## LOAN-031 — Duplicate Oregon option in state select

- **Category:** UI
- **Where:** Contact state dropdown
- **Repro:** Open the state list and scan for Oregon — it appears twice.
- **Wrong behavior:** Two `<option value="OR">Oregon</option>` entries confuse selection.
- **Source:** `public/index.html`

## LOAN-032 — Review omits SSN and phone

- **Category:** UX
- **Where:** Review summary list
- **Repro:** Complete steps to review; scan the summary.
- **Wrong behavior:** SSN and phone are collected earlier but never shown for confirmation before submit.
- **Source:** `public/app.js` (`renderReview`)

## LOAN-033 — “bussiness days” typo on confirmation

- **Category:** copy
- **Where:** Confirmation step body copy
- **Repro:** Reach success/confirmation; read the follow-up sentence.
- **Wrong behavior:** Text says “2–3 **bussiness** days” (misspelled “business”).
- **Source:** `public/index.html`

## LOAN-034 — DOB year greater than 2020 is rejected

- **Category:** form
- **Where:** Identity DOB validation (same `parseDob` as LOAN-030)
- **Repro:** Enter `1/1/2021` (or any year > 2020) as DOB.
- **Wrong behavior:** Validation rejects with “Birth year must be 2020 or earlier,” blocking young legitimate applicants and recent dates.
- **Source:** `public/app.js` (`parseDob`)

## LOAN-035 — Review Cancel only returns to landing (no reset)

- **Category:** UX
- **Where:** Review step Cancel control (`#cancel-btn`)
- **Repro:** Complete steps through review, click Cancel, then click “Click here” to start again.
- **Wrong behavior:** Cancel navigates to the landing step only. Forms and `state.identity` / `state.contact` / `state.property` are not cleared, so resuming the wizard still shows the previous answers. There is no abandon confirmation.
- **Source:** `public/app.js` (`wireReview` cancel handler)

---

## Summary

| Category              | Count (approx.) |
|-----------------------|-----------------|
| copy                  | 9+              |
| UX                    | 8+              |
| a11y                  | 6+              |
| UI                    | 6+              |
| form / validation     | 8+              |
| CSS                   | 4+              |

**Total documented defects:** 35 (`LOAN-001` … `LOAN-035`)

Happy path still works: start → identity → contact (use the quiet Next) → property → review → submit → confirmation with `HL-…` reference from `POST /api/applications`.
