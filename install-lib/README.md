# install-lib/

Helper functions for `install.sh`, split out to keep the top-level script
short. Every file here is sourced (function definitions only -- nothing
executes on load), either from a local checkout or fetched individually over
`curl` when `install.sh` is run via the `curl | bash` one-liner (see the
loader block near the top of `install.sh`).

| File           | Contents                                                                 | Optional? |
|----------------|---------------------------------------------------------------------------|-----------|
| `common.sh`    | `truthy`/`falsy` (yes/no normalizing), `port_is_free`                     | no, shared by the others |
| `prompts.sh`   | hostname/simHz/maxPlayers/enableDebug resolution (env var, else prompt, else last saved value) | no, core config |
| `network.sh`   | port picking, stale-vhost detection, crash-loop recovery                  | no, core install flow |
| `resources.sh` | low-RAM detection, swap file offer, prebuilt-binary fallback download     | yes -- all a no-op on a normal-sized host |
| `tls.sh`       | certbot / Let's Encrypt (DNS-01 via Cloudflare) setup                     | yes -- skipped with `ENABLE_TLS=no` |
| `service.sh`   | admin token management + warn-then-restart (30s maintenance notice to connected players before `systemctl restart multisnake`) | no, runs every install |

If you rename or move a function, update the caller in `install.sh` in the
same commit -- there is no dynamic dispatch here, just plain `source` +
function calls in a fixed order.

The prebuilt-binary asset name (`multisnake-server-linux-x86_64`) in
`resources.sh`'s `fetch_prebuilt_binary` must match the filename
`.github/workflows/release.yml` publishes.
