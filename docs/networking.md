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
