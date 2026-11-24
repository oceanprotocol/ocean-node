# Ocean Node Networking

For other nodes (and browsers) to reach your node, it must be reachable at a stable, publicly routable address. Work through the options below in order — stop at the first one that applies to your setup.

## Option 1: Static Public IP

If your machine has a static public IP directly assigned to it (common in VPS/cloud environments), set `P2P_ANNOUNCE_ADDRESSES` to announce that address. The quickstart script does this automatically when you provide your IP or domain name.

Example for a node with public IP `1.2.3.4`, using ports 9000 (TCP) and 9001 (WebSocket/TLS):

```bash
P2P_ANNOUNCE_ADDRESSES='[
  "/ip4/1.2.3.4/tcp/9000",
  "/ip4/1.2.3.4/tcp/9001/ws",
  "/ip4/1.2.3.4/tcp/9001/tls/ws"
]'
```

The `/tls/ws` entry enables [AutoTLS](#tls-and-sni-server-name-indication) for node-to-browser communication. AutoTLS provisions a certificate and serves TLS at the transport layer on the WebSocket port, making it browser-compatible — no DNS setup required on your part.

## Option 2: Dynamic DNS (no static IP)

If your public IP changes (residential ISP, dynamic VPS), use a Dynamic DNS (DDNS) service to get a stable hostname that always resolves to your current IP.

Popular free DDNS providers: [DuckDNS](https://www.duckdns.org/), [No-IP](https://www.noip.com/), [Dynu](https://www.dynu.com/).

Once you have a hostname (e.g. `mynode.duckdns.org`), set up the DDNS client on your machine to keep it updated, then use the hostname in your announce addresses:

```bash
P2P_ANNOUNCE_ADDRESSES='[
  "/dns4/mynode.duckdns.org/tcp/9000",
  "/dns4/mynode.duckdns.org/tcp/9001/ws",
  "/dns4/mynode.duckdns.org/tcp/9001/tls/ws"
]'
```

## Option 3: Port Forwarding

If you are behind a NAT router (home network), you need to forward the P2P ports from your router to the machine running the node.

1. Find the local IP of your machine (e.g. `192.168.1.50`).
2. Log in to your router admin panel and add port forwarding rules:
   - External TCP port `9000` → `192.168.1.50:9000`
   - External TCP port `9001` → `192.168.1.50:9001`
3. Find your public IP (e.g. via `curl ifconfig.me`) or set up a DDNS hostname (see Option 2).
4. Set `P2P_ANNOUNCE_ADDRESSES` to your public IP or DDNS hostname as shown above.

If your router supports UPnP, the node can attempt to configure port forwarding automatically. Enable it with:

```bash
P2P_ENABLE_UPNP=true
```

UPnP is not reliable on all routers and should not be relied on as the sole method.

## Option 4: Circuit Relay (fallback)

If none of the above options are available (strict NAT, no port forwarding, no public IP), use a circuit relay. A relay node proxies traffic between peers, allowing your node to participate in the network without being directly reachable.

Enable the circuit relay client:

```bash
P2P_ENABLE_CIRCUIT_RELAY_CLIENT=true
P2P_CIRCUIT_RELAYS=1
```

Note: circuit relay increases latency and bandwidth usage on the relay node. It should be a last resort — a node running only via relay is a burden on the network and will have degraded performance.

Do not enable `P2P_ENABLE_CIRCUIT_RELAY_SERVER` on edge nodes; that setting is for well-connected nodes that want to help others.

---

## TLS and SNI (Server Name Indication)

AutoTLS provisions TLS certificates for your node automatically, enabling P2P node-to-browser communication. It is always active internally — no DNS or certificate setup required on your part. For it to work, you must include a `/tls/ws` entry in `P2P_ANNOUNCE_ADDRESSES`, which the quickstart script does automatically.

AutoTLS serves TLS at the transport layer on the WebSocket port, making it standard browser-compatible WSS — no separate port is needed.

Example `.env` / docker-compose entry:

```bash
P2P_ANNOUNCE_ADDRESSES='[
  "/ip4/<your-ip>/tcp/9000",
  "/ip4/<your-ip>/tcp/9001/ws",
  "/ip4/<your-ip>/tcp/9001/tls/ws"
]'
```

Or in `config.json`:

```json
{
  "p2pConfig": {
    "announceAddresses": [
      "/ip4/<your-ip>/tcp/9000",
      "/ip4/<your-ip>/tcp/9001/ws",
      "/ip4/<your-ip>/tcp/9001/tls/ws"
    ]
  }
}
```

When a TLS certificate is provisioned successfully, you will see logs like:

```
----- A TLS certificate was provisioned -----
----- TLS addresses: -----
/ip4/<your-ip>/tcp/9001/sni/...
/ip4/<your-ip>/tcp/9001/sni/...
----- End of TLS addresses -----
```

## Service TLS: the Caddy proxy

Services can serve their ports over HTTPS (see [services.md](services.md#https-endpoints-securetls)).
TLS is done by one official [Caddy](https://caddyserver.com/) container that you run next to the
node. Caddy gets and renews a Let's Encrypt certificate for `serviceOnDemand.nodeHost` (a public
IP or a domain) on its own. The node only tells Caddy which ports to serve, through Caddy's admin
API on a unix socket.

Add Caddy to your compose file (the quickstart script does this), and share its admin socket
volume with the node:

```yaml
services:
  caddy:
    image: caddy:2.11.9-alpine
    container_name: caddy
    network_mode: host
    restart: always
    command: caddy run --config /etc/caddy/caddy.json
    configs:
      - source: caddy_json
        target: /etc/caddy/caddy.json
    volumes:
      - caddy_admin:/run/caddy
      - caddy_data:/data
  ocean-node:
    volumes:
      - caddy_admin:/run/caddy
      # ...the node's other volumes

configs:
  caddy_json: # inline config needs Docker Compose 2.23 or later
    content: |
      {"admin":{"listen":"unix//run/caddy/admin.sock|0222","config":{"persist":false}},
       "apps":{"tls":{"automation":{"policies":[{"issuers":[{"module":"acme","profile":"shortlived"}]}]}},
               "http":{"servers":{}}}}

volumes:
  caddy_admin:
  caddy_data:
```

- `admin.listen`: the admin API is on a unix socket in the `caddy_admin` volume. The node runs as
  uid 1000, so the socket is writable for all (`|0222`). Only root and the containers that mount
  the volume can reach it.
- `persist: false`: Caddy keeps no autosave copy of the config. The node sends the servers again.
- `profile: shortlived`: the Let's Encrypt profile that IP certificates need.

**Port 80 must be free for Caddy.** Let's Encrypt checks the name with an HTTP request on port
80 (ACME http-01), and Caddy (host network) listens there. Also open the service
`hostPortRange` (TCP), as for plain services: Caddy listens on the secure host ports.

The node's service loop sends Caddy the servers when they change, and re-sends them every minute
(so a restarted Caddy gets them back). Only the first local (`socketPath`) Docker environment does
this, with its `nodeHost`. An environment shows `features.secureTls: true` only after Caddy accepted
the node's last update. Certificate errors are in Caddy's log (`docker logs caddy`).

With `nodeHost` set to `localhost` or a private IP, service TLS is off and the node logs one line
asking you to set it.

Restart Caddy after changing `nodeHost` (`docker restart caddy`), so that no server for the old
name stays in its config.

### Nodes with Traefik on port 80

Traefik already holds port 80, so Caddy uses port 8081 for its HTTP side, and Traefik sends only
the ACME challenge path there:

- Traefik's own resolver: use `--certificatesresolvers.myresolver.acme.tlschallenge=true`
  instead of `httpchallenge` (the challenge path now goes to Caddy).
- In the `caddy_json` config, set `apps.http.http_port` to `8081`, and add
  `"challenges": { "http": { "alternate_port": 8081 } }` to the `acme` issuer. Without
  `http_port`, Caddy still binds port 80 and the node's config is refused.
- A Traefik router on the `web` entry point, above the http-to-https redirect. With the dynamic
  file provider:

```yaml
http:
  routers:
    caddy-acme:
      rule: 'PathPrefix(`/.well-known/acme-challenge/`)'
      entryPoints: [web]
      priority: 2147483647
      service: caddy-acme
  services:
    caddy-acme:
      loadBalancer:
        servers:
          - url: 'http://host.docker.internal:8081'
```

Give the Traefik container `extra_hosts: ["host.docker.internal:host-gateway"]` so that the name
reaches the host. A redirect set on the entry point (`entrypoints.web.http.redirections`) has priority
`2147483646` by default, so the router above wins.

## Verifying Connectivity

### Check how your node sees itself

```bash
curl http://localhost:8000/getP2pPeer?peerId=<your-peer-id>
```

Look at the `addresses` array in the response. Are any of those IPs/hostnames reachable from outside your network?

```json
{
  "addresses": [
    { "multiaddr": "/ip4/1.2.3.4/tcp/9000", "isCertified": false },
    { "multiaddr": "/ip4/1.2.3.4/tcp/9001/ws", "isCertified": false },
    { "multiaddr": "/ip4/1.2.3.4/tcp/9001/tls/ws", "isCertified": false }
  ]
}
```

### Check how your node is seen by the network

Ask a known public node to report back what it knows about you:

```bash
curl https://cp1.oncompute.ai/getP2pPeer?peerId=<your-peer-id>
```

If the response is empty or missing your public address, the node is not reachable from the outside.

## All P2P Environment Variables

See [env.md](env.md#p2p) for the full list of P2P configuration options.
