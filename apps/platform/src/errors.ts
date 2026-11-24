import type { ErrorCode } from '@pi-steward/contract';

const errorStatus = {
  unauthorized: 401, forbidden: 403, not_found: 404, invalid_request: 400,
  conflict: 409, machine_required: 409, attempt_ended: 409, rate_limited: 429, internal_error: 500,
  session_machine_offline: 409, session_unsupported: 409, session_record_missing: 409, session_slots_full: 409,
} as const satisfies Record<ErrorCode, number>;

export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
  get status() { return errorStatus[this.code]; }
}
export function reject(code: ErrorCode, message: string): never {
  throw new ApiError(code, message);
}
