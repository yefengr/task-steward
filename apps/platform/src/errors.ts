import type { ErrorCode } from '@pi-steward/contract';

const errorStatus = {
  unauthorized: 401, forbidden: 403, not_found: 404, invalid_request: 400,
  conflict: 409, machine_required: 409, attempt_ended: 409, rate_limited: 429, internal_error: 500,
} as const satisfies Record<ErrorCode, number>;

export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
  get status() { return errorStatus[this.code]; }
}
export function reject(code: ErrorCode, message: string): never {
  throw new ApiError(code, message);
}
