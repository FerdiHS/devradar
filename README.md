# DevRadar

DevRadar is a local-first Obsidian plugin for following selected GitHub users and recording supported public developer activity in connected Markdown person notes.

## Status

The `v0.3.0` implementation slice lets users follow selected GitHub users, choose a global subset of Pushes, Pull requests, and Issues, and manually sync one person or all followed people. GitHub activity history is recent, limited, delayed, and non-exhaustive; DevRadar does not provide real-time activity collection.

**Platform support:** For the `v0.3.0` implementation slice, Obsidian Desktop is the designated and required runtime-validation target. Obsidian Mobile remains an intended compatibility target; iOS and Android runtime behavior is not claimed as validated.

## Development

DevRadar supports the Node.js 22 release line from 22.13.0 onward and the
Node.js 24 release line for repository development. Node.js 24 LTS is preferred
for ordinary development, while Node.js 22.13.0 remains the minimum supported
version. Node.js 23 and 25 are outside the supported toolchain policy.
Dependency and lockfile authoring uses the reviewed Node.js 22.13.0 + npm
10.9.2 baseline; see the contributor guide.

## Common commands

- `npm run dev`
- `npm run build`
- `npm run check` for full validation

## Project documentation

- [Contributor guide](CONTRIBUTING.md)
- [Product direction](docs/product-direction.md)
- [MVP architecture](docs/architecture.md)
- [Future directions (non-normative)](docs/future-directions.md)
