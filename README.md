# Ocean Nodes

Ocean Nodes run everything you need in the Ocean stack, they replace three previous components: [Provider](https://github.com/oceanprotocol/provider), [Aquarius](https://github.com/oceanprotocol/aquarius) and [subgraph](https://github.com/oceanprotocol/ocean-subgraph).

This is a minimal guide to quickly start and run an Ocean Node. See the [docs](/docs/) directory for more detailed information on Ocean Nodes and how to customise your setup.

**Note: this repository is currently excluded from all bug bounty programs.**

## Running Ocean Nodes in Docker (recommended)

Build and run the node using Docker:

1. **Build the Docker image:**
   `docker build -t ocean-node:mybuild .`

2. **Run the Docker container:**
   `docker run -e PRIVATE_KEY=your_private_key_here ocean-node:mybuild`

## Running Ocean Nodes Locally

### Prerequisites

- **Node Version:** Install the node version specified in `.nvmrc`.

### 1. Set Up Environment

1. **Use the correct Node.js version:**
   `nvm use`

2. **Install dependencies:**
   `npm install`

### 2. Build the Project

`npm run build`

### 3. Start Required Services

Clone and start the necessary services using Barge:

`git clone https://github.com/oceanprotocol/barge.git`

`cd barge`

`git checkout feature/nodes`

`./start_ocean.sh`

### 4. Configure Environment Variables

**Option 1: Automatic Setup (Recommended)**

Run the helper script to generate and set up the recommended environment variables:

`./helpers/scripts/setupNodeEnv.sh`

`source .env`

**Option 2: Manual Setup**

Manually set the required environment variables:

`export PRIVATE_KEY="your_private_key_here"`

The `PRIVATE_KEY` is the only mandatory environmental variable. Additional configurations can be set as needed.

For all available configurations, refer to the [Environment Variables](docs/envs.md) documentation.

### 5. Start the Node

`npm run start`

Your node is now running, the dashboard will be available at `http://localhost:8000/dashboard/`. To start additional nodes, repeat these steps in a new terminal.

## Testing

Run unit and integration tests to ensure everything is set up correctly:

- **Unit Tests:**
  `npm run test:unit`

- **Integration Tests:**
  `npm run test:integration`

For advanced testing scenarios, refer to the [Testing Guide](docs/testing.md).

## Additional Resources

- [Ocean Nodes Architecture](docs/Arhitecture.md)
- [API Endpoints](docs/API.md)
- [Environmental Variables](docs/env.md)
- [Testing Guide](docs/testing.md)
- [Network Configuration](docs/networking.md)
- [Logging & accessing logs](docs/networking.md)
- [Dashboard: Local development](dashboard/README.md)
- [Compute to Data V2](docs/C2DV2.md)
