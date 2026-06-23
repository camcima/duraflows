# Releasing

How maintainers cut a new `@duraflows/*` release to npm. All four packages
(`core`, `pg`, `kysely`, `nestjs`) are versioned and published **in lockstep** —
they always share the same version number.

The release is split in two phases because `main` is protected (see below):

1. **Phase 1 (local + PR):** prepare the version bump + CHANGELOG and merge it.
2. **Phase 2 (CI):** push a `vX.Y.Z` tag — a GitHub Actions workflow publishes
   to npm and creates the GitHub release. No maintainer publishes from a laptop.

## Tooling

- **Phase 1** uses [release-it](https://github.com/release-it/release-it) +
  [`@release-it/conventional-changelog`](https://github.com/release-it/conventional-changelog),
  configured in [`.release-it.json`](./.release-it.json) as a **prepare-only**
  tool. It bumps every package, re-pins the internal `@duraflows/core` peer,
  generates the `CHANGELOG.md` section, and commits — but does **not** tag,
  push, publish, or create a GitHub release (those are Phase 2 / CI).
- **Phase 2** is [`.github/workflows/release.yml`](./.github/workflows/release.yml),
  triggered on `v*` tag push. It builds the tagged commit, runs
  `pnpm -r publish`, and creates the GitHub release from the CHANGELOG.

## ⚠️ `main` is protected by a ruleset

`main` is protected by a **repository ruleset** ("protect main branch", under
_Settings → Rules_ — note the classic _Branch protection_ API reports it as
unprotected). The ruleset requires pull requests and blocks direct/force pushes,
so release-it's old "commit → tag → push to `main`" flow **cannot** run
end-to-end. That is why publishing is driven by a **tag push** (tags are not
blocked) handled in CI, never by release-it pushing to `main`.

> **Do not run `pnpm run release` against `main`.** With the prepare-only config
> it won't publish, but you'd be committing a version bump onto `main`, which the
> ruleset rejects. Always run it on a `chore/release-*` branch (Phase 1).

## Prerequisites

- The `NPM_TOKEN` repository secret is set (_Settings → Secrets and variables →
  Actions_) to an **npm automation token** with publish rights to the
  `@duraflows` scope. CI uses it; you do **not** need local publish rights.
- The GitHub CLI is authenticated for Phase 1 (`gh auth status`).
- `main` is green and you are up to date: `git checkout main && git pull`.

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
>
> **Merge the _content_ PRs (features/fixes) with a merge commit or rebase, not
> squash.** Squashing collapses the individual `feat:`/`fix:`/`!` commits into
> one, so conventional-changelog can no longer detect the bump or list the
> changes. (The Phase 1 release PR itself is a single commit — squash it freely.)

## Phase 1 — prepare the release PR

Run from an up-to-date `main`. Replace `3.1.0` with your target version.

```bash
VERSION=3.1.0
git checkout -b chore/release-$VERSION

# Prepare-only release-it: bumps every package, re-pins the @duraflows/core peer,
# generates the CHANGELOG section, and commits "chore: release v$VERSION".
# Nothing is tagged, pushed, or published.
pnpm exec release-it $VERSION --ci
```

<details>
<summary>Manual fallback (if you'd rather not use release-it)</summary>

```bash
VERSION=3.1.0
npm version $VERSION --no-git-tag-version --allow-same-version
pnpm -r exec npm version $VERSION --no-git-tag-version --allow-same-version
pnpm --filter @duraflows/pg     exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm --filter @duraflows/kysely exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm --filter @duraflows/nestjs exec npm pkg set "peerDependencies.@duraflows/core=^$VERSION"
pnpm install --lockfile-only
# Prepend a "## [<version>](<compare-url>) (<date>)" section to CHANGELOG.md with
# ### ⚠ BREAKING CHANGES / ### Features / ### Bug Fixes, then:
pnpm exec prettier --write CHANGELOG.md
git commit -am "chore: release v$VERSION"
```

</details>

Then verify, push, and open the PR:

```bash
pnpm run build && pnpm test          # sanity
git push -u origin chore/release-$VERSION
gh pr create --base main --title "chore: release v$VERSION" --body "Release v$VERSION"
```

**The PR contains only the version bump + CHANGELOG. Nothing is tagged or
published yet.** Wait for CI to pass, then merge (squash is fine for this PR).

## Phase 2 — tag (CI publishes)

```bash
VERSION=3.1.0
git checkout main
git fetch origin && git reset --hard origin/main   # pick up the squashed release commit
pnpm run build && pnpm test                          # final sanity

# Tag the release commit and push the tag — this triggers release.yml, which
# publishes all four packages and creates the GitHub release.
git tag -a v$VERSION -m "Release v$VERSION"
git push origin v$VERSION
```

Watch the **Release** workflow finish, then verify:

```bash
for p in core pg kysely nestjs; do printf "@duraflows/%s: " "$p"; npm view "@duraflows/$p" version; done
gh release view v$VERSION
git push origin --delete chore/release-$VERSION 2>/dev/null   # if not auto-deleted on merge
```

## Footguns

- **`release-it --dry-run` still executes the lifecycle hooks** (`before:bump`
  runs `npm version`, which **mutates** every package.json). It is **not**
  side-effect-free — don't rely on it for a clean preview; run it on a throwaway
  branch you can discard.
- **Don't run `pnpm run release -- … --ci`.** pnpm forwards the literal `--`,
  which yargs treats as "end of options", so `--ci` is parsed as a positional and
  release-it stays **interactive** (then hangs/aborts in a non-TTY shell). Use
  `pnpm exec release-it <version> --ci`.
- **Publishing is irreversible.** npm does not allow re-publishing a
  version+name, and unpublishing public packages is heavily restricted. If the
  publish job fails partway (some packages published, some not), do **not** retry
  the same version — move to the next patch and release forward.
- **`git push` runs a semgrep pre-push hook (~100s)** — branch and tag pushes can
  take a while; don't kill them early.

## Troubleshooting

**npm has a version that `main` never tagged.** This happens if a release
published to npm but the git side failed (e.g. a push to protected `main` was
rejected). Because publishing is now driven by a tag push **after** the bump is
on `main`, this should no longer occur — but if it does, do **not** re-publish
that version. Move to the next version number, document the orphaned one
(`@duraflows/*@2.0.0` is the known orphan), and release forward.
