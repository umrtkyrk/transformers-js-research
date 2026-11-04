# Transformers.js research runner

Reproducible Node CPU and Microsoft Edge WASM benchmarks. Runs on a GitHub-hosted Windows runner.

- Website: https://transformers-js-research.vercel.app/lab/
- Workflow: Actions → Research benchmarks
- `auto`: test the newest supported stable package only when not already completed.
- `verify`: create an independent full run for the supplied exact 4.x version.
- `scan`: inspect selected model revisions and compatible new model repositories.

Results are committed to the `results` branch before and after inference. Historical runs are retained. Model weights, personal settings, credentials, and private process logs are excluded.

The protocol contains 54 technical checks across five tasks. Completion does not mean every check passed. CPU timings from different hosts are observations, not a controlled performance comparison.

No paid LLM API integration is used.
