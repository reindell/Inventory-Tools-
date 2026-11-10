import { z } from 'zod';

export const requestStatuses = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'issued',
  'returned',
] as const;
export type RequestStatus = (typeof requestStatuses)[number];
export interface ToolRequest {
  id: string;
  item_id: string;
  requester_id: string;
  requester: string;
  name: string;
  sku: string;
  serialized: boolean;
  image_url: string | null;
  quantity: number;
  issued_quantity: number;
  returned_quantity: number;
  available_quantity: number;
  status: RequestStatus;
  purpose: string;
  decision_note: string;
  version: number;
  created_at: string;
  updated_at: string;
  issued_at: string | null;
}
export interface RequestSummary {
  pending: number;
  approved: number;
  outstanding: number;
  outstanding_quantity: number;
}
export interface RequestNotification {
  id: string;
  request_id: string;
  title: string;
  message: string;
  read_at: string | null;
  created_at: string;
}
export const toolRequestSchema = z
  .object({
    itemId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1, 'Request at least one unit.').max(1000000000),
    purpose: z.string().trim().min(3, 'Explain what the tools or jigs are needed for.').max(1000),
  })
  .strict();
export const requestActionSchema = z
  .object({
    version: z.number().int().positive(),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
export const requestStockSchema = requestActionSchema
  .extend({
    quantity: z.coerce.number().int().min(1).max(1000000000),
    serials: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
  })
  .strict();
