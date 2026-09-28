import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkflowModule, WorkflowCommand } from "@duraflows/nestjs";
import type {
  CommandResult,
  WorkflowCommand as WorkflowCommandInterface,
  WorkflowDefinition,
  WorkflowHistoryRecord,
  WorkflowInstance,
  WorkflowPersistenceProvider,
} from "@duraflows/core";

// Drives the optional REST controllers through a real HTTP server
// (platform-express) rather than calling controller methods directly. This is
// the layer NestJS 12 reworked — ValidationPipe now loads class-validator /
// class-transformer through a dynamic import(), and the HTTP adapter error
// mapping changed — so it has to be exercised end to end on every supported
// NestJS major.

const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

function inMemoryPersistence(): WorkflowPersistenceProvider {
  const instances = new Map<string, WorkflowInstance>();
  const history: WorkflowHistoryRecord[] = [];
  return {
    instanceStore: {
      async create(instance) {
        instances.set(instance.uuid, structuredClone(instance));
      },
      async findByUuid(uuid) {
        return instances.get(uuid) ?? null;
      },
      async lockByUuid(uuid) {
        return instances.get(uuid) ?? null;
      },
      async update(instance) {
        instances.set(instance.uuid, structuredClone(instance));
      },
      async findExpired() {
        return [];
      },
      async findParkedTimeouts() {
        return [];
      },
      async countInstances() {
        return 0;
      },
    },
    historyStore: {
      async append(entry) {
        history.push(entry);
        return `history-${history.length}`;
      },
      async findByInstanceUuid(uuid, options) {
        const offset = options?.offset ?? 0;
        return history
          .filter((h) => h.workflowInstanceUuid === uuid)
          .slice(offset, options?.limit === undefined ? undefined : offset + options.limit);
      },
    },
    transactionRunner: {
      async runInTransaction(callback) {
        return callback();
      },
    },
  };
}

// Registered only through the decorator, so a successful transition proves
// DiscoveryService-based command discovery works on this NestJS major.
@WorkflowCommand("http-approve")
class HttpApproveCommand implements WorkflowCommandInterface {
  async execute(): Promise<CommandResult> {
    return { ok: true, code: "APPROVED" };
  }
}

const orderWorkflow: WorkflowDefinition = {
  name: "http-order",
  initialState: "pending",
  states: {
    pending: {
      events: {
        approve: { targetState: "approved", commands: [{ name: "http-approve" }] },
      },
    },
    approved: {},
  },
};

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
}

describe("WorkflowModule REST controllers over HTTP (platform-express)", () => {
  let app: INestApplication;
  let baseUrl: string;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function createInstance(): Promise<string> {
    const created = await call("POST", "/workflows", { workflowName: "http-order", context: { orderId: 1 } });
    expect(created.status).toBe(201);
    return created.body!.uuid as string;
  }

  beforeAll(async () => {
    @Module({
      imports: [
        WorkflowModule.forRootAsync({
          enableControllers: true,
          useFactory: async () => ({ workflows: [orderWorkflow], persistence: inMemoryPersistence() }),
        }),
      ],
      providers: [HttpApproveCommand],
    })
    class HttpAppModule {}

    app = await NestFactory.create(HttpAppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe("POST /workflows", () => {
    it("creates an instance", async () => {
      const created = await call("POST", "/workflows", { workflowName: "http-order", context: { orderId: 1 } });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        workflowName: "http-order",
        currentState: "pending",
        context: { orderId: 1 },
      });
    });

    it("rejects unknown properties and wrong types via ValidationPipe (400)", async () => {
      const result = await call("POST", "/workflows", { workflowName: 1, extra: true });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ statusCode: 400, error: "Bad Request" });
      expect(result.body!.message).toEqual(
        expect.arrayContaining(["property extra should not exist", "workflowName must be a string"]),
      );
    });

    it("maps an unmapped WorkflowError to a sanitized 500", async () => {
      const result = await call("POST", "/workflows", { workflowName: "does-not-exist" });

      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        statusCode: 500,
        error: "Internal Server Error",
        message: "Internal server error",
      });
    });
  });

  describe("GET /workflows/:uuid", () => {
    it("returns an existing instance", async () => {
      const uuid = await createInstance();

      const result = await call("GET", `/workflows/${uuid}`);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ uuid, currentState: "pending" });
    });

    it("rejects a malformed uuid via ParseUUIDPipe (400)", async () => {
      const result = await call("GET", "/workflows/not-a-uuid");

      expect(result.status).toBe(400);
    });

    it("returns 404 via NotFoundException for a missing instance", async () => {
      const result = await call("GET", `/workflows/${MISSING_UUID}`);

      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ statusCode: 404 });
    });
  });

  describe("POST /workflows/:uuid/events/:eventName", () => {
    it("runs the decorator-discovered command and transitions the instance", async () => {
      const uuid = await createInstance();

      const result = await call("POST", `/workflows/${uuid}/events/approve`, {});

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        outcome: "success",
        fromState: "pending",
        toState: "approved",
        commandResults: [{ ok: true, code: "APPROVED" }],
      });
      expect((await call("GET", `/workflows/${uuid}`)).body).toMatchObject({ currentState: "approved" });
    });

    it("maps InvalidEventError to 409", async () => {
      const uuid = await createInstance();
      await call("POST", `/workflows/${uuid}/events/approve`, {});

      const result = await call("POST", `/workflows/${uuid}/events/approve`, {});

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ statusCode: 409, error: "Conflict" });
    });

    it("maps WorkflowInstanceNotFoundError to 404", async () => {
      const result = await call("POST", `/workflows/${MISSING_UUID}/events/approve`, {});

      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ statusCode: 404, error: "Not Found" });
    });

    it("rejects a malformed uuid param via ValidationPipe (400)", async () => {
      const result = await call("POST", "/workflows/not-a-uuid/events/approve", {});

      expect(result.status).toBe(400);
    });
  });

  describe("GET /workflows/:uuid/events", () => {
    it("lists the events available in the current state", async () => {
      const uuid = await createInstance();

      const result = await call("GET", `/workflows/${uuid}/events`);

      expect(result.status).toBe(200);
      expect(result.body).toEqual([expect.objectContaining({ eventName: "approve" })]);
    });
  });

  describe("GET /workflows/:uuid/history", () => {
    it("coerces query strings to numbers via class-transformer @Type (200)", async () => {
      const uuid = await createInstance();
      await call("POST", `/workflows/${uuid}/events/approve`, {});

      const result = await call("GET", `/workflows/${uuid}/history?limit=1&offset=0`);

      expect(result.status).toBe(200);
      expect(result.body).toHaveLength(1);
    });

    it("enforces @Max on the coerced limit (400)", async () => {
      const uuid = await createInstance();

      const result = await call("GET", `/workflows/${uuid}/history?limit=9999`);

      expect(result.status).toBe(400);
    });

    it("rejects a non-numeric limit (400)", async () => {
      const uuid = await createInstance();

      const result = await call("GET", `/workflows/${uuid}/history?limit=abc`);

      expect(result.status).toBe(400);
    });
  });

  describe("POST /workflows/timeouts/process", () => {
    it("processes expired workflows", async () => {
      const result = await call("POST", "/workflows/timeouts/process?limit=10");

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ processed: 0, rejected: 0, businessFailed: [], failed: [] });
    });

    it("enforces @Max on the coerced limit (400)", async () => {
      const result = await call("POST", "/workflows/timeouts/process?limit=5000");

      expect(result.status).toBe(400);
    });
  });
});
