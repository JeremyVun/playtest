// In-memory desk state. One process holds one desk; `reset()` puts it back to
// the exact seeded state.

import { seedState } from "./data.js";

let state = seedState();

export function getState() {
  return state;
}

export function reset() {
  state = seedState();
  return state;
}

export function findLoan(id) {
  return state.loans.find((loan) => loan.id === id) || null;
}

export function findEquipment(id) {
  return state.equipment.find((item) => item.id === id) || null;
}

export function findDraft(id) {
  return state.drafts.find((draft) => draft.id === id) || null;
}

export function nextLoanId() {
  const id = `L-${state.nextLoanNumber}`;
  state.nextLoanNumber += 1;
  return id;
}

export function nextDraftId() {
  const id = `D-${state.nextDraftNumber}`;
  state.nextDraftNumber += 1;
  return id;
}

export function addLoan(loan) {
  state.loans.push(loan);
  return loan;
}

export function addDraft(draft) {
  state.drafts.push(draft);
  return draft;
}

export function removeDraft(id) {
  state.drafts = state.drafts.filter((draft) => draft.id !== id);
}
