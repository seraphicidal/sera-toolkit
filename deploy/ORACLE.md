# Deploying SERA.toolkit on Oracle Cloud (always free)

Oracle's Always Free tier includes an **Ampere A1** allowance — 4 ARM cores and 24 GB of
RAM, split across up to four instances — that runs indefinitely at no cost. Unlike a
trial it does not expire. It is more than enough for SERA.

The work splits in two. Part 1 needs a person, because it involves an account, identity
verification and a console. Part 2 is one command.

---

## Part 1 — the console

### 1. The account

<https://signup.cloud.oracle.com>

A credit card is required **for identity verification**. Always Free resources are not
billed against it.

Two things worth understanding before you start, because they cause most of the confusion
later:

- A new account begins as a **30-day trial with $300 of credits**. When the trial ends,
  anything marked _Always Free eligible_ keeps running; everything else is stopped. So
  the label on the shape matters more than anything else in this guide.
- **Home region cannot be changed.** Pick one near you, but be aware that free ARM
  capacity varies a lot by region — see the capacity note below.

### 2. Create the instance

**Menu (☰) → Compute → Instances → Create instance**

Work through it field by field:

| Field           | Value                                                 | Why                                                                                                                                                        |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**        | `sera`                                                | Cosmetic.                                                                                                                                                  |
| **Compartment** | leave as the default (root)                           | Nothing here needs a compartment.                                                                                                                          |
| **Placement**   | leave the suggested availability domain               | You may have to change this if capacity fails — see below.                                                                                                 |
| **Image**       | **Ubuntu 22.04** or **24.04**                         | Click _Change image_ — the default is Oracle Linux. Both work, but Ubuntu is the tested path; on Oracle Linux your SSH user is `opc` rather than `ubuntu`. |
| **Shape**       | _Change shape_ → **Ampere** → **VM.Standard.A1.Flex** | This is the free ARM shape.                                                                                                                                |
| **OCPUs**       | `2`                                                   | The allowance is 4; 2 leaves headroom for a second instance later.                                                                                         |
| **Memory**      | `12` GB                                               | Scales with OCPUs by default.                                                                                                                              |

> **Check for the green "Always Free eligible" label** next to the shape and the boot
> volume before continuing. If it is absent, you are provisioning something billable. The
> AMD `VM.Standard.E2.1.Micro` shape is also free but has 1 GB of RAM — far too little for
> FFmpeg. Use Ampere.

**Networking** — the wizard creates a VCN and subnet for you. Leave the defaults, but
confirm:

- **Assign a public IPv4 address: yes.** Without it the instance has no route in — no SSH
  and no website.

> The wizard-created VCN is worth using rather than letting the instance form create one
> inline. An inline subnet does not come out public, so the public-IP option stays greyed
> out, and even when it can be forced the subnet has no Internet Gateway. Create the VCN
> first (Networking → Virtual Cloud Networks → **Start VCN Wizard** → _Create VCN with
> Internet Connectivity_), then choose **Select existing** for both the network and the
> subnet here. On the review page the Networking section should name the subnet you
> picked (`Public Subnet-<your-vcn>`) and read **Public IPv4 address: Yes**. If it says
> **Create new virtual cloud network**, the selection did not take.

**Add SSH keys** — choose _Paste public keys_ and paste exactly this:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHVO2vHhHJ21UF3lOMEDO/wSRpbGK4Y6mTvOZjriBSFG sera-toolkit-oracle
```

The matching private key is at `~/.ssh/id_ed25519` on your machine and never leaves it.

**Boot volume** — leave the default (about 50 GB). The free allowance is 200 GB of block
storage in total, and boot volumes count against it.

Click **Create**. The instance reaches _Running_ in a minute or two.

### 3. If you get "Out of host capacity"

This is the single most common obstacle, and it is not something you did wrong — the free
ARM shape is in genuine demand and regions run dry.

In rough order of effort:

1. **Change the availability domain** in _Placement_ and retry. Regions with AD-1, AD-2,
   AD-3 often differ.
2. **Retry later.** Capacity is released continuously; off-peak hours for your region
   tend to be better.
3. **Ask for less.** 1 OCPU / 6 GB sometimes succeeds where 2 / 12 fails, and SERA still
   runs on it — just with one worker instead of two.
4. **Upgrade to Pay As You Go.** This materially improves A1 availability, and Always
   Free resources remain free on a PAYG account. It does mean a billable account, so only
   do this if you are comfortable watching the usage.

### 4. Open the ports

Oracle has **two** firewalls and both must allow traffic. The provisioning script handles
the one inside the instance. This one is yours:

**Menu → Networking → Virtual Cloud Networks → your VCN → Subnets → the subnet →
Security Lists → Default Security List → Add Ingress Rules**

Add two rules:

| Stateless | Source CIDR | IP Protocol | Destination Port Range |
| --------- | ----------- | ----------- | ---------------------- |
| unchecked | `0.0.0.0/0` | TCP         | `80`                   |
| unchecked | `0.0.0.0/0` | TCP         | `443`                  |

Leave the existing SSH rule (port 22) alone.

> If your VCN uses **Network Security Groups** instead of a security list, add the same
> two rules there. The wizard-created VCN uses a security list.

### 5. Confirm you can reach it

From the instance page, copy the **Public IP address**. Then, on your machine:

```bash
ssh ubuntu@<public-ip>
```

The username is `ubuntu` for Ubuntu images and `opc` for Oracle Linux. Accept the host
fingerprint on first connect. If it hangs, the SSH ingress rule or the public IP is
missing; if it says _permission denied_, the pasted key did not match.

Type `exit` once you are in — that is all this step needed to prove.

---

## Part 2 — the deployment

```bash
ssh ubuntu@<public-ip>
curl -fsSL https://raw.githubusercontent.com/seraphicidal/sera-toolkit/main/deploy/provision.sh | sudo bash
```

That script:

1. installs Docker from Docker's own repository (the distro package lags),
2. opens 80 and 443 in the instance's iptables and persists the rules,
3. clones the repository to `/opt/sera`,
4. generates a signing secret and writes `/opt/sera/.env` with `chmod 600`,
5. derives a hostname from the public IP,
6. pulls the prebuilt **arm64** images and starts the stack,
7. waits for the API to report healthy.

It is safe to re-run: every step checks before acting.

### The address you get

With no domain, the script uses [sslip.io](https://sslip.io), a public DNS service that
resolves `1-2-3-4.sslip.io` to `1.2.3.4` for anyone, with no account and no registration.
Let's Encrypt will issue for that name, so:

```
https://<your-ip-with-dashes>.sslip.io
```

is a real certificate on a real hostname — no browser warning.

To use your own domain instead, point an `A` record at the instance, then set
`SERA_DOMAIN` in `/opt/sera/.env` and re-run `sudo sera up -d`.

---

## What will not work from here

Oracle's addresses are cloud addresses, and some platforms treat those differently from a
home connection. In practice, on this instance:

| Source                                        | Result                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| Direct file links, SoundCloud, most providers | Work normally                                                   |
| YouTube                                       | `LOGIN_REQUIRED` — "Sign in to confirm you're not a bot"        |
| Vimeo                                         | `LOGIN_REQUIRED` — its web client now needs an account anywhere |

The YouTube one is specific to the address, not to the deployment: the same link, the same
yt-dlp version and the same code resolve fine from a residential connection. Nothing in
the configuration changes it, and SERA deliberately ships no way around it — see
[Where you host it changes what works](../README.md#where-you-host-it-changes-what-works).

---

## Afterwards

Provisioning installs `sera`, a wrapper around `docker compose` that points at this
deployment's compose file, project directory and `.env`. It works from any directory:

```bash
sudo sera ps                 # what is running
sudo sera logs -f worker     # follow a download
sudo sera logs caddy         # certificate problems live here
sudo sera pull && sudo sera up -d   # update to the latest images
```

Everything is `restart: unless-stopped` and Docker starts at boot, so the stack survives
reboots and crashes without intervention.

### Troubleshooting

| Symptom                              | Cause                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Site never answers, SSH works        | The **security list** ingress rules are missing. This is by far the most common.                        |
| Browser certificate warning          | Caddy has not finished issuing. Give it a minute, then check `sudo sera logs caddy`.                    |
| `no such host` for the sslip.io name | The IP in the hostname is wrong — check `/opt/sera/.env`.                                               |
| Downloads fail immediately           | `sudo sera logs worker`. If the extractor is at fault, `npm run update-providers` upstream and re-pull. |

### Staying inside the free tier

The limit that matters here is **10 TB of outbound transfer per month** — generous, but
every download a visitor makes counts against it. The defaults cap file size at 2 GB and
delete media after 30 minutes.

If you share the URL widely, lower these in `/opt/sera/.env` rather than discovering the
ceiling from a bill:

```bash
SERA_MAX_FILESIZE_BYTES=524288000        # 500 MB
SERA_MAX_CONCURRENT_JOBS_PER_CLIENT=1
SERA_RATE_LIMIT_JOBS_PER_MINUTE=4
```

Then `sudo sera up -d` to apply.
