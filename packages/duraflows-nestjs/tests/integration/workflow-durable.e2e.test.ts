import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Inject, Injectable, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkflowModule, WORKFLOW_EXECUTION_STORE } from "../../src/index.js";
import type { WorkflowExecutionStore } from "@duraflows/core";
import { createInMemoryPersistence } from "../../../duraflows-core/tests/helpers/in-memory-persistence.js";
@Injectable()
class Consumer {
  constructor(@Inject(WORKFLOW_EXECUTION_STORE) readonly store: WorkflowExecutionStore) {}
}
describe.each(["sync", "async"])("NestJS %s durable execution", (mode) => {
  let app: INestApplication,
    baseUrl: string,
    fail = false;
  const persistence = createInMemoryPersistence({ durableExecution: true });
  class Command {
    execute() {
      if (fail) throw new Error("offline");
      return { ok: true };
    }
  }
  async function request(path: string, body?: unknown) {
    const response = await fetch(
      `${baseUrl}${path}`,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function enqueue() {
    const created = await request("/workflows", { workflowName: "durable-http" });
    const accepted = await request(`/workflows/${created.body.uuid}/executions/go`, { idempotencyKey: "key" });
    expect(accepted.status).toBe(201);
    return { instance: created.body.uuid as string, uuid: accepted.body.uuid as string };
  }
  beforeAll(async () => {
    const config = {
      persistence,
      durableExecution: { maxAttempts: 1 },
      workflows: [
        {
          name: "durable-http",
          initialState: "new",
          states: { new: { events: { go: { targetState: "done", commands: [{ name: "work" }] } } }, done: {} },
        },
      ],
    };
    const commands = [{ name: "work", useClass: Command }];
    const module =
      mode === "sync"
        ? WorkflowModule.forRoot({ ...config, commands, enableControllers: true })
        : WorkflowModule.forRootAsync({ commands, enableControllers: true, useFactory: async () => config });
    @Module({ imports: [module], providers: [Consumer] })
    class App {}
    app = await NestFactory.create(App, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("exports the optional store and processes accepted work over HTTP", async () => {
    expect(app.get(Consumer).store).toBe(persistence.executionStore);
    const e = await enqueue();
    expect((await request(`/workflows/${e.instance}/events/go`, {})).status).toBe(409);
    expect((await request("/workflows/executions/process", {})).body.completed).toEqual([e.uuid]);
    expect((await request(`/workflows/executions/${e.uuid}`)).body.status).toBe("completed");
  });
  it("supports operator retry and cancellation and validates input", async () => {
    fail = true;
    const e = await enqueue();
    expect((await request("/workflows/executions/process", {})).body.parked).toEqual([e.uuid]);
    fail = false;
    expect((await request(`/workflows/executions/${e.uuid}/retry`, {})).body.status).toBe("pending");
    expect((await request(`/workflows/executions/${e.uuid}/cancel`, {})).body.status).toBe("cancelled");
    expect((await request(`/workflows/${e.instance}/executions/go`, {})).status).toBe(400);
    expect((await request("/workflows/executions/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
