# Environment Variables

**Warning**: the names of some of these environment variables might change at some point in the future.

This page lists the environment variables used by `ocean-node` and what effect
they have.

## Core

- `PRIVATE_KEY` : Private key used by this node (applies to p2p peer id, asset encryption key, etc)
- `RPCS` : List of RPC URL for each chain. Example:

```bash
export RPC="{ \"1\": \"https://rpc.eth.gateway.fm\", \"137\": \"https://polygon.meowrpc.com\", \"80001\": \"https://rpc-mumbai.maticvigil.com\" }"
```

## P2P

- `P2P_ENABLE_IPV4` : Enable IPv4 conectivity. Defaults: True
- `P2P_ENABLE_IPV6` : Enable IPv6 conectivity. Defaults: True
- `P2P_ipV4BindAddress` : Bind address for IPV4. Defaults to `0.0.0.0`
- `P2P_ipV4BindTcpPort` : Port used on IPv4 TCP connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly)
- `P2P_ipV4BindWsPort` : Port used on IPv4 WS connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly)
- `P2P_ipV6BindAddress` : Bind address for IPV6. Defaults to `::1`
- `P2P_ipV6BindTcpPort` : Port used on IPv6 TCP connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly)
- `P2P_ipV6BindWsPort` : Port used on IPv6 WS connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly)
- `P2P_ANNOUNCE_ADDRESSES` : List of addresses to announce to the network. Example: ["/ip4/1.2.3.4/tcp/8000"]
- `P2P_ANNOUNCE_PRIVATE`: Announce private IPs. Default: True
- `P2P_FILTER_ANNOUNCED_ADDRESSES`: CIDR filters to filter announced addresses. Default: []. Example: ["192.168.0.1/27"]
- `P2P_pubsubPeerDiscoveryInterval` : Interval (in ms) for discovery using pubsub. Defaults to `1000` (one second)
- `P2P_dhtMaxInboundStreams` : Maximum no of DHT inbound streams. Defaults to `500`
- `P2P_dhtMaxOutboundStreams` : Maximum no of DHT outbound streams. Defaults to `500`
- `P2P_mDNSInterval` : Interval (in ms) for discovery using mDNS. Defaults to `20000` (20 seconds)
- `P2P_connectionsMaxParallelDials` : Maximum no of parallel dials. Defaults to `150`
- `P2P_connectionsDialTimeout`: Timeout for dial commands. Defaults to `10000` (10 seconds)
- `P2P_ENABLE_UPNP`: Enable UPNP gateway discovery. Default: True
- `P2P_ENABLE_AUTONAT`: Enable AutoNAT discovery. Default: True
- `P2P_ENABLE_CIRCUIT_RELAY_SERVER`: Enable Circuit Relay Server. It will help network, but increase your bandwith usage. Should be disabled for edge nodes. Default: True
- `P2P_ENABLE_CIRCUIT_RELAY_CLIENT`: Enable conections through relay servers. Default: True

## HTTP

- `HTTP_API_PORT` : Port used for HTTP interface. Defaults to `8000`
