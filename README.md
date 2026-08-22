# DevRadar

DevRadar is a local-first Obsidian plugin for following selected GitHub users and recording supported public developer activity in connected Markdown person notes.

## Status

Version `0.1.0` is a foundation/pre-MVP release. It establishes the plugin, repository, quality, and release foundations; the MVP workflow for following selected GitHub users and recording supported public developer activity is still under development. DevRadar does not promise exhaustive history or real-time collection.

**Platform support:** For the `v0.2.0` target, Obsidian Desktop is the required runtime-validation environment. DevRadar is designed to remain compatible with Obsidian Mobile through supported cross-platform APIs, but iOS and Android runtime behavior is not currently claimed as validated. Runtime-sensitive capabilities remain disabled where their applicable safety gates have not passed.

## Development

DevRadar supports Node.js 24 LTS for ordinary development, with Node.js
22.13.0 as the minimum supported version. Dependency and lockfile authoring
uses the reviewed Node.js 22.13.0 + npm 10.9.2 baseline; see the contributor
guide.

## Common commands

- `npm run dev`
- `npm run build`
- `npm run check` for full validation

## Project documentation

- [Contributor guide](CONTRIBUTING.md)
- [Product direction](docs/product-direction.md)
- [MVP architecture](docs/architecture.md)
- [Future directions (non-normative)](docs/future-directions.md)
