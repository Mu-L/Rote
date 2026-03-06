# Agent Instructions

## Package Manager Policy

- Always use Bun for JavaScript/TypeScript workflows in this repository.
- Do not use npm, pnpm, or yarn unless the user explicitly asks for it.

## Command Conventions

- Install dependencies: `bun install`
- Run scripts: `bun run <script>`
- Run package binaries: `bun x <command>`
- Add dependencies: `bun add <pkg>`
- Add dev dependencies: `bun add -d <pkg>`

## Project Paths

- Frontend commands should run in `web/`.
- Backend commands should run in `server/`.

## Validation Policy

- After every code change, run both lint and build before finishing.
- If frontend is changed, run in `web/`:
  - `bun run lint`
  - `bun run build`
- If backend is changed, run in `server/`:
  - `bun run lint`
  - `bun run build`
