# Contributing to duraflows

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- Node.js 20 or 22
- pnpm 10+
- PostgreSQL 13+ (for running persistence adapter tests)

## Getting Started

1. Fork the repository and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/duraflows.git
   cd duraflows
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

   This also installs [Lefthook](https://github.com/evilmartians/lefthook) git hooks automatically.

3. Build all packages:

   ```bash
   pnpm run build
   ```

4. Run the tests:

   ```bash
   pnpm test
   ```

## Project Structure

This is a monorepo with three packages:

| Package             | Path                        | Description                          |
| ------------------- | --------------------------- | ------------------------------------ |
| `@duraflows/core`   | `packages/duraflows-core`   | Framework-agnostic runtime and types |
| `@duraflows/pg`     | `packages/duraflows-pg`     | PostgreSQL persistence adapter       |
| `@duraflows/nestjs` | `packages/duraflows-nestjs` | NestJS module integration            |

## Development Workflow

### Scripts

| Command                 | Description                      |
| ----------------------- | -------------------------------- |
| `pnpm run build`        | Build all packages               |
| `pnpm test`             | Run tests                        |
| `pnpm run test:watch`   | Run tests in watch mode          |
| `pnpm run lint`         | Lint all packages                |
| `pnpm run format`       | Format code with Prettier        |
| `pnpm run format:check` | Check formatting without writing |

### Before Submitting

Make sure your changes pass all checks:

```bash
pnpm run build
pnpm run format:check
pnpm run lint
pnpm test
```

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) enforced by [commitlint](https://commitlint.js.org/) and [Lefthook](https://github.com/evilmartians/lefthook). Every commit message must follow this format:

```
<type>(<optional scope>): <description>
```

**Examples:**

```
feat: add timeout cancellation support
fix(pg): handle connection pool exhaustion
docs: update persistence guide
test: add workflow compiler edge cases
chore: bump @camcima/finita to 2.1.0
refactor(core): simplify event executor logic
```

**Common types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `style`, `perf`, `ci`, `build`.

If a commit message doesn't follow this format, the `commit-msg` hook will reject it.

## Submitting a Pull Request

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes, with tests for any new behavior.

3. Push your branch and open a pull request against `main`.

4. Ensure CI passes -- the PR will be reviewed once all checks are green.

## Reporting Issues

Use [GitHub Issues](https://github.com/camcima/duraflows/issues) to report bugs or request features. Please include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Node.js and PostgreSQL versions

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
