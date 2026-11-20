import { z } from 'zod';
import { machineTokenSchema, timestampSchema, uuidSchema } from './core.js';

export const DEFAULT_STEWARD_ORIGIN = 'https://steward.yefengr.cn';
export const STEW_INSTALL_COMMAND = 'npm install -g @yefengr/steward';
export const pairingCodeSchema = z.string().regex(/^[0-9A-F]{10}$/);
const machineName = z.string().trim().min(1).max(128).refine((name) => !/[\p{Cc}]/u.test(name));
export const createPairingRequestSchema = z.strictObject({ name: machineName, tokenHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const createPairingResponseSchema = z.strictObject({ code: pairingCodeSchema, expiresAt: timestampSchema });
export const pairingStatusRequestSchema = z.strictObject({ machineToken: machineTokenSchema });
export const pairingStatusResponseSchema = z.strictObject({ status: z.enum(['pending', 'approved', 'expired']) });
export const webPairingRequestSchema = z.strictObject({ code: pairingCodeSchema });
export const webPairingResponseSchema = z.strictObject({ name: machineName, expiresAt: timestampSchema });
export const webApprovePairingResponseSchema = z.strictObject({ machineId: uuidSchema, name: machineName });
