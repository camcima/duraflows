# duraflows Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-09-27

## Active Technologies

- TypeScript 5.9.x, strict mode, ES2022 target, dual ESM + CJS build (Node16 module resolution)
- `@camcima/finita` ^4.3.0 (FSM engine)
- `pg` ^8.13 (PostgreSQL client, `@duraflows/pg`), `kysely` ^0.29 (query builder, `@duraflows/kysely`, type-only import)
- `@nestjs/common` + `@nestjs/core` ^11 || ^12 (NestJS adapter)
- PostgreSQL 13+ (SKIP LOCKED, JSONB, savepoints); 18+ optional for native `uuidv7()` support
- vitest 5 (single root config)

## Project Structure

```text
packages/duraflows-core/src/
packages/duraflows-pg/src/        # also sql/dbmate/ migrations 001–006
packages/duraflows-kysely/src/
packages/duraflows-nestjs/src/
skills/                            # agent skills shipped with the repo
references/api-reference.md
```

## Commands

pnpm test && pnpm run lint

Integration suites need a database: `DATABASE_URL=postgres://… REQUIRE_INTEGRATION_DB=1 pnpm test`. CI's coverage gate (`pnpm run test:coverage`, no database) requires 100% functions.

## Code Style

TypeScript 5.x, strict mode, ES2022 target, ESM output: Follow standard conventions

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
