# Ocean Node Networking

## Networking in cloud environments or DMZ

In order for your node to join the network, the others nodes needs to be able to connect to it.
All options can be controlled using [environment
variables](env.md#p2p)

To quickly start your node, you can keep all of the default values,but most likely it will hurt performance. If you want a customised approach, here are the full steps:

- decide what IP version to use (IPV4 or/and IPv6). You should use both if available.
- decide if you want to filter private ips (if you run multiple nodes in a LAN or cloud environment, leave them on)
- if you already have an external ip configured on your machine, you are good to go.
- if you have a private ip, but an UPNP gateway, you should be fine as well.
- if you have a private ip and you can forward external ports from your gateway, use P2P_ANNOUNCE_ADDRESSES and let other nodes know your external IP/port.
- if you cannot forward ports on your gateway, the only choice is to use a circuit relay server (then all traffic will go through that node and it will proxy)

## TLS and SNI (Server Name Indication)

AutoTLS is used to provision TLS certificates for your node in order to allow P2P node-to-browser communication.
To enable SNI with Ocean Node's autoTLS feature, include `/tls/ws` or `/tls/wss` addresses in `P2P_ANNOUNCE_ADDRESSES`:

Add to .env file

```bash
export P2P_ANNOUNCE_ADDRESSES='[
  "/ip4/<your-ip-addr>/tcp/9000",
  "/ip4/<your-ip-addr>/tcp/9001/tls/ws",
  "/ip4/<your-ip-addr>/tcp/9005/tls/wss",
]'
```

Or in config.json file:

```json
{
  "p2pConfig": {
    "announceAddresses": [
      "/ip4/<your-ip-addr>/tcp/9000",
      "/ip4/<your-ip-addr>/tcp/9001/tls/ws",
      "/ip4/<your-ip-addr>/tcp/9005/tls/wss"
    ]
  }
}
```

When TLS certificates are provisioned, you should see logs like:

```
----- A TLS certificate was provisioned -----
----- TLS addresses: -----
/ip4/<your-ip-addr>/tcp/9001/sni/...
/ip4/<your-ip-addr>/tcp/9005/sni/...
----- End of TLS addresses -----
```

In order to check connectivity, you can do the following:

### On your node, check and observe how your node sees itself:

```bash
curl http://localhost:8000/getP2pPeer?peerId=16Uiu2HAkwWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx
```

and observe the addresses section:

```json
{
  "addresses": [
    { "multiaddr": "/ip4/127.0.0.1/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/127.0.0.1/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip4/172.15.0.1/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/172.15.0.1/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip4/172.26.53.25/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/172.26.53.25/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip6/::1/tcp/41157", "isCertified": false }
  ],
  "protocols": [
    "/floodsub/1.0.0",
    "/ipfs/id/1.0.0",
    "/ipfs/id/push/1.0.0",
    "/ipfs/ping/1.0.0",
    "/libp2p/autonat/1.0.0",
    "/libp2p/circuit/relay/0.2.0/hop",
    "/libp2p/circuit/relay/0.2.0/stop",
    "/libp2p/dcutr",
    "/meshsub/1.0.0",
    "/meshsub/1.1.0",
    "/ocean/nodes/1.0.0",
    "/ocean/nodes/1.0.0/kad/1.0.0",
    "/ocean/nodes/1.0.0/lan/kad/1.0.0"
  ],
  "metadata": {},
  "tags": {},
  "id": "16Uiu2HAkwWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx",
  "publicKey": "08021221021efd24150c233d689ade0f9f467aa6a5a2969a5f52d70c85caac8681925093e3"
}
```

Are any of those IPs reachable from other nodes?

### To observe how your node is seen by others, start your node, wait a bit and then ask another node to give you details about you:

```bash
 curl http://node2.oceanprotocol.com:8000/getP2pPeer?peerId=16Uiu2HAk
wWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx
```
