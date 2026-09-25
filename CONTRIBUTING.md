# Contributing to Agent TV

## Set up

```sh
npm install
bb plugin install .   # install this checkout into your running bb
bb plugin dev         # rebuild and reload on every save
```

Before you open a change, run:

```sh
npm test
npm run typecheck
bb plugin build
```

## Ground rules

- **Keep the fold pure.** Anything that decides what a tile shows belongs in
  `lib/fleet.ts`, with a unit test. `server.ts` only reads, schedules and
  publishes.
- **Keep reads bounded.** Every read the pump makes has a limit, a type
  allowlist and a reason to happen. A change that reads while nobody is
  watching needs a test proving it does not.
- **Public SDK only.** `test/public-sdk.test.ts` fails if anything imports BB
  internals. Use `@get-bb/plugin-sdk`, zod, Node built-ins and this package's
  own files.
- **Never leak a secret.** Action lines are redacted in exactly one place. New
  sources of tile text must go through it.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:` …). Write the subject in the imperative, and use the
  body to explain why.

## Manifest

`package.json` is the plugin manifest: `bb.server`, `bb.app`, `bb.name`,
`bb.description`, `bb.branding.icon` and the `engines` ranges.
`engines.bbPluginSdk` (`>=0.5.9`) is a floor, not a ceiling. Run
`bb plugin types` to resync the pinned SDK to the bb you run.

## Store listing

`bb.description` is the one-line hook, and `PLUGIN_OVERVIEW.md` is the longer
text shown under it. Keep them under their limits (about 140 and 4,000
characters) and update them together. When a change affects what agents read,
update `skills/agent-tv/SKILL.md` as well.

## UI components

`components/ui/` is vendored source you own (the shadcn model). The plugin uses
only `Icon`, whose name set matches the host's, so a timeline glyph from a
thread event renders as the same icon BB's own timeline uses. Add more with
`npx shadcn add @bb/<name>`. React and BB-shimmed packages are never bundled.

## Releasing

1. Bump `version` in `package.json`.
2. Move the `Unreleased` notes in `CHANGELOG.md` under the new version.
3. Run `npm test`, `npm run typecheck` and `bb plugin build`.
4. Commit, then tag `vX.Y.Z`. Git installs can track a semver range over those
   tags, for example `bb plugin install git:<repo>@^0.2`.

`dist/` is not committed. Git installs build their own bundles, and a committed
`dist/` would be replaced anyway.

Confused by the API, or need something the types don't explain? Read the BB
source: <https://github.com/get-bb/bb>.
