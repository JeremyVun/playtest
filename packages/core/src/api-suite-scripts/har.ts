import type { DynamicValue } from "./types.ts";

// HAR 1.2 recording for script executions
// (docs/contracts/scripts.md#har-lifecycle).
//
// A script's traffic is recorded as a standard HAR 1.2 document rather than the
// reduced shape the web/api drivers write, because a script HAR is consumed by
// tooling outside Playtest (offline oracles, browser HAR viewers) and because it
// is one of the two verdict columns. The recorder lives in the PARENT process:
// the script process never writes it, so a script can neither forge an exchange
// nor suppress one (docs/contracts/scripts.md#trust-model).
//
// Three lifecycle rules are implemented here and stated in the contract:
//
//   1. known-secret scrub at WRITE time (../secrets.ts) — every value core
//      resolved from a `{ $secret: … }` reference is replaced by its placeholder
//      before any byte reaches disk;
//   2. body-size caps — bodies over MAX_BODY_READ are never buffered and bodies
//      over MAX_BODY_CHARS are stored truncated, with the declared size kept;
//   3. flush on every exchange — a killed script still leaves a scorable trace.
import fs from "node:fs";
import path from "node:path";

import { capBody, isTextualMime, MAX_BODY_CHARS, MAX_BODY_READ } from "../drivers/har.ts";
import { hasKnownSecrets, redactSecrets } from "../secrets.ts";

export { capBody, isTextualMime, MAX_BODY_CHARS, MAX_BODY_READ };

/** HAR spec version the recorder writes. */
export const HAR_VERSION = "1.2";
/** `log.creator.name` on every script HAR. */
export const HAR_CREATOR = "playtest-script-runner";

const headerPairs = (headers: DynamicValue) =>
  Object.entries(headers ?? {}).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one) => ({ name: String(name), value: String(one ?? "") })),
  );

/**
 * A recorder over one script execution's exchanges. `add()` returns the HAR
 * entry INDEX, which is the only evidence handle a script ever receives: a
 * report cites `evidence.requests: [<index>]` and the runner verifies that every
 * cited index resolves (docs/contracts/scripts.md#report-schema).
 */
export function createHarRecorder({ target = "", file = null, contractVersion = "" }: DynamicValue = {}) {
  const entries: DynamicValue = [];
  let dirty = false;

  const document = () => ({
    log: {
      version: HAR_VERSION,
      creator: {
        name: HAR_CREATOR,
        version: String(contractVersion || "1"),
        comment: target ? `target=${target}` : "",
      },
      entries,
    },
  });

  const flush = ({ force = false }: DynamicValue = {}) => {
    if (!file || (!dirty && !force)) return false;
    const json = JSON.stringify(document(), null, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (hasKnownSecrets() ? redactSecrets(json) : json) + "\n");
    dirty = false;
    return true;
  };

  return {
    entries,
    document,
    flush,
    /**
     * Record one exchange. `requestHeaders` may still contain a resolved
     * credential — the write-time scrub is what keeps it off disk, exactly as it
     * does for the api driver's har.json.
     * @returns {number} the entry index
     */
    add({ method, url, requestHeaders, requestBody, mimeType, startedAt, timeMs, status, statusText, responseHeaders, responseBody, responseSize, failed = false }: DynamicValue) {
      const reqText = requestBody == null ? null : String(requestBody);
      const resText = responseBody == null ? null : String(responseBody);
      const entry: DynamicValue = {
        startedDateTime: new Date(startedAt).toISOString(),
        time: Number.isFinite(timeMs) ? timeMs : -1,
        request: {
          method: String(method).toUpperCase(),
          url: String(url),
          httpVersion: "HTTP/1.1",
          headers: headerPairs(requestHeaders),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: reqText == null ? 0 : Buffer.byteLength(reqText),
          ...(reqText == null
            ? {}
            : { postData: { mimeType: mimeType || "application/json", text: capBody(reqText) } }),
        },
        response: {
          status: failed ? 0 : Number(status ?? 0),
          statusText: failed ? "transport error" : String(statusText ?? ""),
          httpVersion: "HTTP/1.1",
          headers: headerPairs(responseHeaders),
          cookies: [],
          content: {
            size: Number.isFinite(responseSize) ? responseSize : resText == null ? 0 : Buffer.byteLength(resText),
            mimeType: (responseHeaders ?? {})["content-type"] ?? "",
            ...(resText == null ? {} : { text: capBody(resText) }),
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: resText == null ? -1 : Buffer.byteLength(resText),
        },
        cache: {},
        timings: { send: 0, wait: Number.isFinite(timeMs) ? timeMs : -1, receive: 0 },
        ...(failed ? { _failed: true } : {}),
      };
      entries.push(entry);
      dirty = true;
      // Flush per exchange: a script killed at its timeout still leaves the
      // traffic it produced, which is the column the gate scores.
      flush();
      return entries.length - 1;
    },
  };
}

/**
 * Is a response body capturable, and how much of it may be read? Mirrors the
 * driver rule: text/JSON only, and never buffer a body whose declared length
 * exceeds the read cap.
 */
export function captureDecision({ mime, contentLength }: DynamicValue) {
  const capturable = mime === "" || isTextualMime(mime);
  const len = Number.parseInt(contentLength, 10);
  const tooBig = Number.isFinite(len) && len > MAX_BODY_READ;
  return { capturable: capturable && !tooBig, declaredSize: Number.isFinite(len) ? len : null };
}
