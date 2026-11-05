# Contributing

* Branch from `main`; never commit directly to `main`. Use conventional commits (`feat:`, `fix:`, `docs:`, `test:`).
* Run `npm test` before pushing; add tests for every behavior change (see `test/`).
* Keep the project dependency-free unless there is a strong reason.
* Business rules live in `src/services` / `src/domain`; HTTP stays a thin layer. Validate before mutating so failures leave no partial state.
* Never commit secrets or `.env` files.
