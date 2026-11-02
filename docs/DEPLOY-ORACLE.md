# Deploying FINN on Oracle Cloud (Always Free)

This guide runs FINN as one always-on server on an Oracle Cloud Always Free VM. It serves HTTPS at a public address and keeps its database on the VM's disk. It works in demo mode and in live mode, with a free Gemini key.

This guide was used for the live deployment on 3 Nov 2026 (Mumbai, 2 OCPU / 12 GB, Ubuntu 24.04, live mode). If a step fails, `journalctl -u finn -n 50` shows why.

## What you get, and the catches

From Oracle's [Always Free resources page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), checked 2 Nov 2026:

- **Ampere A1 (Arm) VM:** 2 OCPUs and 12 GB of memory in total, free. That is plenty for FINN. The 1 GB AMD "micro" VMs are too small to build the app, so don't use them.
- **Disk:** 200 GB of block storage in total (boot volumes included). **Outbound data:** 10 TB a month.
- **Idle VMs can be reclaimed.** Oracle may reclaim an Always Free VM that is idle for 7 days. Idle means CPU (95th percentile), network and memory use all stay under 20%. A demo with few visitors can look idle. Oracle's own suggestion is to upgrade the account to **Pay As You Go**: Always Free resources stay free, and you pay only for usage above the free limits.
- **Home region:** Always Free VMs must be created in your home region, chosen when you sign up. Pick one near India, such as Mumbai or Hyderabad.
- **Capacity:** if creating the VM fails with "out of host capacity", try another availability domain or try again later.

## 1. Create the VM

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) and choose your home region.
2. In the console, go to **Compute → Instances → Create instance**.
   - **Image:** Canonical **Ubuntu 24.04** (or 22.04).
   - **Shape:** **Ampere → VM.Standard.A1.Flex**, with **2 OCPUs** and **12 GB** of memory.
   - **SSH keys:** download the generated private key, or upload your own public key.
   - Keep "Assign a public IPv4 address" switched on. If the form greys it out (it does when it is also creating a new network), add the address after creation: open the instance → **Networking** → the primary VNIC → **IP administration** → the private IP's **⋯** menu → **Edit** → **Ephemeral public IP**.
3. Click **Create** and note the instance's **public IP address**. "Out of capacity" is common for free Arm VMs. Retrying later, sometimes several times, eventually succeeds.

## 2. Open ports 80 and 443 in Oracle's network

Ports 80 and 443 must be open in Oracle's network for the browser and for the HTTPS certificate. Opening them inside the VM isn't enough on its own.

1. Open the instance, then click its **subnet** and its **security list**.
2. Under **Add ingress rules**, add two rules:
   - **Source CIDR** `0.0.0.0/0`, **TCP**, **destination port** `80`.
   - The same again, for port `443`.

`setup.sh` opens the same ports in the VM's own firewall; Oracle's Ubuntu images block them by default.

## 3. Choose the address

- **No domain (simplest):** pass `auto`. FINN is then served at `https://<ip-with-dashes>.sslip.io`, for example `https://140-238-1-2.sslip.io`. sslip.io is a free DNS service that points that name at your IP, so no DNS setup is needed.
- **Your own domain:** create an **A record** pointing your hostname (for example `finn.example.com`) at the VM's public IP. Wait until it resolves, then pass that hostname.

Caddy obtains and renews the HTTPS certificate automatically in both cases.

## 4. Install FINN

Connect from your computer. On Windows, use PowerShell or Git Bash:

```bash
ssh -i path/to/private.key ubuntu@<public-ip>
```

Then run on the VM. **Demo mode** uses recorded data, needs no keys and always works:

```bash
sudo git clone https://github.com/shubhbansal2/FINN.git /opt/finn
```

```bash
sudo bash /opt/finn/deploy/oracle/setup.sh auto fixture
```

**Live mode** uses real data, plus Gemini once you add a key:

```bash
sudo bash /opt/finn/deploy/oracle/setup.sh auto live
```

The first run takes a few minutes: it installs Node.js 22, build tools and Caddy, builds the app, loads data, starts the services and opens the firewall. At the end it prints the address. It is safe to run again, for example to switch modes.

## 5. Add your Gemini key (live mode)

The key lives only on the server, in a file readable by root and the `finn` service user:

```bash
sudo nano /etc/finn/finn.env
```

Set `GEMINI_API_KEY=` to your key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), save, then restart FINN:

```bash
sudo systemctl restart finn
```

In live mode, a timer refreshes prices and filings, and reads new results and management-change filings, on weekdays at 10:00 and 17:00 IST. Research downloads filings on demand.

## Day-to-day

```bash
sudo bash /opt/finn/deploy/oracle/update.sh
```

That pulls the latest code from GitHub, rebuilds, applies any database migrations and restarts. Data and settings are kept.

```bash
journalctl -u finn -f
```

```bash
systemctl status finn caddy finn-refresh.timer
```

## What runs where

| Piece | Location |
|---|---|
| App code | `/opt/finn` (a git clone, owned by the `finn` user) |
| Database and downloaded filings | `/var/lib/finn` |
| Settings and secrets | `/etc/finn/finn.env` (mode `640`, `root:finn`) |
| App service | `finn.service`: `next start` on `127.0.0.1:3000`, restarted on failure |
| HTTPS | Caddy, reverse proxy from 443 to 3000, automatic certificates |
| Live refresh | `finn-refresh.timer` + `finn-refresh.service` |

## Troubleshooting

- **The page doesn't load at all:**
  - Check the Oracle security list (step 2).
  - Check that `sudo iptables -L INPUT -n` shows ACCEPT rules for 80 and 443 above any REJECT.
- **Certificate errors on the first visit:** Caddy needs ports 80 and 443 reachable to get a certificate. See `journalctl -u caddy -n 50`.
- **Works elsewhere, but not on one network:** some office and campus web filters (for example Fortinet) block `sslip.io` names, showing a block page or a certificate error. Use your own domain, or open the site on another network such as mobile data.
- **FINN didn't start:** see `journalctl -u finn -n 50`.
- **Research says the model is unavailable:**
  - Check the key in `/etc/finn/finn.env`.
  - Gemini's free tier is sometimes overloaded, and FINN reports that rather than failing.
