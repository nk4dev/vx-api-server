import { initTRPC } from '@trpc/server';
import type { AppContext } from './types';

/**
 * Initialization of tRPC backend
 * Should be done only once per backend!
 */
const t = initTRPC.context<AppContext>().create();

/**
 * Export reusable router and procedure helpers
 * that can be used throughout the router.ts file!
 */
export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
