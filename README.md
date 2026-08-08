# AOS-Bridge

Minimal TypeScript foundation for the AOS-Bridge project.

## Structure

- `src/adapters/` — external-system adapter contracts
- `src/core/` — bridge core contract
- `src/types/` — shared task types

## Validation

```sh
npm run typecheck
```

## Manual bridge end-to-end check

After installing dependencies, run:

```sh
AO_BASE_URL=<base-url> AO_PROJECT_ID=<project-id> AO_HARNESS=<harness> AO_DISPLAY_NAME=<display-name> npm run bridge:e2e
```
