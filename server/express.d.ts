import type { User } from '../shared/contracts.js';
declare global {
  namespace Express {
    interface Request {
      user?: User;
      requestId: string;
      sessionId?: string;
    }
  }
}
export {};
