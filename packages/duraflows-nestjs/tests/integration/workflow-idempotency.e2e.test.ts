import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Inject, Injectable, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkflowModule, WorkflowService, WORKFLOW_IDEMPOTENCY_STORE } from "../../src/index.js";
import type { WorkflowDefinition, WorkflowIdempotencyStore } from "@duraflows/core";
import { createInMemoryPersistence } from "../../../duraflows-core/tests/helpers/in-memory-persistence.js";

const definition: WorkflowDefinition<"new" | "done"> = {
  name: "http-idempotency",
  initialState: "new",
  states: {
    new: { events: { submit: { targetState: "done", commands: [{ name: "work" }] } } },
    done: {},
  },
};

@Injectable()
class IdempotencyConsumer {
  constructor(@Inject(WORKFLOW_IDEMPOTENCY_STORE) readonly store: WorkflowIdempotencyStore | null) {}
}

describe.each(["sync", "async"])("NestJS %s module event idempotency", (mode) => {
  let app: INestApplication;
  let baseUrl: string;
  let calls = 0;
  const persistence = createInMemoryPersistence({ idempotency: true });
  class Command {
    async execute() {
      calls++;
      return { ok: true };
    }
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function create() {
    const response = await post("/workflows", { workflowName: definition.name });
    expect(response.status).toBe(201);
    return response.body.uuid as string;
  }
  beforeAll(async () => {
    const commands = [{ name: "work", useClass: Command }];
    const config =
      mode === "sync"
        ? WorkflowModule.forRoot({ workflows: [definition], persistence, commands, enableControllers: true })
        : WorkflowModule.forRootAsync({
            commands,
            enableControllers: true,
            useFactory: async () => ({ workflows: [definition], persistence }),
          });
    @Module({ imports: [config], providers: [IdempotencyConsumer] })
    class App {}
    app = await NestFactory.create(App, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("exports the idempotency store for injection into a consuming module", () => {
    expect(app.get(IdempotencyConsumer).store).toBe(persistence.idempotencyStore);
  });

  it("forwards body identity and replays over HTTP after the state changes", async () => {
    const uuid = await create();
    const path = `/workflows/${uuid}/events/submit`;
    const body = { idempotencyKey: "webhook:event-1", idempotencyFingerprint: "order-1" };
    const before = calls;
    const first = await post(path, body);
    const replay = await post(path, body);
    expect(first.status).toBe(201);
    expect(replay).toEqual(first);
    expect(calls).toBe(before + 1);
    expect((await post(path, { ...body, idempotencyFingerprint: "order-2" })).status).toBe(409);
    expect((await post(`/workflows/${uuid}/events/other`, body)).status).toBe(409);
    expect((await post(path, { idempotencyKey: body.idempotencyKey })).status).toBe(409);
  });

  it.each([
    { idempotencyKey: null },
    { idempotencyFingerprint: null },
    { idempotencyKey: 3 },
    { idempotencyKey: "" },
    { idempotencyKey: " " },
    { idempotencyKey: "é".repeat(129) },
    { idempotencyFingerprint: "without-key" },
    { idempotencyKey: "event", idempotencyFingerprint: 3 },
  ])("rejects invalid input over HTTP: %j", async (body) => {
    const uuid = await create();
    const before = calls;
    expect((await post(`/workflows/${uuid}/events/submit`, body)).status).toBe(400);
    expect(calls).toBe(before);
  });

  it("forwards identity through the typed service variant", async () => {
    const uuid = await create();
    const service = app.get(WorkflowService);
    const input = {
      workflowInstanceUuid: uuid,
      eventName: "submit",
      idempotencyKey: "typed",
      idempotencyFingerprint: "input",
    };
    const first = await service.triggerEventFor(definition, input);
    expect(await service.triggerEventFor(definition, input)).toEqual(first);
  });
});
