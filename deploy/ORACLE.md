# Deploying SERA.toolkit on Oracle Cloud (always free)

Oracle's Always Free tier includes an Ampere A1 instance — up to 4 ARM cores and 24 GB of
RAM — that runs indefinitely at no cost. That is far more than SERA needs, and unlike a
trial it does not expire.

There are two parts. The first needs a person, because it involves creating an account and
verifying identity. The second is one command.

---

## Part 1 — what only you can do

### Create the account

<https://signup.cloud.oracle.com>

A credit card is required **for identity verification**. Always Free resources are not
billed against it, and a new account starts in a 30-day trial that drops to Always Free
when it ends — the instance keeps running. To be certain you are never charged, leave
"Upgrade to Paid" alone.

Pick a **home region** close to you. It cannot be changed later, and free ARM capacity
varies by region.

### Create the instance

**Compute → Instances → Create instance**

| Field   | Value                            |
| ------- | -------------------------------- |
| Image   | **Ubuntu 22.04** (or 24.04)      |
| Shape   | **Ampere → VM.Standard.A1.Flex** |
| OCPUs   | 2 (4 is also free; 2 is plenty)  |
| Memory  | 12 GB                            |
| SSH key | **Paste the public key below**   |

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHVO2vHhHJ21UF3lOMEDO/wSRpbGK4Y6mTvOZjriBSFG sera-toolkit-oracle
```

> That key was generated on your machine; the private half is at `~/.ssh/id_ed25519` and
> never leaves it.

If you get **"Out of host capacity"**, that region has no free ARM available at that
moment. It is common. Retry later, or try a different availability domain — the shape is
in genuine demand.

### Open the network

Oracle's firewall is separate from the instance's own, and both must allow traffic. The
provisioning script handles the instance side; this side is yours:

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security
List → Add Ingress Rules**

| Source CIDR | Protocol | Destination port |
| ----------- | -------- | ---------------- |
| `0.0.0.0/0` | TCP      | `80`             |
| `0.0.0.0/0` | TCP      | `443`            |

Leave the existing SSH rule alone.

### Send me the address

Copy the instance's **public IP** from the console. That is all I need.

---

## Part 2 — the deployment

```bash
ssh ubuntu@<public-ip>
curl -fsSL https://raw.githubusercontent.com/seraphicidal/sera-toolkit/main/deploy/provision.sh | sudo bash
```

That installs Docker, opens the instance firewall, pulls the prebuilt arm64 images,
generates a signing secret, and starts the stack behind Caddy with a real Let's Encrypt
certificate.

### The address you get

Without a domain, the script derives one from the instance IP using
[sslip.io](https://sslip.io), which resolves `1-2-3-4.sslip.io` to `1.2.3.4` for anyone,
with no account:

```
https://<your-ip-with-dashes>.sslip.io
```

That is a genuine certificate on a genuine hostname — not a self-signed warning.

To use your own domain instead, point an A record at the instance and set `SERA_DOMAIN`
in `/opt/sera/.env` before starting.

---

## Afterwards

```bash
cd /opt/sera
docker compose -f deploy/docker-compose.oracle.yml ps
docker compose -f deploy/docker-compose.oracle.yml logs -f worker

# update to the latest published images
docker compose -f deploy/docker-compose.oracle.yml pull
docker compose -f deploy/docker-compose.oracle.yml up -d
```

The stack restarts itself on reboot and after a crash: every service is
`restart: unless-stopped`, and Docker starts at boot.

### Staying inside the free tier

The Always Free allowance that matters here is **10 TB of outbound transfer per month**,
which is generous but not unlimited — every download a visitor makes counts against it.
The defaults in `.env` cap file size at 2 GB and retention at 30 minutes. If you publish
the URL widely, lower `SERA_MAX_FILESIZE_BYTES` and
`SERA_MAX_CONCURRENT_JOBS_PER_CLIENT` rather than discovering the ceiling from a bill.

Block storage is capped at 200 GB free; SERA uses a fraction of that and deletes media on
a timer, so the practical limit is transfer, not disk.
