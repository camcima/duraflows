# Releasing

How maintainers cut a new `@duraflows/*` release to npm. All four packages
(`core`, `pg`, `kysely`, `nestjs`) are versioned and published **in lockstep** —
they always share the same version number.

## Tooling

Releases are driven by [release-it](https://github.com/release-it/release-it) +
[`@release-it/conventional-changelog`](https://github.com/release-it/conventional-changelog),
configured in [`.release-it.json`](./.release-it.json). The config:

- bumps every workspace package and re-pins internal deps to `@duraflows/core@^<version>` (`before:bump`)
- refreshes the lockfile and builds (`after:bump`)
- commits `chore: release v<version>`, tags `v<version>`, and creates a GitHub release
- publishes to npm **last**, in the `after:release` hook — so npm only advances
  **after** the git commit, tag, and push have succeeded

## Prerequisites

- You are a maintainer with publish rights to the `@duraflows` npm scope
  (check with `npm whoami`).
- The GitHub CLI is authenticated: `gh auth status`.
- `main` is green and you are up to date: `git checkout main && git pull`.

## ⚠️ `main` is a protected branch

`main` requires pull requests — **direct pushes are rejected**. release-it's
default "commit → tag → push to `main`" flow therefore **cannot** run end-to-end
on its own. Cut every release in **two phases**: prepare the version bump via a
PR, then tag and publish from `main` after it merges.

## Choosing the version

Versions follow [SemVer](https://semver.org/), derived from the
[Conventional Commits](https://www.conventionalcommits.org/) since the last release:

| Commits since last release           | Bump      |
| ------------------------------------ | --------- |
| `fix:`                               | **patch** |
| `feat:`                              | **minor** |
| any `!` or `BREAKING CHANGE:` footer | **major** |

> **Note:** release-it computes the recommended bump from the last **git tag**.
> If a version was published to npm but never tagged (see
> [troubleshooting](#troubleshooting)), release-it may propose a version that is
> already taken on npm — always pass the version explicitly to be safe.

## Phase 1 — prepare the release PR

Run from an up-to-date `main`. Replace `2.2.0` with your target version.

```bash
VERSION=2.2.0
git checkout -b chore/release-$VERSION

# Bump root + all packages, re-pin internal deps (mirrors the before:bump hook)
npm version $VERSION --no-git-tag-version --allow-same-version
pnpm -r exec npm version $VERSION --no-git-tag-version --allow-same-version
pnpm --filter @duraflows/pg     exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm --filter @duraflows/kysely exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm --filter @duraflows/nestjs exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm install --lockfile-only
```

Then add the `CHANGELOG.md` entry. Prepend a new section above the latest one,
following the existing conventional-changelog format (`## [<version>](<compare-url>) (<date>)`
with `### Features` / `### Bug Fixes` / `### ⚠ BREAKING CHANGES`), then normalize it:

```bash
pnpm exec prettier --write CHANGELOG.md
```

Verify, commit, push, and open the PR:

```bash
pnpm run build && pnpm test          # sanity
git add package.json packages/*/package.json CHANGELOG.md pnpm-lock.yaml
git commit -m "chore: release v$VERSION"
git push -u origin chore/release-$VERSION
gh pr create --base main --title "chore: release v$VERSION" --body "Release v$VERSION"
```

**The PR contains only the version bump + CHANGELOG. Nothing is tagged or
published yet.** Wait for CI to pass, then merge (squash is fine).

## Phase 2 — tag & publish (from `main`, after merge)

```bash
VERSION=2.2.0
git checkout main
git fetch origin && git reset --hard origin/main   # pick up the squashed release commit
pnpm install --frozen-lockfile
pnpm run build && pnpm test                          # build fresh dist + sanity

# Tag the release commit and push the tag (tags are not blocked by branch protection)
git tag -a v$VERSION -m "Release v$VERSION"
git push origin v$VERSION

# GitHub release (notes pulled from the CHANGELOG section)
gh release create v$VERSION --title "v$VERSION" --verify-tag \
  --notes "$(node -e "const fs=require('fs');const c=fs.readFileSync('CHANGELOG.md','utf8');const m=c.match(/## \[$VERSION\][\s\S]*?(?=\n## \[)/);process.stdout.write((m?m[0]:'Release v$VERSION').replace(/^## \[[^\n]*\n/,'').trim());")"

# Publish all four packages to npm (last — git is already the source of truth)
pnpm -r publish --no-git-checks
```

Verify:

```bash
for p in core pg kysely nestjs; do printf "@duraflows/%s: " "$p"; npm view "@duraflows/$p" version; done
git push origin --delete chore/release-$VERSION 2>/dev/null   # if not auto-deleted on merge
```

## Footguns

These bit us during the 2.1.0 release — avoid them:

- **`release-it --dry-run` still executes the lifecycle hooks** (including the
  publish hook). It is **not** side-effect-free. Don't rely on it for a safe preview.
- **Don't run `pnpm run release -- … --ci`.** pnpm forwards the literal `--`,
  which yargs treats as "end of options", so `--ci` is parsed as a positional and
  release-it stays **interactive** (then hangs/aborts in a non-TTY shell). If you
  invoke release-it directly, use `pnpm exec release-it <version> --ci`.
- **Publishing is irreversible.** npm does not allow re-publishing a
  version+name, and unpublishing public packages is heavily restricted. Always
  run `pnpm test` before Phase 2.
- Running release-it directly (instead of the manual steps above) needs a token
  for the GitHub release: prefix with `GITHUB_TOKEN=$(gh auth token)`.

## Troubleshooting

**npm has a version that `main` never tagged.** This happens if a release
published to npm but the git side failed afterwards (e.g. the push to protected
`main` was rejected). Because publishing is now the **last** step (`after:release`),
this should no longer occur — but if it does, do **not** try to re-publish that
version. Move to the next version number, document the orphaned one, and release
forward.

## Future improvement

Consider a tag-triggered GitHub Actions workflow that runs `pnpm -r publish` on
`v*` tag push (with an npm automation token), so Phase 2 is fully automated and
no maintainer needs local publish rights.
