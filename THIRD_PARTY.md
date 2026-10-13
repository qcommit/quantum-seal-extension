# Third-party material

Project-owned code is MIT licensed; see `LICENSE`. Dependency versions and integrity
hashes are pinned in `package-lock.json`. The wallet SDK is reviewed at the commit
recorded in `CORE_REF` and has its own `THIRD_PARTY.md` and license notices.

Every extension build includes the project's `LICENSE` and a generated
`THIRD_PARTY_NOTICES.txt` containing complete license and NOTICE files for the
packages esbuild actually bundles, including the wallet SDK. This supplements
esbuild's linked copyright comments. A missing package license fails the build.
Inter's SIL Open Font License is also included beside the bundled fonts.

Several npm packages omit the full license file. `licenses/upstream.json` records
exact-version copies from their official Git tags, immutable source URLs and
SHA-256 hashes; the build verifies these copies and refuses unreviewed versions.
The loader-v3 and stake packages declare MIT in npm metadata, while the LICENSE
files at their official release tags contain Apache-2.0. Both the declaration and
the unmodified upstream license text are retained in the generated notices.

The local-validator fixture `e2e/fixtures/spl_associated_token_account-1.1.1.so`
comes from Agave 3.1.10 under Apache-2.0. Its provenance and SHA-256 are in
`e2e/fixtures/README.md`, with the license in `e2e/fixtures/LICENSE-Agave.txt`.
This fixture and development tools are not included in the extension ZIP.
