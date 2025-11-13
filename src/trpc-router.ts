import { z } from 'zod';
import { router, publicProcedure } from './trpc';
import type { AppContext } from './types';
import { getSignedCookie } from 'hono/cookie';
import { COOKIE_NAME, ensureCookieSecret } from './utils/cookies';
import { findStoredUser } from './services/userLookup';

/**
 * Auth Router - User authentication and registration
 */
const authRouter = router({
  register: publicProcedure
    .input(
      z.object({
        username: z.string().min(3, 'Username must be at least 3 characters'),
        password: z.string().min(6, 'Password must be at least 6 characters'),
        email: z.string().email('Invalid email').optional(),
        name: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, registerUserPgRaw, getUserByUsernamePgRaw } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        try {
          // Check if user already exists
          const existingUser = await getUserByUsernamePgRaw(pool, input.username);
          if (existingUser) {
            throw new Error('Username already exists');
          }

          // Hash password
          const encoder = new TextEncoder();
          const data = encoder.encode(input.password);
          const hashBuffer = await crypto.subtle.digest('SHA-256', data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

          // Register user
          const userId = await registerUserPgRaw(
            pool,
            input.username,
            passwordHash,
            input.email,
            input.name
          );

          return {
            id: userId,
            username: input.username,
            email: input.email || null,
            name: input.name || null,
          };
        } finally {
          try {
            pool.end?.();
          } catch (_) { }
        }
      } catch (error: any) {
        if (error.message.includes('duplicate') || error.message.includes('already exists')) {
          throw new Error('Username already exists');
        }
        throw error;
      }
    }),

  login: publicProcedure
    .input(
      z.object({
        user: z.string(),
        password: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const user = await findStoredUser(ctx, input.user);
      if (!user) {
        throw new Error('Invalid credentials');
      }

      return {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
      };
    }),

  status: publicProcedure
    .input(
      z.object({
        user: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const cookieSecret = ensureCookieSecret(ctx);
      const sessionCookie = await getSignedCookie(ctx as any, cookieSecret, COOKIE_NAME);

      if (!sessionCookie) {
        throw new Error('Not authenticated');
      }

      let parsedSession: any;
      try {
        parsedSession = JSON.parse(sessionCookie);
      } catch (err) {
        throw new Error('Invalid session data');
      }

      if (input.user) {
        const matches =
          parsedSession.login === input.user ||
          String(parsedSession.id) === input.user;
        if (!matches) {
          throw new Error('User mismatch');
        }
      }

      return {
        id: parsedSession.id,
        login: parsedSession.login,
        name: parsedSession.name,
      };
    }),
});

/**
 * Projects Router - Project management
 */
const projectsRouter = router({
  create: publicProcedure
    .input(
      z.object({
        projectName: z.string().min(1, 'Project name is required'),
        creator: z.string().min(1, 'Creator is required'),
        currencies: z.array(z.string()).min(1, 'At least one currency is required'),
        description: z.string().optional(),
        website: z.string().optional(),
        nodeEndpoint: z.string().optional(),
        features: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, generateUUID, generateNanoId, ensureTables } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        const client = await pool.connect();
        try {
          await ensureTables(client);
          await client.query('BEGIN');

          const uuid = generateUUID();
          const nanoid = generateNanoId();

          const insertRes = await client.query(
            `INSERT INTO projects(
              id, project_id, project_name, description, website, node_endpoint, 
              creator, currencies, features, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
             RETURNING id, project_name, project_id, description, website, node_endpoint, creator, currencies, features, created_at, updated_at`,
            [
              uuid,
              nanoid,
              input.projectName,
              input.description || null,
              input.website || null,
              input.nodeEndpoint || null,
              input.creator,
              JSON.stringify(input.currencies),
              input.features ? JSON.stringify(input.features) : null,
            ]
          );

          await client.query('COMMIT');

          const projectRow = insertRes.rows[0];
          return {
            id: projectRow.id,
            name: projectRow.project_name,
            projectId: projectRow.project_id,
            description: projectRow.description || null,
            website: projectRow.website || null,
            nodeEndpoint: projectRow.node_endpoint || null,
            creator: projectRow.creator,
            currencies: projectRow.currencies,
            features: projectRow.features || null,
            createdAt: projectRow.created_at,
          };
        } finally {
          try {
            await client.query('ROLLBACK');
          } catch (_) { }
          client.release();
        }
      } catch (error) {
        throw error;
      }
    }),

  list: publicProcedure
    .input(
      z.object({
        page: z.number().default(1),
        perPage: z.number().default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, ensureTables } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        const client = await pool.connect();
        try {
          await ensureTables(client);

          const offset = (input.page - 1) * input.perPage;

          const projectsRes = await client.query(
            `SELECT id, project_name, project_id, description, website, node_endpoint, creator, currencies, features, created_at, updated_at
             FROM projects
             ORDER BY created_at DESC
             LIMIT $1 OFFSET $2`,
            [input.perPage, offset]
          );

          const countRes = await client.query(
            `SELECT COUNT(*)::int AS cnt FROM projects`
          );

          const total = countRes.rows?.[0]?.cnt ?? 0;

          const projects = projectsRes.rows.map((row: any) => ({
            id: row.id,
            name: row.project_name,
            projectId: row.project_id,
            description: row.description || null,
            website: row.website || null,
            nodeEndpoint: row.node_endpoint || null,
            creator: row.creator,
            currencies: typeof row.currencies === 'string' ? JSON.parse(row.currencies) : row.currencies,
            features: typeof row.features === 'string' ? JSON.parse(row.features) : row.features,
            createdAt: row.created_at,
          }));

          return {
            items: projects,
            total,
            page: input.page,
            perPage: input.perPage,
          };
        } finally {
          client.release();
        }
      } catch (error) {
        throw error;
      }
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, ensureTables } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        const client = await pool.connect();
        try {
          await ensureTables(client);

          const res = await client.query(
            `SELECT id, project_name, project_id, description, website, node_endpoint, creator, currencies, features, created_at, updated_at
             FROM projects
             WHERE id = $1 OR project_id = $1
             LIMIT 1`,
            [input.id]
          );

          if (!res.rows || res.rows.length === 0) {
            throw new Error('Project not found');
          }

          const row = res.rows[0];
          return {
            id: row.id,
            name: row.project_name,
            projectId: row.project_id,
            description: row.description || null,
            website: row.website || null,
            nodeEndpoint: row.node_endpoint || null,
            creator: row.creator,
            currencies: typeof row.currencies === 'string' ? JSON.parse(row.currencies) : row.currencies,
            features: typeof row.features === 'string' ? JSON.parse(row.features) : row.features,
            createdAt: row.created_at,
          };
        } finally {
          client.release();
        }
      } catch (error) {
        throw error;
      }
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, ensureTables } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        const client = await pool.connect();
        try {
          await ensureTables(client);

          const res = await client.query(
            `DELETE FROM projects
             WHERE id = $1
             RETURNING id`,
            [input.id]
          );

          if (!res.rows || res.rows.length === 0) {
            throw new Error('Project not found');
          }

          return { success: true };
        } finally {
          client.release();
        }
      } catch (error) {
        throw error;
      }
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1, 'Project name is required').optional(),
        description: z.string().optional(),
        currencies: z.array(z.string()).optional(),
        website: z.string().optional(),
        nodeEndpoint: z.string().optional(),
        features: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!(ctx as any).DATABASE_URL) {
        throw new Error('Database not configured');
      }

      try {
        const { getPgPool, ensureTables } = await import('./db');
        const pool = await getPgPool((ctx as any).DATABASE_URL as string);

        const client = await pool.connect();
        try {
          await ensureTables(client);

          const updates: string[] = [];
          const values: any[] = [];
          let paramCount = 1;

          if (input.name !== undefined) {
            updates.push(`project_name = $${paramCount}`);
            values.push(input.name);
            paramCount++;
          }

          if (input.description !== undefined) {
            updates.push(`description = $${paramCount}`);
            values.push(input.description || null);
            paramCount++;
          }

          if (input.currencies !== undefined) {
            updates.push(`currencies = $${paramCount}`);
            values.push(JSON.stringify(input.currencies));
            paramCount++;
          }

          if (input.website !== undefined) {
            updates.push(`website = $${paramCount}`);
            values.push(input.website || null);
            paramCount++;
          }

          if (input.nodeEndpoint !== undefined) {
            updates.push(`node_endpoint = $${paramCount}`);
            values.push(input.nodeEndpoint || null);
            paramCount++;
          }

          if (input.features !== undefined) {
            updates.push(`features = $${paramCount}`);
            values.push(input.features ? JSON.stringify(input.features) : null);
            paramCount++;
          }

          if (updates.length === 0) {
            throw new Error('No fields to update');
          }

          updates.push(`updated_at = NOW()`);
          values.push(input.id);

          const updateQuery = `UPDATE projects
             SET ${updates.join(', ')}
             WHERE id = $${paramCount}
             RETURNING id, project_name, project_id, description, website, node_endpoint, creator, currencies, features, created_at, updated_at`;

          const res = await client.query(updateQuery, values);

          if (!res.rows || res.rows.length === 0) {
            throw new Error('Project not found');
          }

          const projectRow = res.rows[0];
          return {
            id: projectRow.id,
            name: projectRow.project_name,
            projectId: projectRow.project_id,
            description: projectRow.description || null,
            website: projectRow.website || null,
            nodeEndpoint: projectRow.node_endpoint || null,
            creator: projectRow.creator,
            currencies: projectRow.currencies,
            features: projectRow.features || null,
            createdAt: projectRow.created_at,
          };
        } finally {
          client.release();
        }
      } catch (error) {
        throw error;
      }
    }),
});

/**
 * Root router
 */
export const appRouter = router({
  auth: authRouter,
  projects: projectsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
