# Claude Code Instructions for ocean-node

## Node.js version

This repo requires **Node.js 22** (see `.nvmrc`).

**Always run `nvm use` before any test, build, or `npm` command**, or the wrong Node version will be active and commands will fail with errors like `Unexpected token 'with'` or missing `GLIBC_2.38`.

```bash
source ~/.nvm/nvm.sh && nvm use
```

If `sqlite3` native bindings fail after switching to Node 22, rebuild from source:

```bash
npm_config_build_from_source=true npm rebuild sqlite3
```

## Running tests

```bash
# Unit tests (compute only — fast)
source ~/.nvm/nvm.sh && nvm use && npm run test:computeunit

# All unit tests
source ~/.nvm/nvm.sh && nvm use && npm run test:unit
```
