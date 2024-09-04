# Ocean Nodes

Ocean Nodes run everything you need in the Ocean stack, they replace three previous components: [Provider](https://github.com/oceanprotocol/provider), [Aquarius](https://github.com/oceanprotocol/aquarius) and [subgraph](https://github.com/oceanprotocol/ocean-subgraph).

This is a minimal guide to quickly start and run an Ocean Node. See the [docs](/docs/) directory for more detailed information on Ocean Nodes and how to customise your setup.

**Note: this repository is currently excluded from all bug bounty programs.**

## System requirements

We recommend the following minimum requirements, although you may be be able to run a node with less (depending on your configuration).

- 1vcpu
- 2 GB ram
- 4 GB storage
- OS: we recommend using the latest LTS version of Ubuntu or the latest macOS. However, the nodes should also work on other operating systems including Windows.

## Option 1: Running Ocean Nodes in Docker (recommended)

[This readme](docs/dockerDeployment.md) is the recommended way to host a node and be eligible for incentives.
The other options are more recommended towards developers that want to tinker.

## Option 2: Running local build of Ocean Nodes in Docker

Run the following script to deploy node:

```bash
scripts/ocean-node-quickstart.sh
# OR
npm run quickstart
```

This command will run you through the process of setting up the environmental variables for your node.

## Option 3: Running Ocean Nodes with PM2

PM2 is a process manager that makes it easy to manage and monitor your Node.js applications.

1. Install PM2

```bash
 npm install -g pm2
```

2. Setup the environmental variables

Either use the script:

```
npm run envSetup
```

or setup the required environment variables manually:

```bash
export PRIVATE_KEY="0x_your_private_key_here"
```

The `PRIVATE_KEY` is the only mandatory environmental variable, you must include the `0x` at the front of your private key. Additional configurations can be set as needed. For all available configurations, refer to the [Environment Variables](docs/env.md) documentation.

3.  Quick start the Ocean Node with PM2

```bash
   pm2 start npm --name "ocean-node" -- run start
```

4.  Monitor and Manage the Node

You can use the following PM2 commands to manage your Ocean Node:

```bash
pm2 list # View running processes
pm2 logs ocean-node # View logs
pm2 restart ocean-node # Restart the node
pm2 stop ocean-node # Stop the node
pm2 delete ocean-node # Delete the process
```

## Option 3: Running Ocean Nodes With NPM

### Prerequisites

- **Node Version:** Install the node version specified in `.nvmrc`.
- **Docker**
- **Docker compose**
- **nvm** (recommended but not necessary)

### 1. Start the Typesense database

```bash
docker-compose -f typesense-compose.yml up -d
```

### 2. Install dependencies & build the project

```bash
nvm use # Use the correct Node.js version
npm install # Install dependencies
npm run build # Build the Project
```

### 3. Configure Environment Variables

#### Option 1: Automatic Setup (Recommended)

Run the helper script to generate and set up the minimum required environment variables:

```bash
./src/helpers/scripts/setupNodeEnv.sh
source .env
```

#### Option 2: Manual Setup

Manually set the required environment variables:

```bash
export PRIVATE_KEY="0x_your_private_key_here"
```

The `PRIVATE_KEY` is the only mandatory environmental variable, you must include the `0x` at the front of your private key. Additional configurations can be set as needed. For all available configurations, refer to the [Environment Variables](docs/env.md) documentation.

### 4. Start the Node

```bash
npm run start
```

Your node is now running, the dashboard will be available at `http://localhost:8000/dashboard/`. To start additional nodes, repeat these steps in a new terminal.

## Additional Resources

- [Ocean Nodes Architecture](docs/Arhitecture.md)
- [API Endpoints](docs/API.md)
- [Environmental Variables](docs/env.md)
- [Testing Guide](docs/testing.md)
- [Network Configuration](docs/networking.md)
- [Logging & accessing logs](docs/networking.md)
- [Dashboard: Local development](dashboard/README.md)
- [Docker Deployment Guide](docs/dockerDeployment.md)
