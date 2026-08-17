import { describe, it, expect } from "vitest";
import { generateMigrationSql } from "../../src/pg-schema-manager.js";

describe("generateMigrationSql", () => {
  it("defaults to gen_random_uuid()", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("gen_random_uuid()");
    expect(up).not.toContain("uuidv7()");
  });

  it("uses uuidv7() when strategy is uuidv7", () => {
    const { up } = generateMigrationSql({ uuidStrategy: "uuidv7" });
    expect(up).toContain("uuidv7()");
    expect(up).not.toContain("gen_random_uuid()");
  });

  it("uses gen_random_uuid() when explicitly specified", () => {
    const { up } = generateMigrationSql({ uuidStrategy: "gen_random_uuid" });
    expect(up).toContain("gen_random_uuid()");
  });

  it("creates workflow_instances table", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("CREATE TABLE workflow_instances");
    expect(up).toContain("uuid");
    expect(up).toContain("workflow_name");
    expect(up).toContain("current_state");
    expect(up).toContain("version");
    expect(up).toContain("context_json");
    expect(up).toContain("metadata_json");
  });

  it("creates workflow_history table", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("CREATE TABLE workflow_history");
    expect(up).toContain("workflow_instance_uuid");
    expect(up).toContain("from_state");
    expect(up).toContain("event_name");
    expect(up).toContain("outcome");
    expect(up).toContain("command_results_json");
  });

  it("creates workflow_definitions table", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("CREATE TABLE workflow_definitions");
    expect(up).toMatch(/workflow_name\s+text\s+NOT NULL/);
    expect(up).toContain("content_hash");
    expect(up).toContain("definition_json");
    expect(up).toContain("registered_at");
    expect(up).toContain("PRIMARY KEY (workflow_name, version)");
  });

  it("adds a nullable definition_version column to workflow_instances and workflow_history", () => {
    const { up } = generateMigrationSql();
    expect(up).toMatch(/definition_version\s+integer NULL/);
    // Both tables get the column; the pattern above must match twice.
    expect(up.match(/definition_version\s+integer NULL/g)).toHaveLength(2);
  });

  it("creates indexes", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("workflow_instances_workflow_name_idx");
    expect(up).toContain("workflow_instances_expires_at_idx");
    expect(up).toContain("workflow_history_instance_created_idx");
  });

  it("down migration drops all three tables, definitions first", () => {
    const { down } = generateMigrationSql();
    expect(down).toContain("DROP TABLE IF EXISTS workflow_definitions");
    expect(down).toContain("DROP TABLE IF EXISTS workflow_history");
    expect(down).toContain("DROP TABLE IF EXISTS workflow_instances");
    expect(down.indexOf("workflow_definitions")).toBeLessThan(down.indexOf("workflow_history"));
  });

  it("includes guard-rejected in the outcome CHECK", () => {
    const { up } = generateMigrationSql();
    expect(up).toContain("CHECK (outcome IN ('success', 'failure', 'guard-rejected'))");
  });

  it("includes a rejected_by column on workflow_history", () => {
    const { up } = generateMigrationSql();
    expect(up).toMatch(/rejected_by\s+text\s*,?/i);
  });
});
