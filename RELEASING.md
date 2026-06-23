# Releasing

How maintainers cut a new `@duraflows/*` release to npm. All four packages
(`core`, `pg`, `kysely`, `nestjs`) are versioned and published **in lockstep** —
they always share the same version number.

The release is split in two phases because `main` is protected (see below):

1. **Phase 1 (local + PR):** prepare the version bump + CHANGELOG and merge it.
2. **Phase 2 (local):** from `main`, run release-it to tag + publish all four
   packages, then push the tag. Publishing uses **your local npm credentials**
   (`~/.npmrc`) — there is intentionally **no CI publish workflow**.

## Tooling

Both phases use [release-it](https://github.com/release-it/release-it) +
[`@release-it/conventional-changelog`](https://github.com/release-it/conventional-changelog):

- **Phase 1** uses [`.release-it.json`](./.release-it.json) as a **prepare-only**
  config: it bumps every package, re-pins the internal `@duraflows/core` peer,
  generates the `CHANGELOG.md` section, and commits — but does **not** tag, push,
  or publish. Run it on a `chore/release-*` branch and merge via PR.
- **Phase 2** uses [`.release-it.publish.json`](./.release-it.publish.json) with
  `--no-increment` (no bump): from the merged `main` it tags `v<version>` and runs
  `pnpm -r publish` using your local npm credentials. You then push the tag. No
  GitHub release is created — the tag is the source of truth; the CHANGELOG holds
  the notes.

## ⚠️ `main` is protected by a ruleset

`main` is protected by a **repository ruleset** ("protect main branch", under
_Settings → Rules_ — note the classic _Branch protection_ API reports it as
unprotected). The ruleset requires pull requests and blocks direct/force pushes,
so release-it cannot commit the version bump straight to `main` — that is why
Phase 1 goes through a PR. **Tags are not blocked**, so Phase 2 tags and publishes
locally from `main` once the bump has merged.

> **Do not run `pnpm run release` against `main`.** It would try to commit the
> version bump onto `main`, which the ruleset rejects. Run Phase 1 on a
> `chore/release-*` branch.

## Prerequisites

- You have publish rights to the `@duraflows` npm scope and are logged in:
  `npm whoami` prints your username (auth lives in `~/.npmrc`).
- The GitHub CLI is authenticated (`gh auth status`).
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

Run from an up-to-date `main`. Replace `3.2.0` with your target version.

```bash
VERSION=3.2.0
git checkout -b chore/release-$VERSION

# Prepare-only release-it: bumps every package, re-pins the @duraflows/core peer,
# generates the CHANGELOG section, and commits "chore: release v$VERSION".
# Nothing is tagged, pushed, or published.
pnpm exec release-it $VERSION --ci
```

<details>
<summary>Manual fallback (if you'd rather not use release-it)</summary>

```bash
VERSION=3.2.0
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

## Phase 2 — tag & publish (from `main`, after merge)

```bash
VERSION=3.2.0
git checkout main
git fetch origin && git reset --hard origin/main   # pick up the squashed release commit
pnpm install --frozen-lockfile
pnpm run build && pnpm test                          # final sanity

# Tag v$VERSION locally and publish all four packages with your local npm
# credentials. --no-increment means "don't bump" — the version is already on
# main from Phase 1.
pnpm exec release-it --no-increment --ci --config .release-it.publish.json

# Push the tag to record the release. No workflow runs on the tag.
git push origin v$VERSION
```

Verify:

```bash
for p in core pg kysely nestjs; do printf "@duraflows/%s: " "$p"; npm view "@duraflows/$p" version; done
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
  version+name, and unpublishing public packages is heavily restricted. If a
  Phase 2 publish fails partway, re-running is safe: `pnpm -r publish` **skips
  versions already on the registry** and publishes only the missing ones.
- **`git push` runs a semgrep pre-push hook (~100s)** — branch pushes can take a
  while; don't kill them early. (Tag-only pushes are fast.)

## Troubleshooting

**npm has a version that `main` never tagged.** This happens if a release
published to npm but the tag was never pushed. Because Phase 2 publishes from
`main` after the bump has merged and pushes the tag right after, this should not
occur — but if it does, do **not** re-publish that version. Move to the next
version number, document the orphaned one (`@duraflows/*@2.0.0` is the known
orphan), and release forward.
