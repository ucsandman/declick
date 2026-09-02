# fixtures

These fixtures are the hand-written recipe path used by tests. Authored recipes are stored per adapter under ~/.declick/<name>/recipes/.

Adapters used by the test suite. Each directory passed to `--recipes` becomes one desktop adapter, one verb per `*.json` file, verb name from the file name.

## petstore.json

Trimmed OpenAPI 3 spec with four operations. Feeds the openapi engine tests and the README install walkthrough. Dry run only; no test ever calls petstore3.swagger.io.

## calculator/

`add.json`: presses two digits and Plus and Equals in the Windows Calculator, then reads the display. Used by the CLI test (compile and lint only) and by the live suite (`DECLICK_LIVE=1 npm run test:live`) for a real replay of `Seven + Seven` expecting 14.

The `tree` array records the `ControlType:Name` keys observed at authoring time. It is only used to build the diff printed when a path goes missing, so a stale `tree` degrades the error message, never the replay.

## broken/

`add.json`: the calculator recipe with `Button:Plus` deliberately renamed to `Button:Plus Sign`. It exists so the not found path is observed failing on purpose: replay must exit 2 and name the missing element instead of clicking something else. A checker that has never failed has been run, not verified.

## notepad/

`write-text.json`: types a string into the open Notepad document and reads it back.

Control type caveat: the Notepad edit surface is `Document` on some Windows 11 builds and `Edit` on others. The fixture ships the `Document:*` path. If the live test exits 2 here, run `desk snapshot Notepad`, read the real control type off the tree, and change the two `find` paths in the fixture to match. Record the observed value in this file when you do:

- Observed control type: `Document` on Windows 11 Pro 10.0.26200 (live replay 2026-09-02, 3/3 pass, fixture unchanged).
