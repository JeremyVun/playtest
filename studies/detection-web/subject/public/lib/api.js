// Thin fetch wrapper. Non-2xx responses throw an ApiError carrying the
// server's message and any per-field messages.

export class ApiError extends Error {
  constructor(message, fields, status) {
    super(message);
    this.name = "ApiError";
    this.fields = fields || {};
    this.status = status;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("The desk system is not responding. Try again.", {}, 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = (payload && payload.error) || {};
    throw new ApiError(
      error.message || "Something went wrong. Try again.",
      error.fields,
      response.status,
    );
  }
  return payload;
}

export const get = (path) => request("GET", path);
export const post = (path, body) => request("POST", path, body || {});
export const patch = (path, body) => request("PATCH", path, body || {});
