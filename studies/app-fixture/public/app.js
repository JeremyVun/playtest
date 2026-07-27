// Multi-step home loan capture client — deliberate defects included.
// Happy path still works when valid-looking data is entered carefully.

const state = {
  step: 0,
  identity: {},
  contact: {},
  property: {},
  reference: null,
  submitting: false,
};

const STEPS = [0, 1, 2, 3, 4, 5];

function $(sel, root = document) {
  return root.querySelector(sel);
}

function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function showStep(n) {
  state.step = n;
  for (const section of $all(".step")) {
    const s = Number(section.dataset.step);
    const on = s === n;
    section.classList.toggle("hidden", !on);
    if (on) section.removeAttribute("hidden");
    else section.setAttribute("hidden", "");
  }
  updateProgress(n);
}

/**
 * LOAN-012: progress labels Identity/Contact are swapped in HTML, and
 * highlighting is intentionally wrong — when on step N we mark step N+1
 * (clamped) as active instead of N, except landing.
 */
function updateProgress(step) {
  const items = $all("#progress li");
  for (const li of items) {
    const s = Number(li.dataset.step);
    li.classList.remove("is-active", "is-done");
    // Wrong highlight: offset by +1 for in-progress steps (except 0 and 5)
    let activeTarget = step;
    if (step >= 1 && step <= 4) activeTarget = Math.min(step + 1, 5);
    if (s === activeTarget) li.classList.add("is-active");
    else if (s < step) li.classList.add("is-done");
  }
}

function clearErrors(form) {
  for (const err of $all(".error", form)) {
    err.hidden = true;
    err.textContent = "";
  }
  for (const el of $all(".is-invalid", form)) {
    el.classList.remove("is-invalid");
  }
}

function setError(input, message) {
  if (!input) return;
  input.classList.add("is-invalid");
  const id = input.id;
  const err = document.getElementById(id + "-error");
  if (err) {
    // LOAN-014: property-value may set empty message (color only)
    err.textContent = message || "";
    err.hidden = false;
  }
}

/**
 * LOAN-010: only strips the first comma, then Number() — so "1,250,000"
 * becomes "1250,000" which is NaN (remaining commas break parsing).
 * Single-comma values like "450,000" still parse correctly.
 */
function parseMoney(raw) {
  if (typeof raw !== "string") raw = String(raw ?? "");
  const trimmed = raw.trim().replace(/\$/g, "");
  // Intentionally buggy: replace only the first comma, then Number().
  // Do NOT strip remaining non-digits — that would mask this bug.
  const once = trimmed.replace(",", "");
  return Number(once);
}

/**
 * LOAN-030 / LOAN-034: only accepts M/D/YYYY; rejects ISO; year must be <= 2020.
 */
function parseDob(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) {
    return { ok: false, error: "Use M/D/YYYY format (for example 3/15/1988)." };
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: "Enter a valid calendar date as M/D/YYYY." };
  }
  if (year > 2020) {
    return { ok: false, error: "Birth year must be 2020 or earlier." };
  }
  if (year < 1900) {
    return { ok: false, error: "Birth year looks invalid." };
  }
  return { ok: true, value: `${month}/${day}/${year}`, year, month, day };
}

function validateIdentity(form) {
  clearErrors(form);
  let ok = true;
  const first = $("#first-name", form);
  const last = $("#last-name", form);
  const dob = $("#dob", form);
  const ssn = $("#ssn", form);
  const income = $("#income", form);

  // LOAN-008: when first name empty, error highlights last name field instead
  if (!first.value.trim()) {
    setError(last, "First name is required.");
    ok = false;
  }
  if (!last.value.trim()) {
    // only set last-name empty error if we didn't already misuse it for first name
    if (first.value.trim()) {
      setError(last, "Last name is required.");
    } else if (!$("#last-name-error")?.textContent) {
      setError(last, "Last name is required.");
    }
    ok = false;
  }

  const dobResult = parseDob(dob.value);
  if (!dob.value.trim()) {
    setError(dob, "Date of birth is required.");
    ok = false;
  } else if (!dobResult.ok) {
    setError(dob, dobResult.error);
    ok = false;
  }

  if (!ssn.value.trim()) {
    setError(ssn, "SSN is required.");
    ok = false;
  } else if (ssn.value.replace(/\D/g, "").length < 9) {
    setError(ssn, "Enter a 9-digit SSN.");
    ok = false;
  }

  if (!income.value.trim()) {
    setError(income, "Income is required.");
    ok = false;
  } else {
    const amount = parseMoney(income.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(income, "Enter a positive income amount.");
      ok = false;
    }
  }

  return ok;
}

function validateContact(form) {
  clearErrors(form);
  let ok = true;
  const email = $("#email", form);
  const emailConfirm = $("#email-confirm", form);
  const phone = $("#phone", form);
  const address = $("#address", form);
  const city = $("#city", form);
  const stateEl = $("#state", form);
  const zip = $("#zip", form);

  if (!email.value.trim()) {
    setError(email, "Email is required.");
    ok = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    setError(email, "Enter a valid email address.");
    ok = false;
  }

  // LOAN-025: confirm email only checked non-empty — never compared to email
  if (!emailConfirm.value.trim()) {
    setError(emailConfirm, "Confirm email is required.");
    ok = false;
  }

  // LOAN-007: phone accepts any non-empty string (including letters)
  if (!phone.value.trim()) {
    setError(phone, "Phone is required.");
    ok = false;
  }

  if (!address.value.trim()) {
    setError(address, "Street address is required.");
    ok = false;
  }
  if (!city.value.trim()) {
    setError(city, "City is required.");
    ok = false;
  }
  if (!stateEl.value) {
    setError(stateEl, "State is required.");
    ok = false;
  }
  if (zip.value === "" || zip.value === null) {
    setError(zip, "ZIP is required.");
    ok = false;
  }

  return ok;
}

function validateProperty(form) {
  clearErrors(form);
  let ok = true;
  const prop = $("#property-value", form);
  const loan = $("#loan-amount", form);
  const purpose = $("#purpose", form);
  const consent = $("#consent", form);

  if (!prop.value.trim()) {
    // LOAN-014: empty error text — color-only
    setError(prop, "");
    ok = false;
  } else {
    const v = parseMoney(prop.value);
    if (!Number.isFinite(v) || v <= 0) {
      setError(prop, "");
      ok = false;
    }
  }

  if (!loan.value.trim()) {
    setError(loan, "Loan amount is required.");
    ok = false;
  } else {
    const v = parseMoney(loan.value);
    // LOAN-021: min is 50000 but message says $0
    if (!Number.isFinite(v) || v < 50000) {
      setError(loan, "Loan amount must be at least $0");
      ok = false;
    }
  }

  if (!purpose.value) {
    setError(purpose, "Select a loan purpose.");
    ok = false;
  }

  if (!consent.checked) {
    setError(consent, "Consent is required to continue.");
    ok = false;
  }

  return ok;
}

function readIdentity(form) {
  return {
    firstName: $("#first-name", form).value.trim(),
    lastName: $("#last-name", form).value.trim(),
    dob: $("#dob", form).value.trim(),
    ssn: $("#ssn", form).value.trim(),
    income: $("#income", form).value.trim(),
  };
}

function readContact(form) {
  return {
    email: $("#email", form).value.trim(),
    emailConfirm: $("#email-confirm", form).value.trim(),
    phone: $("#phone", form).value.trim(),
    address: $("#address", form).value.trim(),
    city: $("#city", form).value.trim(),
    state: $("#state", form).value,
    zip: String($("#zip", form).value ?? ""),
  };
}

function readProperty(form) {
  return {
    propertyValue: $("#property-value", form).value.trim(),
    loanAmount: $("#loan-amount", form).value.trim(),
    purpose: $("#purpose", form).value,
    consent: $("#consent", form).checked,
  };
}

function purposeLabel(code) {
  return (
    {
      purchase: "Home purchase",
      refinance: "Refinance",
      cashout: "Cash-out refinance",
    }[code] || code
  );
}

/**
 * LOAN-032: review omits SSN and phone intentionally.
 */
function renderReview() {
  const list = $("#review-list");
  const i = state.identity;
  const c = state.contact;
  const p = state.property;
  const rows = [
    ["Name", `${i.firstName} ${i.lastName}`],
    ["Date of birth", i.dob],
    ["Monthly income", i.income],
    ["Email", c.email],
    ["Address", `${c.address}, ${c.city}, ${c.state} ${c.zip}`],
    ["Property value", p.propertyValue],
    ["Loan amount", p.loanAmount],
    ["Purpose", purposeLabel(p.purpose)],
    ["Consent", p.consent ? "Yes" : "No"],
  ];
  list.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    list.append(dt, dd);
  }
}

async function submitApplication() {
  const err = $("#submit-error");
  err.hidden = true;
  err.textContent = "";

  // LOAN-024: intentionally does NOT disable submit during/after submit
  // (allows double submit → multiple reference numbers)

  const payload = {
    identity: { ...state.identity },
    contact: { ...state.contact },
    property: { ...state.property },
    submittedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error("Submit failed (" + res.status + ")");
    }
    const data = await res.json();
    state.reference = data.reference || "HL-UNKNOWN";
    $("#reference").textContent = state.reference;
    showStep(5);
  } catch (e) {
    err.textContent = e.message || "Could not submit application.";
    err.hidden = false;
  }
}

function wireIdentity() {
  const form = $("#form-identity");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateIdentity(form)) return;
    state.identity = readIdentity(form);
    showStep(2);
  });
}

function wireContact() {
  const form = $("#form-contact");

  // LOAN-016: fake Next only focuses the phone field
  $("#fake-next").addEventListener("click", () => {
    $("#phone", form)?.focus();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateContact(form)) return;
    state.contact = readContact(form);
    showStep(3);
  });
}

function wireProperty() {
  const form = $("#form-property");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateProperty(form)) return;
    state.property = readProperty(form);
    renderReview();
    showStep(4);
  });
}

function wireReview() {
  $("#submit-btn").addEventListener("click", () => {
    submitApplication();
  });

  $("#cancel-btn").addEventListener("click", () => {
    // LOAN-035: Cancel only returns to landing — does not reset forms or state
    showStep(0);
  });
}

function wireNavigation() {
  $("#start-btn").addEventListener("click", () => {
    showStep(1);
  });

  $("#start-over").addEventListener("click", () => {
    state.identity = {};
    state.contact = {};
    state.property = {};
    state.reference = null;
    for (const form of $all("form")) form.reset();
    // Reset SSN input type in case it was toggled
    const ssn = $("#ssn");
    if (ssn) ssn.type = "password";
    const toggle = $("#ssn-toggle");
    if (toggle) {
      toggle.textContent = "Show";
      toggle.setAttribute("aria-pressed", "false");
    }
    showStep(0);
  });

  for (const btn of $all("[data-action='back']")) {
    btn.addEventListener("click", () => {
      const current = state.step;
      if (current === 1) {
        showStep(0);
      } else if (current === 2) {
        showStep(1);
      } else if (current === 3) {
        // LOAN-011: going back from property to contact wipes contact form data
        const form = $("#form-contact");
        form.reset();
        state.contact = {};
        clearErrors(form);
        showStep(2);
      } else if (current === 4) {
        showStep(3);
      }
    });
  }
}

function wireSsnToggle() {
  const ssn = $("#ssn");
  const toggle = $("#ssn-toggle");
  toggle.addEventListener("click", () => {
    const show = ssn.type === "password";
    ssn.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", show ? "true" : "false");
  });
}

function init() {
  wireIdentity();
  wireContact();
  wireProperty();
  wireReview();
  wireNavigation();
  wireSsnToggle();
  showStep(0);
}

init();
