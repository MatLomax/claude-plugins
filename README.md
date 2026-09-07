# claude-plugins

A private Claude Code plugin marketplace — a single central registry so skills
don't have to be duplicated and fragmented across projects. Registering the
marketplace enables **nothing**; every plugin is `defaultEnabled: false` and is
opted into **per project**.

## Install

From the **root of the repo you want to enable plugins in**, run:

```bash
npx github:MatLomax/claude-plugins
```

The interactive installer lets you tick which plugins to enable (all off by
default), then **deep-merges** `.claude/settings.json` in that repo — registering
the marketplace and enabling exactly what you picked, never clobbering existing
settings, safe to re-run. When you enable `worklog` it also verifies its runtime
(Go 1.27+ and the `worklog` binary), offers to `go install` the binary if it is
missing, and offers to run `worklog init` so the repo's task log is live rather
than inert. It needs a terminal (it is interactive) and, at the end, reports what
it verified. Then reload Claude Code and accept the "trust this folder" dialog.

## Manual setup

Prefer to wire it by hand?

```bash
# once per machine — registers the catalogue, enables nothing
/plugin marketplace add MatLomax/claude-plugins

# in a project that wants a skill — writes .claude/settings.json (committed)
/plugin install image-to-html@matlomax --scope project
#   …or --scope local to keep it out of git
```

Update later with `/plugin marketplace update matlomax`.

## Plugins

| Plugin | What it does |
|---|---|
| `image-to-html` | Reconstruct HTML from a mockup image and objectively gate the render against it — per-region SSIM, edge-XOR border detection, colour/tint sweeps, glyph measurement. Explicit-invoke only. |
| `worklog` | Per-project, SQLite-backed task & decision log for coding agents, remembered across sessions — task tree with blocking, GitHub-issue links, first-class decisions, and a per-session journal, over MCP. Run `/worklog:init` per project; `/worklog:update` upgrades the binary to the latest release (and a session-start check quietly flags when one is available). **Requires the [`worklog`](https://github.com/MatLomax/worklog) binary on PATH.** |

## Layout

```
install.mjs · package.json           # the `npx` interactive installer (repo root)
.claude-plugin/marketplace.json      # the catalogue
plugins/<name>/
├── .claude-plugin/plugin.json       # plugin manifest
└── one or more of:
    ├── skills/<name>/SKILL.md        # a skill + its scripts/ and assets/
    ├── .mcp.json                     # an MCP server
    ├── hooks/hooks.json              # SessionStart/Stop/… hooks
    └── commands/<name>.md            # a /plugin:command
```

Add a new plugin by dropping another `plugins/<name>/` and listing it in
`marketplace.json`. `worklog` is the MCP+hooks+command shape; `image-to-html`
is the skill shape.
