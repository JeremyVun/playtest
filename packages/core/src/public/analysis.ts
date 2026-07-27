export { movement } from "../shared/movement.ts";
// Deterministic anomaly signals over recorded envelopes (DESIGN D2). Hosted
// findings intake derives a candidate's trusted signal type and locus from these
// — never from model prose — so it must reach them through this entry point.
export { extractAnomalies } from "../anomalies.ts";
