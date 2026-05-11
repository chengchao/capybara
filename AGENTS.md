# Capybara — working notes

## KISS

Keep it simple. Pick the smallest shape that solves the actual problem; let
complexity arrive only when something concrete demands it.

In practice that means:

- **No abstractions for ≤2 sites.** Two near-duplicate helpers beat one
  callback-flavored extraction. Wait for the third caller.
- **No defenses for unreached threats.** Per-op sudoers narrowing, recreate-
  on-mismatch logic, custom error codes — only ship them when a real attacker
  or operator hits the gap. Document the trust boundary; trust it.
- **No primitives for absent consumers.** Concurrency, cancel, streaming,
  structured error variants — each waits for a UX or product driver. Strict
  request/response is the default until a chunk variant is _needed_.
- **No micro-optimizations against rounding-error costs.** Replacing a
  subprocess with a syscall, caching a microsecond JSON parse, batching
  a one-time provisioning step — skip unless profiling proves it matters.
- **No comments for what well-named code already says.** Comments earn
  their keep only when the _why_ is non-obvious (a hidden constraint, a
  subtle invariant, a workaround for a specific bug).
- **No half-finished implementations.** A bug fix doesn't need surrounding
  cleanup; a one-shot doesn't need a helper. Three similar lines is better
  than a premature abstraction.

When in doubt, ship the smaller version and add the bigger one when the
need is concrete and named.
