# Loanpoint — product specification

Loanpoint is the desk console used by Fairmont University Media Services to
lend camera, audio, lighting, support and computing kit to staff and students.
One desk supervisor is signed in at all times; there is no sign-in screen and
no borrower-facing side. Everything in this document is what the product does.
A behaviour that contradicts this document is a defect.

This is the study's oracle. Every displayed number can be recomputed from the
rules and the seeded data below, so any observed value can be judged correct or
incorrect from this document alone.

---

## 1. Conventions

### 1.1 The desk clock

The desk clock is **frozen**. The application never reads the machine clock.

- Default frozen instant: **2026-03-16T09:00:00Z**, a Monday.
- "Today", "the desk day" and "the desk date" all mean **2026-03-16**.
- All times are desk time (UTC) and are shown as 24-hour `HH:MM`.
- The footer of every page shows `Desk time Mon 16 Mar 2026, 09:00`.

### 1.2 Business days

Monday to Friday are business days. The desk is closed on Saturday and Sunday.

### 1.3 Date and money formats

| Kind | Format | Example |
|---|---|---|
| Date in prose, tables, summaries | `Ddd D Mmm YYYY` (no leading zero on the day) | `Thu 5 Mar 2026`, `Mon 16 Mar 2026` |
| Date and time | `Ddd D Mmm YYYY, HH:MM` | `Wed 11 Mar 2026, 17:00` |
| Date inside a date-field message | `YYYY-MM-DD` | `Pickup date must be on or before 2026-03-30.` |
| Money | `$` + thousands separators + exactly two decimals | `$0.00`, `$45.00`, `$1,131.00`, `$9,000.00` |
| A subtracted amount | prefixed with a minus sign | `−$23.10` |
| Units | `1 unit`, `2 units` | |
| Days | `1 day`, `7 days` | |

### 1.4 Page chrome

Every page carries the same header: the Loanpoint wordmark (links to the desk
overview), navigation links **Overview**, **Equipment**, **Loans**,
**Approvals**, the signed-in operator `Rowan Ellis · Desk supervisor`, and a
primary **New loan** button. The navigation link for the section being viewed
is marked as the current page.

The **Approvals** link carries a count badge showing how many requests are
awaiting a decision. The badge is hidden when that count is zero, and it
updates after any action that changes the count, without a page reload.

The footer shows `Fairmont University Media Services · Kessler Building, room
118` and the desk time line from §1.1.

### 1.5 Routes and page titles

| Route | Page | Title |
|---|---|---|
| `/` | Desk overview | `Desk overview · Loanpoint` |
| `/equipment` | Equipment catalogue | `Equipment · Loanpoint` |
| `/equipment/:id` | One catalogue item | `<item name> · Loanpoint` |
| `/loans` | Loans list | `Loans · Loanpoint` |
| `/loans/:id` | One loan | `Loan <id> · Loanpoint` |
| `/new-loan` | New-loan flow | `New loan · Step <n> of 3 · Loanpoint` |
| `/approvals` | Approvals queue | `Approvals · Loanpoint` |
| anything else | Page not found | `Page not found · Loanpoint` |

Filters are carried in the query string, so a filtered view can be linked to
and reloaded (§5.1, §6.1).

### 1.6 Feedback conventions

- A completed action shows a **success banner** at the top of the page it
  lands on, carrying the exact message quoted in this document.
- A refused action shows an **error banner** carrying the exact message quoted
  in this document.
- A rejected form shows the message for each bad field directly beneath that
  field, and moves keyboard focus to the first bad field. Fields that are now
  acceptable have their message cleared.
- The browser checks a form before sending it; the desk server checks it
  again. Both use the same message text, so a given mistake produces the same
  words whichever check catches it.

---

## 2. Business rules

Every rule below is used by both the interface and the desk server.

### R1 — Loan statuses

| Status | Shown as | Meaning |
|---|---|---|
| `pending_approval` | `Awaiting approval` | Booked; waiting for a supervisor decision |
| `ready` | `Ready for pickup` | Approved (or never needed approval); waiting on the shelf |
| `out` | `Out` | Collected by the borrower |
| — | `Overdue` | Derived, see R7 |
| `returned` | `Returned` | Checked back in |
| `cancelled` | `Cancelled` | Withdrawn before pickup |
| `declined` | `Declined` | Refused by a supervisor |

### R2 — Availability

For each catalogue item:

```
available units = total units − units committed by open loans
```

A loan commits its units while its status is `pending_approval`, `ready` or
`out`. `returned`, `cancelled` and `declined` loans commit nothing. Available
units are never shown below zero.

### R3 — Due date

```
due date = pickup date + loan period in calendar days
if that date is a Saturday, add 2 days
if that date is a Sunday,   add 1 day
```

The loan period is 1, 3, 7 or 14 days. The due **time** is always 17:00 desk
time. The due date is fixed when the loan is booked and does not move if the
borrower collects late.

Worked results: pickup Mon 16 Mar + 7 days = **Mon 23 Mar**; pickup Thu 19 Mar
+ 3 days lands on Sunday 22 Mar and becomes **Mon 23 Mar**; pickup Fri 20 Mar
+ 1 day lands on Saturday 21 Mar and becomes **Mon 23 Mar**.

### R4 — Charges for a loan

Let each line be one catalogue item with a quantity.

```
base charge   = Σ (daily rate × quantity × loan period in days)
unit count    = Σ quantity
bundle discount = 10% of the base charge, when unit count ≥ 3; otherwise $0.00
deposit       = Σ (10% of replacement value × quantity), counting only items
                whose replacement value is $1,000.00 or more
total due at pickup = base charge − bundle discount + deposit
```

All percentages are rounded to the nearest cent, halves up. The deposit is
refundable (R9). The bundle discount threshold is **three units in total**, not
three distinct items: three units of one item qualifies.

Worked result (loan L-1042): Canon C70 ($18.00/day) + Manfrotto tripod
($4.00/day) + Aputure light ($11.00/day), one unit each, 7 days.
Base charge $231.00; 3 units so bundle discount $23.10; deposit $540.00 +
$0.00 + $129.00 = $669.00; total due **$876.90**.

### R5 — Supervisor approval

A loan needs supervisor approval when **either**:

- the total replacement value of its units is **$2,500.00 or more**, or
- the loan period is **14 days**.

Otherwise it is booked straight to `ready`. The reasons are shown in these
exact words:

- `Replacement value $9,000.00 is at or above the $2,500.00 threshold.`
  (with the loan's own replacement total)
- `Loan period is 14 days.`

A loan that trips both rules shows both reasons, value first.

### R6 — Charges booked today

```
charges booked today
  = Σ total due at pickup, over loans booked on the desk date whose status is
    not cancelled and not declined
  + Σ late fee, over loans checked in on the desk date
```

### R7 — Overdue

A loan is overdue when its status is `out` **and** the desk date is later than
its due date. A loan due today is not yet overdue. An overdue loan shows the
status `Overdue` everywhere in place of `Out`.

### R8 — Late fee

```
late business days = business days after the due date, up to and including
                     the desk date
late fee = late business days × $5.00 × unit count, capped at $150.00 per loan
```

A loan returned on or before its due date has a late fee of $0.00.

Worked result (loan L-1042): due Wed 11 Mar, desk date Mon 16 Mar. The
business days after 11 Mar up to 16 Mar are Thu 12, Fri 13 and Mon 16 — three
days. Three units. Late fee **$45.00**.

### R9 — Deposit outcome at check-in

| Situation | Outcome | Sentence used |
|---|---|---|
| Deposit is $0.00 | `none` | `No deposit was held on this loan.` |
| Condition is Good | `released` | `Deposit of $669.00 released.` |
| Condition is Damaged or Missing parts | `held` | `Deposit of $669.00 held pending inspection.` |

### R10 — Extension

A loan may be extended when all three hold: its status is `out`, it is not
overdue, and it has not been extended before. Extending adds **7 calendar
days** to the current due date and then applies the weekend roll-forward of R3.
Each loan may be extended **once**. Extending is free — no charge changes.

When extension is not allowed the reason is one of, exactly:

- `Only a loan that is out can be extended.`
- `An overdue loan cannot be extended. Check it in first.`
- `This loan has already used its one extension.`

### R11 — Pickup

A loan with status `ready` may be marked picked up on or after its pickup date;
its status becomes `out`. Before its pickup date the action is refused with
`This loan is scheduled for pickup on Wed 18 Mar 2026.` (that loan's own pickup
date, long format).

### R12 — Cancel

A loan with status `pending_approval` or `ready` may be cancelled. Its status
becomes `cancelled` and its units return to the available pool immediately.

### R13 — Pickup lead time

A pickup date must be a business day, not in the past, and no more than **14
calendar days** after the desk date. With the frozen clock the accepted window
is **2026-03-16 to 2026-03-30 inclusive**, weekdays only.

---

## 3. Seeded data

`POST /__reset` restores exactly this state.

### 3.1 Catalogue (12 items, 53 units)

| Item | Asset tag | Category | Total units | Daily rate | Replacement value | Deposit per unit (R4) | Available at reset (R2) |
|---|---|---|---|---|---|---|---|
| Canon C70 Cinema Camera | CAM-C70 | Cameras | 3 | $18.00 | $5,400.00 | $540.00 | 1 |
| Sony A7 IV Mirrorless Kit | CAM-A74 | Cameras | 4 | $12.00 | $2,900.00 | $290.00 | 3 |
| GoPro Hero 12 Action Kit | CAM-GP12 | Cameras | 6 | $6.00 | $480.00 | none | 4 |
| Zoom H6 Field Recorder | AUD-H6 | Audio | 5 | $5.00 | $420.00 | none | 4 |
| Rode Wireless GO II Lav Pair | AUD-WGO2 | Audio | 8 | $4.00 | $360.00 | none | 7 |
| Sennheiser MKH-416 Boom Kit | AUD-416 | Audio | 2 | $9.00 | $1,450.00 | $145.00 | 1 |
| Aputure 300x LED Light | LIG-300X | Lighting | 4 | $11.00 | $1,290.00 | $129.00 | 3 |
| Lantern Softbox Kit | LIG-LAN | Lighting | 3 | $3.00 | $260.00 | none | 3 |
| Manfrotto 504X Tripod | SUP-504X | Support | 6 | $4.00 | $540.00 | none | 5 |
| DJI RS 4 Pro Gimbal | SUP-RS4 | Support | 2 | $10.00 | $1,020.00 | $102.00 | 0 |
| MacBook Pro 16" Edit Laptop | COM-MBP16 | Computing | 3 | $15.00 | $3,600.00 | $360.00 | 2 |
| Samsung T9 4TB SSD | COM-T9 | Computing | 7 | $2.00 | $210.00 | none | 7 |

Total 53 units, of which **40 are available** at reset.

Each item also carries a prose description and four specification rows
(label/value pairs) on its detail page.

Categories, in the order they appear in the category filter after "All":
Audio, Cameras, Computing, Lighting, Support.

Departments, in the order they appear in the department list:
Architecture, Athletics, Design, Film & Media, Journalism, Music, Student Life.

### 3.2 Loans (8)

| Loan | Borrower | Department | Items (units) | Period | Pickup | Due | Status | Booked |
|---|---|---|---|---|---|---|---|---|
| L-1041 | Priya Raman | Journalism | Sony A7 IV (1), Rode lav pair (1) | 7 days | Mon 9 Mar 2026 | Mon 16 Mar 2026 | Out | Thu 5 Mar 2026, 10:42 |
| L-1042 | Marcus Webb | Film & Media | Canon C70 (1), Manfrotto tripod (1), Aputure light (1) | 7 days | Wed 4 Mar 2026 | Wed 11 Mar 2026 | **Overdue** | Mon 2 Mar 2026, 14:05 |
| L-1043 | Dana Okoye | Athletics | GoPro Hero 12 (2) | 3 days | Tue 17 Mar 2026 | Fri 20 Mar 2026 | Ready for pickup | Fri 13 Mar 2026, 10:05 |
| L-1044 | Theo Lindqvist | Music | Sennheiser boom kit (1), Zoom H6 (1) | 14 days | Mon 16 Mar 2026 | Mon 30 Mar 2026 | Awaiting approval | Mon 16 Mar 2026, 08:20 |
| L-1045 | Aisha Farouk | Architecture | MacBook Pro (1), Canon C70 (1) | 7 days | Wed 18 Mar 2026 | Wed 25 Mar 2026 | Awaiting approval | Fri 13 Mar 2026, 15:40 |
| L-1046 | Owen Castillo | Journalism | Zoom H6 (1) | 3 days | Mon 2 Mar 2026 | Thu 5 Mar 2026 | Returned | Fri 27 Feb 2026, 11:00 |
| L-1047 | Sofia Marchetti | Film & Media | Lantern softbox (2), Manfrotto tripod (1) | 1 day | Tue 10 Mar 2026 | Wed 11 Mar 2026 | Cancelled | Mon 9 Mar 2026, 09:15 |
| L-1048 | Nina Brandt | Design | DJI RS 4 Pro gimbal (2) | 7 days | Thu 12 Mar 2026 | Thu 19 Mar 2026 | Out | Wed 11 Mar 2026, 13:00 |

Charges on each seeded loan, all reproducible from R4:

| Loan | Base charge | Bundle discount | Deposit | Total due |
|---|---|---|---|---|
| L-1041 | $112.00 | $0.00 | $290.00 | $402.00 |
| L-1042 | $231.00 | $23.10 | $669.00 | $876.90 |
| L-1043 | $36.00 | $0.00 | $0.00 | $36.00 |
| L-1044 | $196.00 | $0.00 | $145.00 | $341.00 |
| L-1045 | $231.00 | $0.00 | $900.00 | $1,131.00 |
| L-1046 | $15.00 | $0.00 | $0.00 | $15.00 |
| L-1047 | $10.00 | $1.00 | $0.00 | $9.00 |
| L-1048 | $140.00 | $0.00 | $204.00 | $344.00 |

Other seeded facts:

- L-1041 and L-1042 were approved by Rowan Ellis before pickup; L-1044 and
  L-1045 are the two undecided requests.
- L-1046 was returned Thu 5 Mar 2026, 14:20 in Good condition, late fee $0.00,
  no deposit held.
- L-1047 was cancelled Mon 9 Mar 2026, 16:30.
- No loan has used its extension.
- The next loan booked is numbered **L-1049**, then L-1050, and so on.
- Purposes, in order L-1041 to L-1048: `Election night interviews for the
  campus newsroom.`, `Third-year thesis shoot, two exterior locations.`,
  `Helmet-cam coverage of the inter-college relay.`, `Two-week residency
  recording in the chapel.`, `Site survey film for the riverside studio
  project.`, `Vox pops on the science quad.`, `Portrait lighting workshop,
  cancelled by the tutor.`, `Moving-camera sequences for the degree show reel.`

### 3.3 Derived starting values

| Value | At reset |
|---|---|
| Out on loan | 3 |
| Overdue | 1 (L-1042, 3 business days late, $45.00 late fee if returned today) |
| Due back today | 1 (L-1041, due Mon 16 Mar 2026, 17:00) |
| Awaiting approval | 2 (L-1044, L-1045) |
| Ready for pickup | 1 (L-1043) |
| Units available | 40 of 53 |
| Charges booked today | $341.00 (L-1044 only) |

---

## 4. Flow A — Desk overview (`/`)

Heading `Desk overview`, subtitle `Desk day Mon 16 Mar 2026`, and a
`Start a new loan` button that opens the new-loan flow.

### 4.1 Counter tiles

Seven tiles, in this order. Each shows a label, a value and a one-line note.
The tiles marked "links to" are clickable and open the linked view.

| Tile | Value | Note | Links to |
|---|---|---|---|
| Out on loan | count of loans with status `out` | `Currently with borrowers` | `/loans?status=out` |
| Overdue | count of overdue loans (R7) | `Past the 17:00 due time` | `/loans?status=overdue` |
| Due back today | count of `out` loans whose due date is the desk date | `Expected at the desk by 17:00` | — |
| Awaiting approval | count of loans with status `pending_approval` | `Needs a supervisor decision` | `/approvals` |
| Ready for pickup | count of loans with status `ready` | `Approved and waiting on the shelf` | `/loans?status=ready` |
| Units available | total available units (R2) | `of 53 units in the catalogue` | `/equipment?availableOnly=1` |
| Charges booked today | R6, as money | `New loans and late fees` | — |

The "of N units in the catalogue" note uses the catalogue's total unit count.

### 4.2 Four lists

**Overdue loans** — columns Loan, Borrower, Items, Due, Business days late,
Late fee today. "Late fee today" is R8 evaluated for the desk date. Sorted by
due date, earliest first. Empty state: heading `No overdue loans`, body
`Every loan that is out is still within its due date.`

**Due back today** — columns Loan, Borrower, Items, Due (date and time).
Empty state: `Nothing due today` / `No loan reaches its due date on this desk
day.`

**Ready for pickup** — columns Loan, Borrower, Items, Pickup. Sorted by pickup
date, earliest first. Empty state: `No loans waiting for pickup` /
`Nothing is boxed up on the collection shelf.`

**Awaiting approval** — columns Loan, Borrower, Items, Status, Total due.
Empty state: `Nothing waiting for approval` / `Every request has been decided.`

In every list the Loan cell links to that loan, and the Items cell reads
`<first item name> (N units)` for a one-item loan or
`<first item name> + M more (N units)` when the loan has more than one line,
where M is the number of further lines and N the total units.

---

## 5. Flow B — Equipment (`/equipment`, `/equipment/:id`)

### 5.1 Catalogue list

Filter panel, all three controls applying together on **Apply filters**:

- **Search equipment** — free text, matched case-insensitively against the
  item name, its asset tag and its description.
- **Category** — `All` plus the five categories.
- **Available now only** — a checkbox; when ticked only items with at least one
  available unit are listed.

`Clear filters` returns to the unfiltered catalogue. The active filters are
carried in the URL as `q`, `category` and `availableOnly=1`.

Above the results: `Showing X of 12 equipment items.` X is the number listed;
12 is the whole catalogue regardless of filters.

Results are a table sorted by item name A→Z, with columns Item (name, asset tag
beneath, name links to the item), Category, Availability, Daily rate, Deposit
per unit. Availability reads `N of M available`, or the pill `Fully booked`
when no units are free. Deposit per unit reads `None` for items below the
$1,000.00 threshold. The daily-rate cell reads `$18.00 / day`.

**Empty state**: heading `No equipment matches these filters`; body
`Nothing in the catalogue matches “<search text>”.` when a search term was
used, otherwise `No catalogue item matches the filters you picked.`; and a
`Clear filters` button.

### 5.2 Item detail

Heading is the item name; the subtitle is its description. A `Start a new loan`
button opens the new-loan flow. A breadcrumb links back to Equipment.

**Desk record**: Asset tag, Category, Availability (`N of M units free`, or
`Fully booked — 0 of M units free`), Daily rate (`$18.00 per unit per day`),
Replacement value, Deposit per unit (`$540.00 (refundable)` or
`No deposit required`).

**Specification**: the four label/value rows for that item.

**On loan now**: every open loan (R2) holding units of this item, sorted by
loan number, with columns Loan, Borrower, Units, Status, Due. Empty state:
`All units are on the shelf` / `No open loan is holding this item right now.`

An unknown item id shows the heading `Something went wrong` with the error
banner `That equipment item does not exist.` (§11).

---

## 6. Flow C — Loans (`/loans`, `/loans/:id`)

### 6.1 Loans list

Filter panel: **Status** (`All loans`, `Awaiting approval`, `Ready for pickup`,
`Out`, `Overdue`, `Returned`, `Cancelled`, `Declined`) and **Search** (loan
number or borrower name, case-insensitive substring), applied together on
`Apply filters`, with `Clear filters` alongside. Filters are carried in the URL
as `status` and `q`.

`Out` lists every loan with status `out`, including overdue ones. `Overdue`
lists only the overdue subset.

Above the results: `Showing X of 8 loans.` — X is the number listed, and the
second number is the total number of loans on the desk, whatever the filters.

Results table, sorted by loan number descending (newest first), with columns
Loan (links to the loan), Borrower (name, department beneath), Items (as in
§4.2), Status, Pickup, Due, Total due.

**Empty state**: heading `No loans match these filters`; body
`Nothing matches “<search text>” with the status you picked.` when a search
term was used, otherwise `No loan currently has that status.`; and a
`Clear filters` button.

### 6.2 Loan detail

Heading `Loan L-1042` with the status shown beside it as a pill; subtitle
`<borrower> · <department> · booked <date and time>`. A breadcrumb links back
to Loans.

**Borrower** panel: Name, Email (a mail link), Department, Purpose
(`No purpose recorded.` when the loan has none).

**Schedule** panel: Pickup date, Loan period, Due back (date and time),
Extension (`None used (one allowed)` or `One 7-day extension used`), and then
Picked up, Returned or Cancelled timestamps where they apply.

**Items** panel, headed `Items (N units)`: one row per line with the item name
(linking to the item), asset tag, Units, Daily rate, `Charge for 7 days`
(the column heading names the loan's own period), and Deposit (`—` when the
item carries no deposit).

**Charges** panel: `Base charge`, `Bundle discount (3+ units)` shown only when
the discount is not zero, `Refundable deposit`, `Total due at pickup`. A
returned loan adds one line: `Late fee charged on return: $45.00.` or
`No late fee was charged on return.`

**Return record** panel (returned loans only): Checked in, Condition, Note
(only when one was given), Late fee, Deposit (the sentence from R9, without the
word "Deposit": `$669.00 held pending inspection.`, `$290.00 released.`, or
`No deposit was held on this loan.`).

**Declined** panel (declined loans only): `Declined by Rowan Ellis on <date and
time>.` and `Reason: <reason>`.

**Cancelled** panel (cancelled loans only): `This loan was cancelled on <date
and time> and its units went back into stock.`

#### Actions by status

**Awaiting approval** — panel `Awaiting supervisor approval` listing the R5
reasons, a `Go to approvals` button, and `Cancel loan`.

**Ready for pickup** — panel `Ready for pickup`. When the pickup date has
arrived the line reads `<borrower> can collect this loan today.` and
`Mark picked up` is enabled; otherwise the line is the R11 refusal sentence and
`Mark picked up` is disabled. `Cancel loan` is also offered.

On success: the page reloads in place with the success banner
`L-1044 is now out with Theo Lindqvist.`

**Out** — panel `Out with the borrower`, containing:

*Extension*: when allowed, the line
`One extension is allowed. It would move the due date to Thu 26 Mar 2026.` and
an enabled `Extend by 7 days` button; otherwise the R10 reason and a disabled
button. On success the banner reads
`Extended. L-1048 is now due Thu 26 Mar 2026 at 17:00.`

*Check in*: a heading `Check in` and, above the form, either
`This loan is 3 business days late. Checking in today charges a late fee of
$45.00.` (using R8, singular `1 business day` when only one) or
`Checking in today charges no late fee.` Loans carrying a deposit also show
`The $669.00 deposit is released when the kit comes back in good condition,
and held for inspection otherwise.`

The form has **Returned condition** (a list: `Choose a condition`, `Good —
ready to lend again`, `Damaged`, `Missing parts`) and **Condition note** (hint:
`Required when the kit is damaged or missing parts (at least 10 characters).`),
and a `Check in` button.

**Returned, Cancelled, Declined** — no actions.

#### Cancel confirmation

`Cancel loan` does not act immediately. It reveals a confirmation block reading
`Cancel L-1043? Its 2 units go back into stock straight away.` with
`Yes, cancel loan` and `Keep loan`. `Keep loan` closes the block and changes
nothing. On success the banner reads
`L-1043 cancelled. 2 units are back in stock.` (`1 unit is back in stock.` for
a single-unit loan).

---

## 7. Flow D — New loan (`/new-loan`), three steps

A progress list at the top names the three steps — `1. Borrower`,
`2. Items and dates`, `3. Review and confirm` — and marks the current one.

The draft is held by the desk, not the page. Once step 1 is complete the URL
carries the draft, as `/new-loan?draft=D-1&step=2`, so the flow survives a
reload and a step backwards; going back to an earlier step shows the values
already entered.

### 7.1 Step 1 — Borrower

Heading `Step 1 — who is borrowing?`. Fields: **Borrower name**,
**Borrower email** (hint `Must be a fairmont.edu address.`), **Department**
(a list starting `Choose a department`), **Purpose (optional)** (hint
`What the kit is for. 200 characters at most.`). Buttons:
`Continue to items` and `Cancel` (returns to the loans list).

Validation:

| Field | Condition | Message |
|---|---|---|
| Borrower name | empty | `Enter the borrower's full name.` |
| Borrower name | one character | `Borrower name must be at least 2 characters.` |
| Borrower email | empty | `Enter the borrower's email address.` |
| Borrower email | does not end in `@fairmont.edu` (any letter case accepted) | `Borrower email must be a fairmont.edu address.` |
| Department | not chosen, or not one of the seven | `Choose a department.` |
| Purpose | more than 200 characters | `Purpose must be 200 characters or fewer.` |

All failing fields are reported at once.

### 7.2 Step 2 — Items and dates

Heading `Step 2 — what is going out, and when?`, with the line
`Booking for <borrower name>.`

**Equipment**: an `Add equipment` list of catalogue items reading
`<name> — N of M available`, or `<name> — fully booked` (not selectable) when
no units are free, and an `Add item` button. Items already on the loan are not
offered again; when every item is on the loan the list reads
`Every item is already on this loan` and adding is disabled.

Each added item becomes a row in a table with the columns Item, Units, Daily
rate, Action: the item name with `N of M available` beneath it, a units box
(minimum 1, maximum the available units), the daily rate, and a `Remove`
button. Before anything is added the area shows
`No items on this loan yet` / `Pick equipment from the list above to build the
loan.`

**Loan period**: radio buttons `1 day`, `3 days`, `7 days`, `14 days`; a new
draft starts on `3 days`.

**Pickup date**: a date field, hint `A weekday from 2026-03-16 to 2026-03-30.
The due date is confirmed on the next step.` A new draft starts on the desk
date.

Buttons: `Back to borrower` and `Continue to review`.

Validation:

| Field | Condition | Message |
|---|---|---|
| Equipment | no items added | `Add at least one item to this loan.` |
| Equipment | item not in the catalogue | `That equipment is no longer in the catalogue.` |
| Equipment | the same item added twice | `Each item can appear only once on a loan.` |
| Equipment | units below 1, or not a whole number | `Quantity must be at least 1.` |
| Equipment | more units than are free, one free | `Only 1 unit of Canon C70 Cinema Camera is available.` |
| Equipment | more units than are free, several free | `Only 2 units of MacBook Pro 16" Edit Laptop are available.` |
| Equipment | none free | `DJI RS 4 Pro Gimbal has no units available.` |
| Loan period | not 1, 3, 7 or 14 | `Choose a loan period.` |
| Pickup date | empty | `Choose a pickup date.` |
| Pickup date | not a real `YYYY-MM-DD` date | `Enter a pickup date as YYYY-MM-DD.` |
| Pickup date | before the desk date | `Pickup date cannot be in the past.` |
| Pickup date | more than 14 days ahead | `Pickup date must be on or before 2026-03-30.` |
| Pickup date | a Saturday or Sunday | `The desk is closed at weekends. Choose a weekday.` |

Only one equipment message is shown at a time; structural problems are reported
before availability. The pickup-date checks are applied in the order listed, so
a blank field reports only "Choose a pickup date."

### 7.3 Step 3 — Review and confirm

Heading `Step 3 — review and confirm`.

**Borrower** summary (Name, Email, Department, Purpose) and **Schedule**
summary (Pickup, Loan period, Due back as date and time from R3, Units).

**Items**: one row per line — Item, Units, Daily rate, Charge, Deposit.

**Charges**: the R4 breakdown, exactly as in §6.2.

Then either the notice **`This loan needs supervisor approval before pickup.`**
with the R5 reasons listed beneath it, or the line
`No approval needed — this loan goes straight to the pickup shelf.`

Buttons: `Back to items` and `Confirm booking`.

**Confirming** is asynchronous. While it runs, the button is disabled and reads
`Booking…`, and the line `Booking this loan…` appears beside it. It settles in
0.9 seconds. The page then goes to the new loan's page, showing a success
banner:

- `L-1049 booked and sent for supervisor approval.` when approval is needed;
- `L-1049 booked and ready for pickup on Tue 17 Mar 2026.` when it is not.

The new loan appears in the loans list, in the approvals queue when relevant,
in the desk overview counters, and its units leave the available pool.

If another loan has taken the last free units while the draft sat on step 3,
confirming fails with the matching availability message from §7.2 shown as an
error banner, and no loan is created.

Once a draft is confirmed it is gone: returning to its step-3 address shows
`That draft loan has expired. Start a new loan.` and the flow restarts at
step 1.

---

## 8. Flow E — Approvals (`/approvals`)

Heading `Approvals`; subtitle `2 requests are waiting for a supervisor
decision` (`1 request is waiting for a supervisor decision` when there is one).

One card per waiting request, ordered by loan number ascending, each showing:

- the loan number (linking to the loan) and the borrower name, with the
  department to the right;
- the purpose;
- a list: the R5 reasons, then
  `2 units for 14 days, pickup Mon 16 Mar 2026, due Mon 30 Mar 2026.`, then
  `Total due at pickup $341.00.`;
- an items table: Item, Units, Charge, Deposit;
- an `Approve` button and a `Decline` button.

**Approve** is asynchronous: the button is disabled and reads `Approving…` with
the line `Recording your approval…` beside it, settling in 0.6 seconds. The
loan's status becomes `Ready for pickup`, its units stay committed, and the
queue reloads with the banner
`L-1044 approved and moved to ready for pickup.`

**Decline** reveals a form rather than acting immediately: a
`Why is L-1044 being declined?` box (hint `The borrower sees this reason on the
loan record.`), a `Confirm decline` button and a `Keep in queue` button.
`Keep in queue` closes the form and changes nothing. A reason shorter than five
characters is refused with
`Give a reason for declining (at least 5 characters).`

Confirming is asynchronous, disabled and reading `Declining…` with the line
`Recording your decision…`, settling in 0.6 seconds. The loan's status becomes
`Declined`, its units return to the available pool, the reason is stored on the
loan, and the queue reloads with the banner
`L-1045 declined. 2 units are back in stock.` (`1 unit is back in stock.` for a
single-unit loan).

Deciding a request also updates the header badge and the desk overview.

**Empty state**: heading `Nothing waiting for approval`; body `Every request
has been decided. New requests appear here when a loan is worth $2,500 or more,
or runs for 14 days.`; and a `View all loans` button.

An approval that has already been decided cannot be decided again:
`This loan is no longer awaiting approval.`

---

## 9. Asynchronous actions

Four actions take visible time. Each is deterministic — the same duration every
time — and each shows a disabled button with a changed label plus a status line
while it runs.

| Action | Duration | Button label while running | Status line |
|---|---|---|---|
| Confirm booking (§7.3) | 0.9 s | `Booking…` | `Booking this loan…` |
| Check in (§6.2) | 0.7 s | `Checking in…` | `Checking this loan in…` |
| Approve (§8) | 0.6 s | `Approving…` | `Recording your approval…` |
| Confirm decline (§8) | 0.6 s | `Declining…` | `Recording your decision…` |

Marking a loan picked up, extending a loan and cancelling a loan are immediate.

---

## 10. Check-in results

Checking a loan in sets its status to `Returned`, records the desk clock as the
return time, stores the condition and note, applies R8 and R9, frees the units,
and reloads the loan page with a success banner made of three sentences:

```
<loan id> checked in. <fee sentence> <deposit sentence>
```

- fee sentence: `Late fee of $45.00 charged.` when the fee is above zero,
  otherwise `Returned on time, no late fee.`
- deposit sentence: the R9 sentence.

Worked result: `L-1042 checked in. Late fee of $45.00 charged. Deposit of
$669.00 held pending inspection.`

---

## 11. Refusals

Actions that no longer make sense are refused with these exact sentences:

| Attempt | Message |
|---|---|
| Mark picked up on a loan that is not ready | `Only a loan that is ready for pickup can be marked picked up.` |
| Mark picked up before the pickup date | `This loan is scheduled for pickup on Tue 17 Mar 2026.` |
| Check in a loan that is not out | `Only a loan that is out can be checked in.` |
| Extend a loan that is not out | `Only a loan that is out can be extended.` |
| Extend an overdue loan | `An overdue loan cannot be extended. Check it in first.` |
| Extend a loan already extended | `This loan has already used its one extension.` |
| Cancel a loan that is not awaiting approval or ready | `Only a loan awaiting approval or ready for pickup can be cancelled.` |
| Decide a request that is already decided | `This loan is no longer awaiting approval.` |
| Open a draft that no longer exists | `That draft loan has expired. Start a new loan.` |
| Open a loan that does not exist | `That loan does not exist.` |
| Open an equipment item that does not exist | `That equipment item does not exist.` |

Opening a loan or an equipment item that does not exist replaces the page with
the heading `Something went wrong` and the message above in an error banner.
The desk system being unreachable gives the same page with
`The desk system is not responding. Try again.`

An unknown **address** shows the page-not-found view instead: heading
`Page not found`, subtitle `That address is not part of the lending desk.`, and
the block `Nothing lives at this address` / `Check the link, or start again
from the desk overview.` with a `Go to desk overview` button.

---

## 12. Page copy

Headings, subtitles and other fixed wording not already quoted above.

### 12.1 Page headings and subtitles

| Page | Heading | Subtitle |
|---|---|---|
| Desk overview | `Desk overview` | `Desk day Mon 16 Mar 2026` |
| Equipment | `Equipment` | `Everything the Kessler desk lends out` |
| Item detail | the item name | the item's description |
| Loans | `Loans` | `Every request the desk has taken, newest first` |
| Loan detail | `Loan L-1042` + status pill | `Marcus Webb · Film & Media · booked Mon 2 Mar 2026, 14:05` |
| New loan | `New loan` | `Book equipment out to a borrower in three steps.` |
| Approvals | `Approvals` | see §8 |
| Page not found | `Page not found` | `That address is not part of the lending desk.` |

The Desk overview, Equipment and Loans pages each carry a
`Start a new loan` button beside the heading; the item detail page carries one
too.

### 12.2 Table captions

| Table | Caption |
|---|---|
| Overview → Overdue loans | `Late fees shown are what the borrower owes if the kit comes back today.` |
| Overview → Due back today | `Expected at the desk before the 17:00 cut-off.` |
| Overview → Ready for pickup | `Approved loans waiting for the borrower to collect.` |
| Overview → Awaiting approval | `Requests held until a supervisor decides.` |
| Equipment list | `Daily rate is charged to the borrower's department.` |
| Item detail → Specification | `What comes in the case.` |
| Item detail → On loan now | `Open loans holding units of this item.` |
| Loans list | `Newest loan first.` |
| Approvals → items | `Items on this request.` |

### 12.3 Section headings on the loan page

`Borrower`, `Schedule`, `Items (N units)`, `Charges`, `Return record`,
`Declined`, `Cancelled`, and one of `Awaiting supervisor approval`,
`Ready for pickup`, `Out with the borrower`. Inside the last of those:
`Extension` and `Check in`.

### 12.4 Field placeholders

| Field | Placeholder |
|---|---|
| Equipment search | `Name, asset tag or description` |
| Loan search | `Loan number or borrower` |
| Condition note | `Scratched lens hood, missing battery door…` |
| Decline reason | `Kit already committed to the open day.` |

---

## 13. Scope boundaries

These are deliberate limits, not defects:

- one signed-in supervisor, no authentication, no borrower-facing pages;
- state is held in memory and is lost when the desk server stops;
- no money changes hands — charges are booked against a department;
- no email, printing, export or reporting beyond the pages described here;
- the desk clock is frozen, so nothing ages between visits.
