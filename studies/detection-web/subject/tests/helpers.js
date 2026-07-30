// Shared harness: boots the desk server on an ephemeral port for one test file.

import { server } from "../server.js";

let baseUrl = null;

export async function start() {
  if (baseUrl) return baseUrl;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

export async function stop() {
  if (!baseUrl) return;
  await new Promise((resolve) => server.close(resolve));
  baseUrl = null;
}

export async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

export const GET = (path) => api("GET", path);
export const POST = (path, body) => api("POST", path, body);
export const PATCH = (path, body) => api("PATCH", path, body);

export async function reset() {
  const result = await POST("/__reset");
  if (result.status !== 200) throw new Error("reset failed");
}

/** Walk the whole new-loan flow and return the created loan. */
export async function bookLoan({ borrower, lines, loanDays, pickupDate }) {
  const created = await POST("/api/loan-drafts", borrower);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const draftId = created.body.draft.id;
  const scheduled = await PATCH(`/api/loan-drafts/${draftId}`, {
    step: "schedule",
    lines,
    loanDays,
    pickupDate,
  });
  if (scheduled.status !== 200) throw new Error(JSON.stringify(scheduled.body));
  const submitted = await POST(`/api/loan-drafts/${draftId}/submit`);
  if (submitted.status !== 201) throw new Error(JSON.stringify(submitted.body));
  return submitted.body;
}

export const SAMPLE_BORROWER = {
  name: "Ivy Cole",
  email: "ivy.cole@fairmont.edu",
  department: "Design",
  purpose: "Degree show promotional films.",
};
