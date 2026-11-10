import { z } from 'zod';

export const COMPANY_NAME = 'SHINDENGEN ELECTRIC MFG.CO.,LTD';

export const roles = ['Admin', 'Manager', 'Staff', 'Viewer'] as const;
export type Role = (typeof roles)[number];
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  enabled: boolean;
}
export interface Brand {
  companyName: string;
  appName: string;
  locationName: string;
  timezone: string;
  version: number;
  logoUrl: string | null;
  fullLogoUrl: string | null;
  darkLogoUrl: string | null;
  markUrl: string | null;
  darkMarkUrl: string | null;
}
export interface Item {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  description: string;
  supplier: string;
  serialized: boolean;
  status: 'active' | 'archived';
  version: number;
  quantity: number;
  reorder_level: number;
  stock_version: number;
  image_url: string | null;
  created_at: string;
}
export interface ItemImage {
  id: string;
  sort_order: number;
  is_primary: boolean;
  url: string;
  thumbnailUrl: string;
}
export interface Movement {
  id: string;
  item_id: string;
  name: string;
  sku: string;
  type: 'in' | 'out' | 'adjustment';
  delta: number;
  balance_after: number;
  reason: string;
  note: string;
  actor: string;
  created_at: string;
}
export interface SerialUnit {
  id: string;
  serial: string;
  status: 'in_stock' | 'sold' | 'damaged';
}
export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ItemDetail {
  item: Item;
  images: ItemImage[];
  serials: SerialUnit[];
  movements: Movement[];
}
export const identity = (value: string) => value.trim().normalize('NFKC').toUpperCase();
export const itemSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter at least 2 characters.').max(150),
    sku: z
      .string()
      .trim()
      .min(1, 'Enter a SKU.')
      .max(64)
      .regex(/^[\w./-]+$/, 'Use letters, numbers, dots, slashes or hyphens.'),
    barcode: z
      .string()
      .trim()
      .max(100)
      .regex(/^[\x20-\x7E]*$/, 'Use printable ASCII characters for Code 128 labels.')
      .default(''),
    category: z.string().trim().min(1, 'Choose a category.').max(80),
    description: z.string().trim().max(4000).default(''),
    supplier: z.string().trim().max(150).default(''),
    reorderLevel: z.coerce.number().int().min(0).max(1000000000),
    serialized: z.boolean().default(false),
    version: z.number().int().positive().optional(),
  })
  .strict();
export type ItemInput = z.infer<typeof itemSchema>;
export const stockSchema = z
  .object({
    itemId: z.string().uuid(),
    type: z.enum(['in', 'out', 'adjustment']),
    quantity: z.coerce.number().int().min(1).max(1000000000),
    direction: z.enum(['add', 'remove']).default('add'),
    reason: z.string().trim().min(3, 'Give a reason of at least 3 characters.').max(200),
    note: z.string().trim().max(2000).default(''),
    expectedVersion: z.number().int().positive(),
    serials: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
    outStatus: z.enum(['sold', 'damaged']).default('sold'),
  })
  .strict();
export type StockInput = z.infer<typeof stockSchema>;
export const passwordSchema = z.string().min(12, 'Use at least 12 characters.').max(128);
export const loginSchema = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) })
  .strict();
export const stockState = (item: Pick<Item, 'quantity' | 'reorder_level'>) =>
  item.quantity === 0 ? 'out' : item.quantity <= item.reorder_level ? 'low' : 'in';
