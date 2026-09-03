# fixtures

These fixtures are the hand-written recipe path used by tests. Authored recipes are stored per adapter under ~/.declick/<name>/recipes/.

Adapters used by the test suite. Each directory passed to `--recipes` becomes one desktop adapter, one verb per `*.json` file, verb name from the file name.

## petstore.json

Trimmed OpenAPI 3 spec with four operations and an absolute server url. Feeds the openapi engine tests. Dry run only; no test ever calls petstore3.swagger.io.

## openapi-edge.json

One spec that exercises the edge cases the openapi engine must handle: a relative server url with variables, $ref parameters and bodies, path plus operation parameters, hyphenated names, required query params, oauth2 and cookie auth, a form body, missing operationIds, and reserved flag names.

## calculator/

`add.json`: presses two digits and Plus and Equals in the Windows Calculator, then reads the display. Used by the CLI test (compile and lint only) and by the live suite (`DECLICK_LIVE=1 npm run test:live`) for a real replay of `Seven + Seven` expecting 14.

The `tree` array records the `ControlType:Name` keys observed at authoring time. It is only used to build the diff printed when a path goes missing, so a stale `tree` degrades the error message, never the replay.

## broken/

`add.json`: the calculator recipe with `Button:Plus` deliberately renamed to `Button:Plus Sign`. It exists so the not found path is observed failing on purpose: replay must exit 2 and name the missing element instead of clicking something else. A checker that has never failed has been run, not verified.

## notepad/

`write-text.json`: types a string into the open Notepad document and reads it back.

Control type caveat: the Notepad edit surface is `Document` on some Windows 11 builds and `Edit` on others. The fixture ships the `Document:*` path. If the live test exits 2 here, run `desk snapshot Notepad`, read the real control type off the tree, and change the two `find` paths in the fixture to match. Record the observed value in this file when you do:

- Observed control type: `Document` on Windows 11 Pro 10.0.26200 (live replay 2026-09-02, 3/3 pass, fixture unchanged).

## petstore.yaml

The same API as `petstore.json` written in YAML, with flow and block mappings, quoted scalars, a literal `|-` block, a folded `>-` block and comments. It proves the built-in YAML reader in `src/yaml.mjs` compiles a spec to the same manifest the JSON file produces.

## swagger2.json

A Swagger 2.0 spec (`host` + `basePath`, `securityDefinitions`, body parameter). The openapi engine converts it to OpenAPI 3 before compiling.

## postman.json / insomnia.json

A Postman v2.1 collection and an Insomnia v4 export for the postman engine: folders become `--tag`, `{{vars}}` and `:params` become args, recorded auth headers become env key names and never reach a manifest.

## sample.har

A browser network capture for the har engine. Numeric and uuid path segments generalize to one `{id}` verb, assets and other hosts are dropped, and `--host` picks the API host when a capture has several.

## graphql-schema.json

An introspection result (Query.pets/pet, Mutation.addPet/deletePet, an enum and an input object). A `.json` file is routed by what is inside it, so this one lands on the graphql engine without `--engine`.

## mcp-server.mjs

A real zero-dependency MCP stdio server: `initialize`, `tools/list` (three tools, one with an `outputSchema` and a `limit` property that collides with a contract flag) and `tools/call`. `--framing content-length` switches the reply framing so both framings are exercised.

## fake-tool.mjs and help-*.txt

`fake-tool.mjs` is a subcommand tool (`list`, `get`, `create`, `delete`) with `--json` output for the cli engine; `FAKE_TOOL_BARE=1` drops its Commands block and `FAKE_TOOL_NOHELP=1` forces the `-h` fallback. The `help-*.txt` files are real `--help` captures from git, gh and npm, so the help parser is tested against text nobody wrote for it.

## deskclaw-snapshot.txt

A real deskclaw snapshot capture (`@eN Type "Name" [x,y] key=value...` lines, including the offscreen trailer) used to test the snapshot parser against text deskclaw actually produces, not a hand-typed approximation.

## web/ and web-recipes/

`web/` is a small static site (a form, a three-row list, a link and a counter button) served over http by the web tests; `web-recipes/` is the `--recipes` directory that compiles into its verbs. Recipes here use the browser step language (`goto`, `read-all`, `wait-for`), not the desktop one.
