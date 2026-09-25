# claude-plugins

A private Claude Code plugin marketplace: a single central registry (catalogue
+ plugins) plus `install.mjs`, an interactive `npx` installer that wires the
marketplace and chosen plugins into a target repo's `.claude/settings.json`.

`CONVENTIONS.md` is the contract for the *plugins* — the tool self-update
convention and the plugin glue shape that `worklog`, `mdtohtml`, and any
future binary-backed tool follow. It is not about this repo's own process;
don't fold repo-process notes into it.

The installer's release process — building, tagging, and publishing a new
`install.mjs` version — lives in README.md under "Releasing". Follow it
exactly; don't improvise a different release path.

## Changelog discipline

Every notable change goes under `## [Unreleased]` in `CHANGELOG.md`. No
version heading is cut, and no version bump lands, without an explicit
release instruction from the user — finishing a feature or being told to
commit is not that instruction.

## Before calling anything done

`npm test` must pass.

The installer (`install.mjs`) must never gain a runtime dependency that
`npm run build` does not bundle into `dist/`. The release tarball is the
product; it must stay registry-free, so anything `install.mjs` `import`s at
runtime has to end up inside the bundle, not resolved from `node_modules` at
install time.
