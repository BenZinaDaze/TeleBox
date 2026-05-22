# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime code. Use `src/index.ts` as the entry point, `src/plugin/` for built-in command plugins, `src/utils/` for shared runtime helpers, and `src/hook/` for Telegram patch/listener hooks. Put user-installed or local experimental plugins in `plugins/`. Static assets belong in `assets/`; disposable files go in `temp/`. Core config lives in `package.json`, `tsconfig.json`, and `ecosystem.config.cjs`.

## Build, Test, and Development Commands
Run `npm install` with Node `24.x` to match `package.json`.

- `npm run dev` starts TeleBox in development mode.
- `npm start` runs the main bot entrypoint with the project `tsx` loader.
- `npm run tpm` runs the plugin manager entrypoint directly.
- `npx tsc --noEmit` performs the only built-in static verification pass.

There is no dedicated build or test script yet; contributors should at minimum run the TypeScript check before opening a PR.

## Coding Style & Naming Conventions
The codebase is strict TypeScript with `moduleResolution: NodeNext`. Match the existing formatting in nearby files: double quotes, semicolons, and concise inline comments only where behavior is non-obvious. Prefer `camelCase` for variables/functions, `PascalCase` for classes, and descriptive file names such as `pluginManager.ts` or `teleboxInfoHelper.ts`. Keep plugin commands short and lowercase, and place shared Telegram/runtime logic in `src/utils/` instead of duplicating it across plugins.

## Testing Guidelines
There is currently no automated test suite or coverage gate in the repository. For each change, run `npx tsc --noEmit` and then exercise the affected command or plugin through `npm run dev`. When adding a plugin, verify command registration, help output, and any cleanup/setup behavior manually. If you introduce a reusable test harness later, place it under a top-level `tests/` directory and mirror source names where possible.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style, for example `feat: add plugins...`, `fix: ...`, and `fix(logger): ...`. Keep commits scoped, imperative, and easy to scan. Pull requests should explain the user-facing effect, note any config or environment changes, and list the manual verification performed. Include screenshots or chat output only when UI/help text changes are relevant.

## Configuration & Security Tips
Do not commit secrets, Telegram session files, or local `.env` values. Keep generated or temporary artifacts out of version control, and prefer environment variables for behavior toggles such as command-prefix or edited-message settings.
