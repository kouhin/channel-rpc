# Contributing

## Development setup

Use the Bun version in `.bun-version` (also recorded in `packageManager`) and the
Node.js LTS version in `.node-version`. npm is pinned as a development dependency
for package checks and CI publishing. Consumers do not need Bun.

```sh
bun install --frozen-lockfile
bun run playwright install chromium
bun run verify
```

On Linux, use `bun run playwright install --with-deps chromium` to install the
browser's system dependencies as well.

| Command | Purpose |
| --- | --- |
| `bun run check` | Check formatting, imports, and lint rules with Biome |
| `bun run check:fix` | Apply Biome's safe fixes |
| `bun run format` | Format supported files |
| `bun run typecheck` | Type-check the browser source, tests, and tooling |
| `bun test ./test/unit` | Run unit tests without launching a browser |
| `bun run build` | Clean and generate ESM, CommonJS, and declarations |
| `bun run test:browser` | Test the build with real cross-origin iframes in Chromium |
| `bun run check:package` | Pack the build and verify its installed contents |
| `bun run verify` | Run all checks, tests, and the build in CI order |

`test:browser` and `check:package` require a successful build. Browser fixtures
use loopback ports 4173 and 4174 by default; set `RPC_TEST_PORT` to use another
pair. Bun only discovers tests under `test/unit`, and Playwright only discovers
tests under `test/browser`.

## Build and package checks

TypeScript first emits ES2020 JavaScript and declarations into `.build`. Bun
bundles that JavaScript with the browser target, then a final TypeScript pass
lowers the bundles to ES2020 in `dist/index.js` and `dist/index.cjs`. This final
pass also lowers Bun's generated helpers, which can contain newer syntax such as
`??=` even when the input is ES2020. Both module formats have their own declaration entrypoint. The
current single source entrypoint produces a self-contained declaration, which is
copied to `.d.ts` and `.d.cts`. Keep both declarations self-contained if the source
is split into multiple modules in the future.

Builds clean previous outputs, remove the temporary directory, and do not minify.
The syntax target does not add polyfills or change the browser APIs used by the
library. Browser types are isolated from the Bun types used by development tools.

Package checks create a tarball under `.artifacts`, install it in a temporary
consumer project without lifecycle scripts or network access, and check:

- Required files and the publication allowlist.
- Packaging and ESM/CommonJS declaration resolution with publint and ATTW.
- Real Node.js `import` and `require` without Bun.
- TypeScript NodeNext and Bundler consumers, including invalid-call assertions.
- ES2020 syntax for both JavaScript outputs using Acorn.

ATTW uses its `node16` profile: modern ESM/CommonJS and bundler resolution are
required; legacy `node10` resolution is not part of the compatibility target.
Failed package checks remove the tarball. Successful checks leave its filename,
version, and integrity in `.artifacts/package.json`.

`prepack` builds when someone runs `npm pack` or publishes the working directory.
Package checks use `npm pack --ignore-scripts` after building to avoid rebuilding
or recursively invoking lifecycle scripts. CI publishes the already-checked
tarball, rather than packing the working directory again.

## Dependency updates

Use the latest stable releases, including major upgrades. Direct development
dependencies are pinned to exact versions, and `bun.lock` pins their dependency
graph. Do not install prerelease or canary tooling. When upgrading:

1. Update the direct dependencies to the registry's latest stable versions.
2. Keep `.bun-version` and `packageManager` in sync; update `.node-version` to the
   latest Node.js LTS release.
3. Match the Biome schema version to the installed Biome version.
4. Update GitHub Actions to the full commit SHA of their latest stable releases,
   preserving a version comment beside each SHA.
5. Regenerate `bun.lock`, install the matching Chromium, and run `bun run verify`.

## npm trusted publisher setup

Before the first automated release, an npm package owner must configure a
[trusted publisher](https://docs.npmjs.com/trusted-publishers/) in the settings for
the existing `channel-rpc` package:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `kouhin` |
| Repository | `channel-rpc` |
| Workflow filename | `release.yml` |
| Environment | Leave empty |
| Allowed action | Enable direct publishing with `npm publish` |

The workflow uses GitHub-hosted runners and `id-token: write` for OIDC. No npm
token or `NODE_AUTH_TOKEN` secret is needed. npm automatically includes provenance
when publishing this public package from its public repository through OIDC.

## Releasing

The package version is chosen manually. Stable tags use `vMAJOR.MINOR.PATCH` and
publish to npm's `latest` dist-tag. Prerelease tags such as `v0.3.0-rc.1` publish to
`next` and create a GitHub prerelease. Leading zeroes in numeric identifiers and
SemVer build metadata are not supported for release tags.

Prepare the version change on a branch, for example:

```sh
npm version patch --no-git-tag-version
bun install --lockfile-only
bun run verify
```

Commit the version change and updated lockfile, then merge the PR into `main`.
Once the updated `main` has passed CI, create an annotated tag matching the version
in `package.json`. For example, if the prepared version is `0.2.7`:

```sh
git switch main
git pull --ff-only
git tag -a v0.2.7 -m v0.2.7
git push origin v0.2.7
```

The release workflow checks that the tag is valid, matches `package.json`, points
at the checked-out commit, and belongs to `origin/main` history. It then runs the
full verification suite and publishes the exact verified tarball. A failed gate
prevents publishing. npm rejects already-published versions.

GitHub Release creation runs in a separate job after npm succeeds, with generated
release notes. If only that job fails, use **Re-run failed jobs** to retry it;
do not rerun the successful npm publish job. Creating an existing GitHub Release
is a no-op. Runs for the same tag are serialized without cancelling an active
publication.

Inspect the Actions run, npm version and provenance, and GitHub Release after
publishing. Fix code or package-content problems in a new version rather than
moving an already-published tag.
