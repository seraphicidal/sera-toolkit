# An extraction node on an Android phone

A phone on a home or mobile connection is a residential address, which is exactly what an
extraction node needs: YouTube refuses the server, and answers the phone. This guide runs
the same node the laptop runs ([EXTRACTION-NODE.md](EXTRACTION-NODE.md)) inside **Termux**,
keeps it running with the screen off, starts it when the phone boots, and keeps its yt-dlp
current.

**Android only.** An iPhone cannot do this: iOS suspends background apps within minutes and
has no equivalent of Termux, so a node there would be offline almost all the time.

## Before you start: what it costs

- **Data.** Every YouTube download the node handles crosses its connection twice: down from
  YouTube, then up to the server. A 1 GB video is about 2 GB of transfer. On mobile data that
  adds up fast, so the default is **Wi-Fi only** (below).
- **Battery and heat.** Downloading and remuxing video keeps the CPU and radio busy. A phone
  left on a charger is the comfortable setup, and there is an option to run only while
  charging.
- **Storage.** Each job is written to the phone while it runs (up to the server's size limit)
  and deleted as soon as it is uploaded.

The node only takes work the server could not do itself, and only for the providers it is
told to (`youtube`), so an idle node costs almost nothing: one small request every 25
seconds.

## 1. Install the apps

Install all three from the **same source**, F-Droid or each project's GitHub releases. They
share a signing key with each other, and the Play Store build of Termux is outdated and
cannot use the other two.

| App         | What it is for                                               |
| ----------- | ------------------------------------------------------------ |
| Termux      | the Linux environment the node runs in                       |
| Termux:Boot | starts the node when the phone boots                         |
| Termux:API  | lets the node see Wi-Fi and charging state (for the options) |

Then:

1. **Open Termux:Boot once.** Android only lets it run at boot after it has been opened.
2. **Let Termux run in the background.** Settings → Apps → Termux → Battery →
   **Unrestricted** (wording varies by maker; on Samsung also remove it from "Sleeping
   apps"). Do the same for Termux:Boot.
3. **Termux:API needs location** to read Wi-Fi state: Settings → Apps → Termux:API →
   Permissions → Location → Allow all the time. Skip this if you turn the Wi-Fi option off.
4. **Android 12 and later** kill "phantom" background processes. On Android 14+, turn on
   Developer options → **Disable child process restrictions**. On 12–13, from a computer with
   adb: `adb shell settings put global settings_enable_monitor_phantom_procs false`.

## 2. Set up the node

In Termux:

```bash
curl -fsSLo setup.sh https://raw.githubusercontent.com/seraphicidal/sera-toolkit/main/deploy/node-android/setup.sh
bash setup.sh
```

It installs Node (the LTS, 22 or later), Python, FFmpeg and git; clones the repository into `~/sera-toolkit`;
installs only what the node needs (about 140 MB, not the web app); builds the node; fetches
the yt-dlp pinned on `main` (checked against yt-dlp's published checksums); writes
`~/sera-toolkit/.env.node.local`; and installs the boot script. Running it again later
updates everything in place.

yt-dlp's Linux builds are linked against glibc, which Android does not have, so on Android
`tools:fetch` installs yt-dlp's platform-independent zipapp (`.tools/yt-dlp.pyz`) and a
small launcher for Termux's Python in its place. FFmpeg comes from Termux's own packages.

## 3. Give it the token

The setup leaves one line for you: the token the server and the laptop already share.

```bash
nano ~/sera-toolkit/.env.node.local
```

Paste it after `SERA_EXTRACTION_NODE_TOKEN=` — copy it from the laptop's
`.env.node.local`. The rest is filled in:

```bash
SERA_API_URL=https://130-61-188-184.sslip.io
SERA_NODE_ID=phone
SERA_NODE_PROVIDERS=youtube
SERA_NODE_NETWORK_CLASS=residential
```

`SERA_NODE_ID=phone` matters: nodes that share an ID are counted as one, so the phone needs
its own to add capacity next to `laptop`.

## 4. Start it, and check

```bash
~/sera-toolkit/deploy/node-android/run-node.sh &
```

From now on Termux:Boot starts it whenever the phone boots. Within a minute
`https://130-61-188-184.sslip.io/health` should list both nodes:

```
"extraction-nodes" … "laptop [residential] (youtube), phone [residential] (youtube)"
```

## Keeping it running

`run-node.sh` is a small supervisor. Every 30 seconds it:

- runs the node, and starts it again 15 seconds after it exits for any reason;
- holds a **Termux wake lock**, so Android does not suspend it with the screen off (Termux
  shows a notification while it is held);
- applies the conditions in `~/.sera-node/node.conf`, stopping the node when they stop
  holding and starting it again when they hold;
- refreshes yt-dlp to the version pinned on `main`, at start and every 24 hours.

Only one supervisor runs at a time, so starting it by hand while the boot script has already
started it does nothing.

### Wi-Fi only, charging only

```bash
nano ~/.sera-node/node.conf
```

```bash
ONLY_ON_WIFI=1          # the default: never spend mobile data on downloads
ONLY_WHILE_CHARGING=0   # 1: only while plugged in
```

Both are read through Termux:API. A condition that cannot be checked — the app missing, or
no location permission for Wi-Fi state — counts as **not met**, so "Wi-Fi only" never quietly
becomes "mobile data too". Restart the supervisor after changing them (below).

A node stopped mid-job is safe: the server notices within 45 seconds that it went quiet and
gives the job to the laptop instead.

### Updates

- **yt-dlp** updates itself daily, to whatever the deployment runs. To pause that:
  `touch ~/.sera-node/ytdlp-updates.paused` (delete the file to resume).
- **The node itself** is updated by running `bash setup.sh` again, then restarting it.

### Logs, restarting, stopping

```bash
tail -f ~/.sera-node/supervisor.log    # started, paused, resumed, restarted
tail -f ~/.sera-node/node.log          # the node's own log
cat ~/.sera-node/ytdlp-update.log      # the last refreshes

kill $(cat ~/.sera-node/supervisor.pid)          # stop (the node stops with it)
~/sera-toolkit/deploy/node-android/run-node.sh & # start again
rm ~/.termux/boot/sera-node                      # no longer start at boot
```

## Troubleshooting

| Symptom                                    | Likely cause                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `phone` missing from `/health`             | `supervisor.log` says why: no token, or `paused: not on Wi-Fi` / `not charging`.                             |
| Always "paused: not on Wi-Fi" on Wi-Fi     | Termux:API is missing, or has no location permission. `termux-wifi-connectioninfo` should print `COMPLETED`. |
| The node stops when the screen goes off    | Battery optimisation is still on for Termux, or the phantom-process limit (step 1.4) killed it.              |
| Nothing starts after a reboot              | Termux:Boot was never opened, or was installed from a different source than Termux.                          |
| `could not reach the SERA API` in node.log | No connection, or the server is restarting. The node backs off and retries on its own.                       |
