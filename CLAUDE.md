# duraflows Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-03-27

## Active Technologies

- TypeScript 5.7.x, strict mode, ES2022 target, ESM output (Node16 module resolution) + `@camcima/finita` v2.0.0 (FSM engine), `pg` v8.13+ (PostgreSQL client), `@nestjs/common` + `@nestjs/core` v11+ (NestJS adapter) (002-workflow-runtime)
- PostgreSQL 13+ (SKIP LOCKED, JSONB); 18+ optional for native `uuidv7()` support (002-workflow-runtime)

- TypeScript 5.x, strict mode, ES2022 target, ESM output + `@camcima/finita` v2.0.0 (FSM engine), `pg` (PostgreSQL client), `@nestjs/common` + `@nestjs/core` (NestJS adapter) (001-workflow-runtime)

## Project Structure

```text
packages/duraflows-core/src/
packages/duraflows-pg/src/
packages/duraflows-nestjs/src/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x, strict mode, ES2022 target, ESM output: Follow standard conventions

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
