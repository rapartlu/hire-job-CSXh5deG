# Deliveroo Traffic Capture

A local Docker app that intercepts Deliveroo API traffic so you can see the raw requests and responses your browser sends to `api.deliveroo.com`.

Run it on your machine, browse Deliveroo normally, then export the captured traffic to CSV.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac or Windows) or Docker + Docker Compose (Linux)
- A browser (Chrome or Firefox recommended)

No accounts, no API keys, no cloud setup.

---

## Quick start

```bash
git clone https://github.com/rapartlu/hire-job-CSXh5deG.git
cd hire-job-CSXh5deG
docker compose up
```

Dashboard: **http://localhost:3000**  
Proxy: **localhost:8080**

---

## One-time setup: install the CA cert

The proxy decrypts HTTPS traffic. Your browser needs to trust its certificate to avoid security warnings.

**1. Download the cert**

Visit http://localhost:3000 and click **Download CA cert** in the top-right corner.  
Or go direct: http://localhost:3000/cert.pem

(The cert is generated when the proxy first starts. If you get a 404, wait a few seconds and try again.)

**2. Install in Chrome**

1. Open `chrome://settings/security`
2. Click **Manage certificates** then open the **Authorities** tab
3. Click **Import**, select the downloaded `.pem` file
4. Tick **Trust this certificate for identifying websites**
5. OK

**3. Install in Firefox**

1. Preferences > Privacy & Security
2. Scroll to **Certificates** > click **View Certificates**
3. Open the **Authorities** tab > click **Import**
4. Select the `.pem` file, tick **Trust this CA to identify websites**
5. OK

---

## Configure browser proxy

Tell your **browser** to route traffic through the proxy at `127.0.0.1:8080`.

> **macOS / Windows warning:** do NOT set a system-wide proxy. Setting the system
> proxy routes Docker's own outbound traffic through localhost:8080 as well,
> which creates a loop - the proxy tries to forward connections through itself
> and everything fails with "Connect call failed" errors. Configure the proxy in
> your browser only, not in System Preferences / Windows Settings.

**Chrome**

Option A - command line (recommended, no extensions needed):

macOS:
```
open -a "Google Chrome" --args --proxy-server="http://127.0.0.1:8080"
```

Linux:
```
google-chrome --proxy-server="http://127.0.0.1:8080"
```

Option B - extension: install [Proxy SwitchyOmega](https://chrome.google.com/webstore/detail/proxy-switchyomega/padekgcemlokbadohgkifijomclgjgif), create a profile with HTTP proxy `127.0.0.1:8080`, and switch to it when capturing.

**Firefox**

Firefox has its own proxy settings separate from the system:

Settings > General > Network Settings > Manual proxy configuration:
- HTTP Proxy: `127.0.0.1` Port: `8080`
- Also use this proxy for HTTPS: checked

---

## Capture traffic

With both the proxy and browser configured:

1. Open https://deliveroo.co.uk
2. Search for restaurants or dishes as you normally would
3. Watch requests appear in the Live feed tab at http://localhost:3000

The addon only records requests to `api.deliveroo.com` and `consumer-api.deliveroo.com`. Other sites pass through unrecorded.

---

## Export for analysis

Once you have captured some traffic:

1. Go to http://localhost:3000
2. Click the **Export** tab
3. Click **Download captures.csv**
4. Attach the CSV to the GitHub issue

The fleet uses the exported data to build the filtering and analysis rules for Milestone 2.

---

## Privacy

Session cookies and auth tokens pass through the proxy and are stored in a SQLite file at `/data/captures.db` inside the Docker volume. Nothing is sent anywhere outside your machine. The proxy writes to local storage only.

To see the raw SQLite file:
```bash
docker compose exec dashboard ls /data/
```

---

## Stop and reset

Stop containers:
```bash
docker compose down
```

Stop and wipe all captured data:
```bash
docker compose down -v
```

---

## Troubleshooting

**"Connect call failed" errors in proxy logs**

All connections from the proxy container are failing. This means Docker Desktop picked up a system proxy setting that points back to the proxy itself (a loop).

Fix:
1. Remove any proxy setting from Mac System Preferences / Windows Settings.
2. Run `docker compose down && docker compose up --build` to restart clean.
3. Set the proxy in your browser only (Firefox instructions above).

**"Cert not yet available"**

The proxy is still starting up. Wait 10-15 seconds and reload http://localhost:3000/cert.pem.

**Already running an older version?**

If you cloned before 2026-06-08, pull the latest and rebuild:
```bash
docker compose down
git pull
docker compose up --build
```

The latest build fixes cert delivery and Docker proxy loop protection.

---

Built by Fleet - Alpha access
