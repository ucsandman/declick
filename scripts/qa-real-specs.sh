#!/usr/bin/env bash
# Release gate against the real world: six public specs from their live URLs, real keyless calls, the auth
# path, PATH install in a fresh login shell, the web page refusal, and the Node guard. Everything runs in a
# throwaway DECLICK_HOME. Exit 1 on the first failed expectation, with the command and its output.
#
#   npm run qa                 the checkout (node bin/declick.mjs)
#   QA_FROM_NPM=1 npm run qa   the published package (declick on PATH)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DECLICK_HOME="${TMPDIR:-/tmp}/declick-qa-$$"; export DECLICK_SKILLS="$DECLICK_HOME/skills"
mkdir -p "$DECLICK_HOME" "$DECLICK_SKILLS"; trap 'rm -rf "$DECLICK_HOME"' EXIT
# Saved before the unset below so the dashclaw contract check (which talks to the real DashClaw instance
# directly, not through $D) still sees the operator's own env; every $D call under test stays ungoverned.
QA_DASHCLAW_KEY="${DASHCLAW_API_KEY:-}"; QA_DASHCLAW_URL="${DASHCLAW_URL:-}"
unset DASHCLAW_API_KEY DASHCLAW_URL
if [ "${QA_FROM_NPM:-}" = "1" ]; then D="declick"; else D="node $ROOT/bin/declick.mjs"; fi
fails=0; checks=0
ok()   { checks=$((checks+1)); printf 'ok   %s\n' "$1"; }
bad()  { checks=$((checks+1)); fails=$((fails+1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }
# expect <label> <regex> <command...>: stdout must match the regex
expect() { local label="$1" re="$2"; shift 2; local out; out="$("$@" 2>/dev/null)"; if printf '%s' "$out" | grep -Eq "$re"; then ok "$label"; else bad "$label" "$(printf '%s' "$out" | head -c 300)"; fi; }
# expect_rc <label> <code> <command...>: exit code must equal
expect_rc() { local label="$1" want="$2"; shift 2; "$@" >/dev/null 2>&1; local rc=$?; if [ "$rc" = "$want" ]; then ok "$label (rc=$rc)"; else bad "$label" "exit $rc, wanted $want"; fi; }

echo "== declick $($D version --json 2>/dev/null | grep -o '"version":"[^"]*"') from $([ "${QA_FROM_NPM:-}" = 1 ] && echo npm || echo checkout), node $(node -v)"

echo "== six public specs"
add() { local name="$1" url="$2" verbs="$3"; expect "add $name ($verbs verbs)" "\"ok\":true" $D add "$url" --name "$name" --json;
  local n; n="$($D describe "$name" --json 2>/dev/null | grep -o '"name":"[^"]*","description"' | wc -l | tr -d ' ')"
  [ "$n" -ge "$verbs" ] && ok "  $name compiled $n verbs" || bad "  $name verb count" "$n, wanted >= $verbs"
  local len; len="$($D describe "$name" --json false 2>/dev/null | wc -c | tr -d ' ')"
  [ "$len" -lt 2000 ] && ok "  $name describe is $len chars" || bad "  $name describe length" "$len chars, ceiling 2000"; }
add stripeapi https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json 500
add stripeyaml https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml 500
add ghapi https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json 1000
add ov https://api.openverse.org/v1/schema/ 15
add wx https://api.weather.gov/openapi.json 50
add pety https://petstore3.swagger.io/api/v3/openapi.yaml 19
expect "stripe describe pages with a footer" "more verbs \([0-9]+ total\)" $D describe stripeapi --json false

echo "== real calls, keyless"
expect "openverse search returns rows" '"rows":"results"' $D run ov images-search --q cat --page_size 2 --limit 2 --fields title
expect "weather point sends the User-Agent default and answers" '"properties.gridId"' $D run wx point 39.7456 -97.0892 --fields properties.gridId
# A CI runner's IP shares GitHub's 60/hour unauthenticated budget with every other runner; the token the workflow
# already holds lifts that, and the check still proves the same --fields behaviour. Locally, no token, same call.
GH_AUTH=(); [ -n "${GITHUB_TOKEN:-}" ] && GH_AUTH=(--header "Authorization: Bearer $GITHUB_TOKEN")
expect "github repository with --fields is the repository, not its topics" '"full_name":"ucsandman/declick"' $D run ghapi repos-get ucsandman declick "${GH_AUTH[@]}" --fields full_name,stargazers_count
if [ -n "$QA_DASHCLAW_KEY" ] && [ -n "$QA_DASHCLAW_URL" ]; then
  # argv (not a string-interpolated import specifier) so a POSIX-style path from a bash on Windows still
  # resolves: pathToFileURL handles whatever form the shell hands it, the way `node $ROOT/bin/declick.mjs` does.
  gbody="$(node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const { guardBody } = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(JSON.stringify(guardBody({ tool: 'qa', action: 'delete-pet', engine: 'openapi', method: 'delete', target: 'https://api.example.com/pet/7', args: { id: '7' } })));
  " "$ROOT/src/guard.mjs")"
  gresp="$(curl -s -o "$DECLICK_HOME/dashclaw-resp.json" -w '%{http_code}' -X POST "$QA_DASHCLAW_URL/api/guard" -H 'content-type: application/json' -H "x-api-key: $QA_DASHCLAW_KEY" -d "$gbody")"
  gbody_out="$(cat "$DECLICK_HOME/dashclaw-resp.json" 2>/dev/null)"
  if [ "$gresp" = "200" ] && printf '%s' "$gbody_out" | grep -q '"decision"'; then ok "dashclaw contract: guardBody() posts to /api/guard and gets a decision"
  else bad "dashclaw contract: guardBody() posts to /api/guard and gets a decision" "http $gresp: $(printf '%s' "$gbody_out" | head -c 200)"; fi
else
  echo "skip dashclaw contract (DASHCLAW_API_KEY unset)"
fi
expect "petstore user endpoint (README quickstart line 4)" '"username":"user1"' $D run pety get-user-by-name user1 --fields username,email

echo "== auth and contract"
expect "petstore YAML compiled both auth schemes" 'PETY_API_KEY' $D manifest pety --json
expect_rc "get-pet-by-id without a key exits 4" 4 $D run pety get-pet-by-id 7
expect "exit 4 message names the key and no private tool" 'set PETY_API_KEY' $D run pety get-pet-by-id 7 --json
expect_rc "--limit 0 exits 1" 1 $D run pety get-pet-by-id 7 --limit 0 --json
expect "--limit 0 still returns the envelope" '"ok":false' $D run pety get-pet-by-id 7 --limit 0 --json
expect "did-you-mean prefers the prefix match" 'get-pet-by-id' $D run pety get-pet 7 --json
expect "a web page URL is refused as a spec" 'is a web page, not an API spec' $D add https://example.com --name bad --json
expect "engines --source points at the web: form" 'declick add web:' $D engines --source https://example.com --json
err="$($D run pety add-pet --name x --photoUrls a --dry-run 2>&1 >/dev/null)"
if [ -z "$err" ]; then ok "a mutating call with no guard key is silent on stderr"; else bad "a mutating call with no guard key is silent on stderr" "$(printf '%s' "$err" | head -c 200)"; fi

echo "== path --install in a fresh login shell"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ok "skipped on Windows: path --install would setx the real user PATH" ;;
  *) inst="$($D path --install --json 2>&1)"
     shell="${SHELL:-/bin/bash}"
     got="$("$shell" -lc "pety get-user-by-name user1 --fields username" 2>&1)"
     if printf '%s' "$got" | grep -q '"username":"user1"'; then ok "short form on PATH in a login $(basename "$shell")"
     else files="$(cd ~ && ls -a | grep -E '^[.](bash_profile|bash_login|profile|zprofile)$' | paste -sd, -)"
       bad "short form on PATH in a login $(basename "$shell")" "install: $(printf '%s' "$inst" | head -c 200) | shell: $(printf '%s' "$got" | head -c 200) | profile files: ${files:-none}"; fi ;;
esac

echo "== setup dry-run and round trip"
CLIENT_HOME="${TMPDIR:-/tmp}/declick-qa-client-$$"; mkdir -p "$CLIENT_HOME/.claude"
cat > "$CLIENT_HOME/.claude.json" <<EOF
{"mcpServers":{"qa-notes":{"command":"node","args":["$ROOT/fixtures/mcp-server.mjs"]}}}
EOF
export DECLICK_CLIENT_HOME="$CLIENT_HOME"
expect "setup --dry-run reports the plan" '"wouldBuild"' $D setup --dry-run --no-path --json
[ -f "$CLIENT_HOME/.claude/CLAUDE.md" ] && bad "setup --dry-run wrote nothing" "CLAUDE.md exists after --dry-run" || ok "setup --dry-run wrote nothing"
expect "setup adopts the qa-notes server" '"qa-notes"' $D setup --no-path --json
[ -f "$CLIENT_HOME/.claude/CLAUDE.md" ] && ok "setup wrote the rules block" || bad "setup wrote the rules block" "CLAUDE.md missing"
expect "setup --revert restores the client home" 'files restored' $D setup --revert --json
[ -f "$CLIENT_HOME/.claude/CLAUDE.md" ] && bad "setup --revert removed what it created" "CLAUDE.md still there" || ok "setup --revert removed what it created"
unset DECLICK_CLIENT_HOME
rm -rf "$CLIENT_HOME"

echo "== node guard"
expect "Node below 24 is one line, not a stack trace" 'declick needs Node 24 or newer' env DECLICK_NODE_VERSION=18.0.0 $D doctor --json

echo "== $((checks - fails)) of $checks checks passed"
[ "$fails" -eq 0 ]
