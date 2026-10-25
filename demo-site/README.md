# Public Orloj Stellar showcase

Live: https://orloj-stellar-demo.vercel.app

Independent static HTML/CSS/JS; no dependencies, environment variables, backend or wallet calls. Publish this directory only. The working app stays local and its repository remains private.

The 70-second silent video is an edited sequence of seven captioned scenes from real captured application screens. Crops exclude account details and internal IDs; they do not change interface contents. The transaction shown is historical Testnet evidence, not a newly submitted payment. `assets/captions.vtt` and the HTML transcript provide accessible alternatives.

`data/evidence.json` is a curated snapshot of checked-in acceptance evidence. It omits private paths, credentials, signing payloads and agent identities. Counts include funding/setup and do not represent complete integrations. The eleven-entry audit has five entries with Testnet write evidence.

Preview locally with `python3 -m http.server 3080 --bind 127.0.0.1 --directory demo-site` from the repository root. Deploy manually with `vercel --cwd demo-site --scope ayudaria --prod`; link to `orloj-stellar-demo` first. Automatic Git deployment is disabled. No paid plan or custom domain is needed.
