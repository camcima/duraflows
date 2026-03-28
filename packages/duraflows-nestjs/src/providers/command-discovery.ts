import type { DiscoveryService } from "@nestjs/core";
import type { Type } from "@nestjs/common";
import type { WorkflowCommand } from "@camcima/duraflows-core";
import { WorkflowError } from "@camcima/duraflows-core";
import type { WorkflowCommandRegistration } from "./nest-command-registry.js";
import {
  InternalWorkflowCommandDecorator,
  WORKFLOW_COMMAND_METADATA_KEY,
} from "../decorators/workflow-command.decorator.js";

export function discoverDecoratedCommands(
  discoveryService: DiscoveryService,
): WorkflowCommandRegistration[] {
  const providers = discoveryService.getProviders({
    metadataKey: WORKFLOW_COMMAND_METADATA_KEY,
  });

  const registrations: WorkflowCommandRegistration[] = [];

  for (const wrapper of providers) {
    const metadata = discoveryService.getMetadataByDecorator(
      InternalWorkflowCommandDecorator,
      wrapper,
    );

    // metadata is the string value passed to @WorkflowCommand("name"),
    // or undefined if not set
    const name = Array.isArray(metadata) ? metadata[0] : metadata;
    if (typeof name !== "string") continue;

    const cls = wrapper.metatype as Type<WorkflowCommand>;
    if (!cls) continue;

    registrations.push({ name, useClass: cls });
  }

  return registrations;
}

export function mergeCommandRegistrations(
  explicit: WorkflowCommandRegistration[],
  discovered: WorkflowCommandRegistration[],
): WorkflowCommandRegistration[] {
  const explicitNames = new Set(explicit.map((r) => r.name));

  for (const reg of discovered) {
    if (explicitNames.has(reg.name)) {
      throw new WorkflowError(
        `Command "${reg.name}" is registered both explicitly in module options and via @WorkflowCommand decorator. Remove one registration to resolve the conflict.`,
      );
    }
  }

  return [...explicit, ...discovered];
}
