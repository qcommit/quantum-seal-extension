# Test fixtures

`spl_associated_token_account-1.1.1.so` is the SPL Associated Token Account program
binary shipped with Agave 3.1.10 (`program-binaries/src/programs/` in the Agave
repository, Apache-2.0). The local test validator does not include it in its default
genesis, so `e2e/run.mjs` loads it with `--bpf-program`. Test use only.

SHA-256: `e5e7aed11ad3969eea2aa76c8b4d2e73ea25be7e6b5cce989b7710cf5452496e`
