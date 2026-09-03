# declick visual system

## The adjective

A hardware service manual: ruled tables, a fixed spacing scale, one accent used the way a warning plate is used on real equipment, and every claim proven by the output that produced it.

## The five commitments

1. Warm graphite neutrals, seeded from #0f1115. Not slate, not zinc.
2. Radius 0 everywhere, no exception: buttons, chips, mono blocks, focus rings.
3. Two typefaces only. Archivo sets every human sentence. Spline Sans Mono sets every literal declick emits or accepts. Nothing crosses that line.
4. #ffb454 amber stays under 10% of any surface. It is the seed color and it is kept. In light mode it never appears as text; #8a4b04 carries links and the prompt sigil there instead, and anything that would otherwise be amber text becomes a filled amber plate with dark ink, the way a warning plate is printed on hardware.
5. The exit chip is the one signature token: a square, 1px-bordered tag reading exit 0 through exit 4, introduced once in the contract table and reused under roughly twenty blocks so the reader absorbs the exit code contract by repetition, not by being told.

## Voice rules

- Every sentence is one Wes Sander would say to another engineer: plain, short, specific, no hype. Read a paragraph aloud before it ships.
- No em dashes and no en dashes anywhere in outward copy, including alt text, captions, meta descriptions, og.html and llms.txt. A double hyphen appears only as a literal CLI flag inside code or pre (--json, --dry-run), never as punctuation.
- Banned words, checked by script: elevate, seamless, seamlessly, unlock, supercharge, streamline, empower, revolutionize, effortless, world-class, enterprise-grade, cutting-edge, best-in-class, leverage, unleash, transform, next-generation, game-changer, mission-critical, stay competitive, drive growth, robust, powerful, delightful, magic, blazing.
- No "it's not X, it's Y" cadence. If three section bodies end on a short rebuttal-shaped sentence, rewrite one.
- No claim about any other product. The page says what declick does and what an image in a context window is; it never says nobody else compiles Windows apps or that browser agents cannot be observed.
- Every terminal line is real, captured from the shipped binary on the stated Node version. Home paths are shortened to ~, that is disclosed once, and nothing else is edited. No ellipsis is fabricated. The one block that cannot be captured live (a tree-diff miss) is labelled as the documented shape from the README.
- Any block that shows governance.enabled true must carry DASHCLAW_API_KEY and DASHCLAW_URL on the same command line, so the page never implies governance is on out of the box.
- meta.governance is never trimmed from an adapter-run failure envelope. If a block is too long, project it with --fields and say so in the caption.
- Requirements appear in full and in the same voice as the features. Roadmap gaps carry a [not shipped] chip and are never softened.
- author, repair and ui are never described as previewable.
- The CTA label is one string everywhere it appears. Link text has standalone meaning on its own, out of context.
- No fake social proof: no logo row, no testimonial, no user count, no star count. Reproducibility is the proof; every block names the command that regenerates it.
- No uppercase eyebrows, no numbered section markers, no all-caps body.
- The headline and subhead are not repeated as a section heading or opening line anywhere below the hero.
- Numbers use thousands separators in prose (1,583) and stay verbatim inside terminal blocks (1583).

## The light-mode accent decision

The brand seed is #0f1115 on dark and #ffb454 as the accent, and both are kept. What changes is how the accent behaves in light mode.

One hex across both themes does not work: #ffb454 on white measures 1.76:1, which fails even the 3:1 graphical floor, let alone 4.5:1 for text. So light mode carries two accent tokens instead of one.

- --accent-ink #8a4b04, the same amber one ramp step down (hue 31.8 against the dark accent's 33.7), used for links, the prompt sigil in running text, the focus ring and rule leads. Measures 6.80:1 on white and 6.07:1 on the warm tint used inside mono blocks and table heads.
- --accent #ffb454 survives in light mode only as a filled plate, never as text: the nonzero exit chip and the primary button become an amber plate carrying #17191d ink at 9.98:1, the way a warning plate is printed on real hardware.

Dark mode needed no such split: --fg #f2ede4 measures 16.21:1 on --bg and 15.08:1 on --code, --dim #a29a8c measures 6.78:1 on --bg, and --accent #ffb454 itself measures 10.72:1 on --bg and 9.97:1 on --code, so it carries text directly there.

This is recorded as a deliberate change to how the brand seed is used in light mode, not a change to the seed itself.

## The fallback metrics decision

Still two typefaces. The stylesheet carries one @font-face that is not a third typeface: it remaps "Segoe UI", the fallback already named in --sans, so it occupies Archivo's space while Archivo is still in flight.

Segoe UI sets 1.03 percent wider than Archivo at the same size. In the 19px lead paragraph at a 412px viewport that is one extra line, so the button, the install line, the hero links and the first prose paragraph all jump up 28.5px the moment the webfont swaps in. Measured on the shipped page: cumulative layout shift 0.207 before, 0.046 after, and mobile performance 89 before, 99 after.

The 98.98 percent is measured, not a constant. It is the ratio of Archivo's advance to Segoe UI's advance over the lead paragraph string at 100px, taken with canvas measureText against the Segoe UI installed on the machine that ran the check. A new Segoe UI or a new Archivo can move it. Re-measure at every release with the rest of the recapture procedure, and if the ratio drifts, re-run Lighthouse mobile on / and read the cumulative layout shift.

```
@font-face {
  font-family: "Archivo Metrics";
  src: local("Segoe UI"), local("SegoeUI");
  size-adjust: 98.98%;
  ascent-override: 88.91%;
  descent-override: 21.22%;
  line-gap-override: 0%;
}
```

--sans becomes "Archivo", "Archivo Metrics", "Segoe UI", system-ui, sans-serif. The rendered page still uses exactly two typefaces: Archivo once it lands, Segoe UI before that. Where Segoe UI is not installed the local source is unavailable, the family is skipped, and the stack falls through to the original entries unchanged. The self-hosted faces below keep font-display: swap, which is what the Google Fonts URL carried before them.

## Self-hosted fonts

Both families are served from site/fonts/, not from fonts.googleapis.com. Two reasons.

The stylesheet link to fonts.googleapis.com is render blocking and sits on a third-party origin, so the browser pays a DNS lookup, a TLS handshake and a round trip before it can start the font files. Lighthouse charged 5 points of mobile performance on / for it. Self-hosted, the two woff2 files come off the same connection as the page and are preloaded in the head.

og.html has to be self-contained. It is rendered from file:// to make og.png, and the site test asserts it carries no external link and no external script. A Google Fonts link failed both.

Google's css2 endpoint returns one variable woff2 per family for the latin subset: the same URL is named for weight 400, 500 and 700. So the six requested faces are two files, and the stylesheet declares one @font-face per family with a weight range instead of three static faces each.

- site/fonts/archivo-var.woff2, 34,928 bytes, font-weight 100 900, font-stretch 100%
- site/fonts/spline-sans-mono-var.woff2, 36,476 bytes, font-weight 300 700

The unicode-range on both faces is the latin range copied verbatim out of the css2 response, so a character outside it falls through the stack in --sans or --mono instead of downloading anything.

Both families are SIL Open Font License 1.1. The license text ships beside the files it covers, at site/fonts/OFL-archivo.txt and site/fonts/OFL-spline-sans-mono.txt, so a copy of the directory cannot separate the fonts from their terms.

The weight axis is real, not synthetic bolding. Archivo advances 1,151.68, 1,171.21 and 1,230.40 px for the same string at 100px in weights 400, 500 and 700. Spline Sans Mono is monospaced, so its advance never moves at any weight; measured instead as dark pixel coverage it reads 10,613, 11,966, 13,510 and 14,422 at 400, 500, 600 and 700, against 14,913 for the same file pinned to one weight and emboldened by the browser.

One operational consequence for the recapture procedure: rendering og.png now needs a browser that will let a file:// page read a file beside it. Launch headless Chromium with --allow-file-access-from-files, and confirm with CSS.getPlatformFontsForNode that the h1 is painted in Archivo before saving the PNG. Without the flag the woff2 is blocked as a cross-origin fetch, nothing is logged, and the image renders in the fallback face.

## The license section

0.3.0 on npm is MIT and stays MIT. Every release after it is under the Elastic License 2.0: the source is public, you can read it, run it, change it and ship it inside your own product, and you cannot offer it to other people as a managed service. Teams and production support get a commercial license.

That is one section on /, id license, between requirements and install, plus an anchor in the hero section list. The h2 is "0.3.0 is free. Teams get a license.", then two paragraphs, then a secondary button.

The request path is a mailto, not a form. The page carries no script and no third-party origin at all, and a form service would add both for a request volume that is currently zero. A mailto also seeds the two things the reply needs: team size, and what they are compiling. The button reads "Request a license" and is that one string in the hero, in the license section and in both footers.

The button is the primary plate outlined instead of filled: 1px --line-strong border, --fg ink, transparent ground, the same 16px by 24px padding, radius 0, and the same hover lift and focus ring. Installing declick is still the primary action, so it stays filled and stays first.

No pricing, no license keys and no paid feature exist, so the page names none. The footers read "declick 0.3.0. Built by Practical Systems." with no license word in them. The version stamp on /controls still reads license MIT, because that row is about 0.3.0 and it is true.

## The states decision

The page has no forms, no async requests, and no copy button, so there is no disabled, loading, error or success UI state to design. The one thing that looks like an error state, the exit 1/2/3/4 envelopes, is shown as content: real captured output, not a fabricated interface state. Interactive elements are limited to the primary button, text links, and in-page anchors, each with a default, hover, focus-visible and active state and nothing else.

## Recapture procedure

Run at every release, from the repo root. The env prefix goes on every command line: on its own line it only prints the environment, and the adds below would inherit whatever guard variables the shell already has.

```
env -u DASHCLAW_API_KEY -u DASHCLAW_URL declick add https://petstore3.swagger.io/api/v3/openapi.json --name petstore
env -u DASHCLAW_API_KEY -u DASHCLAW_URL declick add app:Calculator --name calculator --recipes fixtures/calculator
env -u DASHCLAW_API_KEY -u DASHCLAW_URL declick add "mcp:node fixtures/mcp-server.mjs" --name demo
env -u DASHCLAW_API_KEY -u DASHCLAW_URL declick add cli:git --name gitx --verbs status,log,diff
```

Then run every command shown on the page with the same env prefix, piping through sed "s#$HOME#~#g" and adding --json false where the page shows text output. The strict-guard block is the one exception: run it with DASHCLAW_API_KEY=test-key DASHCLAW_URL=http://127.0.0.1:9 on the command line, not with the variables unset. The calculator dry run opens Calculator on the machine that runs it.

Remove the four adapters afterward with declick remove so no test skill leaks into ~/.claude/skills.

The hero numbers (19 verbs, 1,583 characters) come from a third-party live spec at petstore3.swagger.io and can change without anyone touching the repo. The release checklist re-measures them before each recapture.

After the terminal blocks are recaptured, rebuild og.png: render site/og.html with a headless Chromium at 1200x630, device scale 1, and overwrite site/og.png. The fonts are self-hosted now, so launch that browser with --allow-file-access-from-files, or the woff2 is blocked as a cross-origin fetch and the image renders in the fallback face with nothing logged. See Self-hosted fonts above. Confirm the file is under 300 KB, that the h1 still fits on two lines at its set size, and that CSS.getPlatformFontsForNode reports Archivo on the h1 before you keep the PNG.

## Analytics and Search Console

The page ships one script: Vercel Web Analytics, loaded deferred from /_vercel/insights/script.js on the same origin (no cookies, no third-party host). It is the only JavaScript on the site and nothing on the page depends on it; with JS disabled the page is unchanged. Enabled in the Vercel project on 2026-09-03. Google Search Console verifies https://declick.dev/ through the google-site-verification meta tag in the head of index.html; removing that tag revokes the verification.
