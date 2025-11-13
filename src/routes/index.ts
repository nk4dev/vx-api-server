import { Hono } from "hono";
import { AnyObj, ProjectResp, generateNanoId, generateUUID, ensureTables, DEFAULT_DB } from "../db";
// Postgres (postgres-js) + Drizzle

// `getPgPool` is dynamically imported inside handlers to avoid loading `pg` at module
// initialization time (which breaks Cloudflare Workers / Miniflare runtime).
// Use Web Crypto's randomUUID when available, otherwise fallback to a small UUID v4 generator.


function projectRowToResponse(row: AnyObj): ProjectResp {
  const currencies = Array.isArray(row.currencies)
    ? row.currencies
    : (typeof row.currencies === 'string' ? JSON.parse(row.currencies) : []);
  const features = Array.isArray(row.features)
    ? row.features
    : (typeof row.features === 'string' ? JSON.parse(row.features) : null);

  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    description: row.description ?? null,
    website: row.website ?? null,
    nodeEndpoint: row.node_endpoint ?? null,
    creator: row.creator,
    currencies,
    features,
    // Legacy fields for backward compatibility
    title: row.title,
    ownerId: row.owner_id ?? null,
    dueDate: row.due_date
      ? (row.due_date.toISOString?.().split("T")[0] ?? String(row.due_date))
      : null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

function todoRowToResponse(row: AnyObj): AnyObj {
  return {
    id: row.id,
    title: row.title,
    order: row.order,
    done: !!row.done,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

/**
 * Register routes on the provided Hono app instance.
 */
export async function registerRoutes(app: Hono) {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DB;
  // Dynamically import getPgPool to avoid bundling 'pg' for Cloudflare Workers.
  const { getPgPool } = await import("../db");
  const pool = await getPgPool(databaseUrl);

  // Create project (with optional todos)
  app.post("/projects", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // 新しいAPI: projectName, projectId, creator, currencies
    const newApiMode = body.projectName && body.creator && Array.isArray(body.currencies);
    // レガシーAPI: title
    const legacyApiMode = body.title && !newApiMode;

    if (newApiMode) {
      // 新しいAPI
      const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";
      const creator = String(body.creator).trim();
      const currencies = Array.isArray(body.currencies) ? body.currencies : [];

      if (!projectName || !creator || currencies.length === 0) {
        console.log("invalid input:", { projectName, creator, currencies });
        return c.json({
          message: "projectName, creator, and currencies (non-empty array) are required",
          sample: {
            projectName: "My Project",
            creator: "creator@example.com",
            currencies: ["USD", "EUR"]
          }
        }, 400);
      }
      const description = body.description ?? null;
      const website = body.website ?? null;
      const nodeEndpoint = body.nodeEndpoint ?? null;
      const features = Array.isArray(body.features) ? body.features : null;

      const client = await pool.connect();
      try {
        await ensureTables(client);
        await client.query("BEGIN");

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
            projectName,
            nanoid,
            description,
            website,
            nodeEndpoint,
            creator,
            JSON.stringify(currencies),
            features ? JSON.stringify(features) : null,
          ],
        );

        const projectRow = insertRes.rows[0];

        // Handle todos if provided
        const todosIn = Array.isArray(body.todos) ? body.todos : [];
        const createdTodos: AnyObj[] = [];
        for (let i = 0; i < todosIn.length; i++) {
          const t = todosIn[i];
          if (!t || typeof t.title !== "string") continue;
          const todoId = generateNanoId();
          const order = typeof t.order === "number" ? t.order : i + 1;
          await client.query(
            `INSERT INTO todos(id, project_id, title, "order", done, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [todoId, uuid, t.title, order, !!t.done],
          );
          createdTodos.push({
            id: todoId,
            title: t.title,
            order,
            done: !!t.done,
          });
        }

        await client.query("COMMIT");

        const resp = {
          ...projectRowToResponse(projectRow),
          todos: createdTodos.map(todoRowToResponse),
        };
        return c.json(resp, 201);
      } catch (err: any) {
        try {
          await client.query("ROLLBACK");
        } catch (_) { }
        const errMsg = String(err?.message ?? err);
        if (errMsg.includes("duplicate") && errMsg.includes("project_id")) {
          return c.json(
            { message: "Project ID already exists" },
            409,
          );
        }
        return c.json(
          { message: "DB error", details: errMsg },
          500,
        );
      } finally {
        client.release();
      }
    } else if (legacyApiMode) {
      // レガシーAPI対応
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        return c.json({ message: "title is required" }, 400);
      }

      const description = body?.description ?? null;
      const dueDate = body?.dueDate ?? null;
      const ownerId = body?.ownerId ?? null;

      const client = await pool.connect();
      try {
        await ensureTables(client);
        await client.query("BEGIN");

        const projectId = generateNanoId();
        const insertProjectRes = await client.query(
          `INSERT INTO projects(id, title, description, owner_id, due_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           RETURNING id, title, description, owner_id, due_date, created_at, updated_at`,
          [projectId, title, description, ownerId, dueDate],
        );

        const projectRow = insertProjectRes.rows[0];

        const todosIn = Array.isArray(body?.todos) ? body.todos : [];
        const createdTodos: AnyObj[] = [];
        for (let i = 0; i < todosIn.length; i++) {
          const t = todosIn[i];
          if (!t || typeof t.title !== "string") continue;
          const todoId = generateNanoId();
          const order = typeof t.order === "number" ? t.order : i + 1;
          await client.query(
            `INSERT INTO todos(id, project_id, title, "order", done, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [todoId, projectId, t.title, order, !!t.done],
          );
          createdTodos.push({
            id: todoId,
            title: t.title,
            order,
            done: !!t.done,
          });
        }

        await client.query("COMMIT");

        const resp = {
          ...projectRowToResponse(projectRow),
          todos: createdTodos.map(todoRowToResponse),
        };
        return c.json(resp, 201);
      } catch (err: any) {
        try {
          await client.query("ROLLBACK");
        } catch (_) { }
        return c.json(
          { message: "DB error", details: String(err?.message ?? err) },
          500,
        );
      } finally {
        client.release();
      }
    } else {
      return c.json({
        message: "Either (name, projectId, creator, currencies) for new API or title for legacy API is required",
      }, 400);
    }
  });

  // List projects (simple pagination) or fetch by projectId query
  app.get("/projects", async (c) => {
    // If projectId query is provided, return the single project
    const projectIdQuery = c.req.query("projectId") ?? null;
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const perPage = Math.min(
      100,
      Math.max(1, Number(c.req.query("perPage") ?? 20)),
    );
    const ownerId = c.req.query("ownerId") ?? null;
    const offset = (page - 1) * perPage;

    const client = await pool.connect();
    try {
      await ensureTables(client);

      if (projectIdQuery) {
        const res = await client.query(
          `SELECT id, project_name, project_id, description, website, node_endpoint, creator, currencies, features,
                  title, owner_id, due_date, created_at, updated_at 
           FROM projects WHERE id = $1 OR project_id = $1 LIMIT 1`,
          [projectIdQuery],
        );
        if (!res.rows || res.rows.length === 0) {
          return c.json({ message: "Project not found" }, 404);
        }
        const project: ProjectResp = projectRowToResponse(res.rows[0]);
        const todosRes = await client.query(
          `SELECT id, title, "order", done, created_at, updated_at FROM todos WHERE project_id = $1 ORDER BY "order" ASC NULLS LAST`,
          [project.id],
        );
        project.todos = todosRes.rows.map(todoRowToResponse);
        return c.json(project);
      }

      const params: any[] = [];
      let whereClause = "";
      if (ownerId) {
        params.push(ownerId);
        whereClause = `WHERE owner_id = $${params.length}`;
      }
      params.push(perPage, offset);
      const projectsRes = await client.query(
        `SELECT id, project_name, project_id, description, website, node_endpoint, creator, currencies, features,
                title, owner_id, due_date, created_at, updated_at
         FROM projects
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const projects: ProjectResp[] = projectsRes.rows.map((r: AnyObj) =>
        projectRowToResponse(r),
      );

      // fetch todos for each project (N+1 but simpler)
      for (const p of projects) {
        const todosRes = await client.query(
          `SELECT id, title, "order", done, created_at, updated_at FROM todos WHERE project_id = $1 ORDER BY "order" ASC NULLS LAST`,
          [p.id],
        );
        p.todos = todosRes.rows.map(todoRowToResponse);
      }

      // total count
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM projects ${whereClause}`,
        ownerId ? [ownerId] : [],
      );
      const total = countRes.rows?.[0]?.cnt ?? 0;

      return c.json({
        items: projects,
        total,
        page,
        perPage,
      });
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });

  // Get single project
  app.get("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) return c.json({ message: "projectId required" }, 400);

    const client = await pool.connect();
    try {
      await ensureTables(client);
      const res = await client.query(
        `SELECT id, project_name, project_id, description, website, node_endpoint, creator, currencies, features,
                title, owner_id, due_date, created_at, updated_at 
         FROM projects WHERE id = $1 LIMIT 1`,
        [projectId],
      );
      if (!res.rows || res.rows.length === 0) {
        return c.json({ message: "Project not found" }, 404);
      }
      const project: ProjectResp = projectRowToResponse(res.rows[0]);
      const todosRes = await client.query(
        `SELECT id, title, "order", done, created_at, updated_at FROM todos WHERE project_id = $1 ORDER BY "order" ASC NULLS LAST`,
        [projectId],
      );
      project.todos = todosRes.rows.map(todoRowToResponse);
      return c.json(project);
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });

  // Update project (partial)
  app.patch("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) return c.json({ message: "projectId required" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const allowed: (keyof AnyObj)[] = [
      "name",
      "description",
      "website",
      "nodeEndpoint",
      "creator",
      "currencies",
      "features",
      "title",
      "dueDate",
      "ownerId",
    ];
    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (!Object.keys(body || {}).length) {
      return c.json({ message: "no fields to update" }, 400);
    }

    for (const key of allowed) {
      if (body[key] !== undefined) {
        let colName = key;
        let value = body[key];

        if (key === "nodeEndpoint") {
          colName = "node_endpoint";
        } else if (key === "dueDate") {
          colName = "due_date";
        } else if (key === "ownerId") {
          colName = "owner_id";
        }

        if (key === "currencies" || key === "features") {
          value = Array.isArray(value) ? JSON.stringify(value) : value;
        }

        updates.push(`${colName} = $${idx}`);
        params.push(value);
        idx++;
      }
    }
    if (!updates.length) {
      return c.json({ message: "no updatable fields provided" }, 400);
    }
    // updated_at
    updates.push(`updated_at = NOW()`);

    params.push(projectId);
    const client = await pool.connect();
    try {
      await ensureTables(client);
      const sql = `UPDATE projects SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING id, name, project_id, description, website, node_endpoint, creator, currencies, features, title, owner_id, due_date, created_at, updated_at`;
      const res = await client.query(sql, params);
      if (!res.rows || res.rows.length === 0) {
        return c.json({ message: "Project not found" }, 404);
      }
      const project: ProjectResp = projectRowToResponse(res.rows[0]);
      const todosRes = await client.query(
        `SELECT id, title, "order", done, created_at, updated_at FROM todos WHERE project_id = $1 ORDER BY "order" ASC NULLS LAST`,
        [project.id],
      );
      project.todos = todosRes.rows.map(todoRowToResponse);
      return c.json(project);
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });

  // Delete project (and cascade todos)
  app.delete("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) return c.json({ message: "projectId required" }, 400);

    const client = await pool.connect();
    try {
      await ensureTables(client);
      const res = await client.query(
        `DELETE FROM projects WHERE id = $1 RETURNING id`,
        [projectId],
      );
      if (!res.rows || res.rows.length === 0) {
        return c.json({ message: "Project not found" }, 404);
      }
      c.status(204);
      return c.body("");
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });

  // Update a todo (partial)
  app.patch("/projects/:projectId/todos/:todoId", async (c) => {
    const projectId = c.req.param("projectId");
    const todoId = c.req.param("todoId");
    if (!projectId || !todoId)
      return c.json({ message: "projectId and todoId are required" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const allowed: (keyof AnyObj)[] = ["title", "done", "order"];
    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const key of allowed) {
      if (body[key] !== undefined) {
        const col = key === "order" ? '"order"' : key;
        updates.push(`${col} = $${idx}`);
        params.push(body[key]);
        idx++;
      }
    }

    if (!updates.length) {
      return c.json({ message: "no updatable fields provided" }, 400);
    }

    updates.push(`updated_at = NOW()`);
    params.push(todoId, projectId); // WHERE $idx, $idx+1
    const client = await pool.connect();
    try {
      await ensureTables(client);
      const sql = `UPDATE todos SET ${updates.join(", ")} WHERE id = $${params.length - 1} AND project_id = $${params.length} RETURNING id, title, "order", done, created_at, updated_at`;
      const res = await client.query(sql, params);
      if (!res.rows || res.rows.length === 0) {
        return c.json({ message: "Todo not found" }, 404);
      }
      const todo = todoRowToResponse(res.rows[0]);
      return c.json(todo);
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });

  // Delete a todo
  app.delete("/projects/:projectId/todos/:todoId", async (c) => {
    const projectId = c.req.param("projectId");
    const todoId = c.req.param("todoId");
    if (!projectId || !todoId)
      return c.json({ message: "projectId and todoId are required" }, 400);

    const client = await pool.connect();
    try {
      await ensureTables(client);
      const res = await client.query(
        `DELETE FROM todos WHERE id = $1 AND project_id = $2 RETURNING id`,
        [todoId, projectId],
      );
      if (!res.rows || res.rows.length === 0) {
        return c.json({ message: "Todo not found" }, 404);
      }
      c.status(204);
      return c.body("");
    } catch (err: any) {
      return c.json(
        { message: "DB error", details: String(err?.message ?? err) },
        500,
      );
    } finally {
      client.release();
    }
  });
}

export default registerRoutes;
