# GitHub Actions runner

`research.yml` runs the existing five-task protocol on `windows-2025` with pinned Node.js and Playwright versions. The source repository is `umrtkyrk/transformers-js-research`.

The public source upload includes test code, model manifests and synthetic text fixtures. Synthetic audio is restored from the existing public fixture URLs and checked against byte lengths and SHA-256 hashes. Historical local run records and published site output are not uploaded to the source repository.

`run.mjs` restores the cloud history from the `results` branch. It records the queue before expensive inference and commits new evidence after a run. Model bytes use an Actions cache; the queue and results use Git commits, so cache eviction does not erase history. Workflow concurrency serializes all writers. A duplicate request finds the completed combination and skips inference.

Modes:

- `auto`: check the newest stable package, allow only 4.x and run it if needed.
- `verify`: run a fresh full verification for the supplied exact 4.x version.
- `scan`: run the package and model-repository discovery logic, then process at most one queued job.

The site check endpoint accepts no package, command, model, ref or force parameter from visitors. It independently reads the latest official package version and existing cloud results. Active jobs and completed versions are reused; failed runs require an owner retry through GitHub. The public control can only request `auto` on `main`.

Vercel stores one sensitive production variable, `LAB_GITHUB_TOKEN`. The fine-grained credential is restricted to this repository and Actions read/write. It does not need Contents write, Workflows write, account permissions, or access to other private repositories. The existing local helper `connect-github.ps1` sends it through stdin to the official Vercel CLI. It never writes the credential into this workspace or command arguments.

Cloud jobs use the short-lived built-in `GITHUB_TOKEN` with Contents write to save their own results. No Vercel deployment credential is given to GitHub. Vercel reads public recorded artifacts from the results branch. The old local evidence remains on Vercel under `/lab/local/` and is not migrated to GitHub.

Model inference runs on the GitHub VM. Vercel serves the interface and proxies recorded files. Cloud CPU timings are labeled with their own host information and are not a controlled speed comparison with the original workstation.

The first cold worker allows up to 3 GiB of model downloads because the full pinned five-model suite is larger than the ordinary 1,100 MiB update budget. Cached workers use the ordinary limit. Native npm dependency installation and the standard guide's separate model cache are outside that model-asset counter.

After the first cloud run is verified, disable the old Windows scheduled task to keep a single active runner. The existing local commands remain available for manual experiments.
