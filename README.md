# Ocean Node

A minimal guide to quickly start and run an Ocean Node.

## Quick Start

### Prerequisites

- **Node Version:** Use the node version specified in `.nvmrc`.
- **Docker:** Ensure Docker is installed if you plan to run the node in a container.

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

**Option 1: Automatic Setup**

Run the helper script to generate and set up the required environment variables:

`./helpers/scripts/setupNodeEnv.sh`

`source .env`

**Option 2: Manual Setup**

Manually set the required environment variables:

`export PRIVATE_KEY="your_private_key_here"`

`export HTTP_API_PORT=8000`

Additional configurations can be set as needed.

For more advanced configurations, refer to the [Environment Variables](docs/environment-variables.md) documentation.

### 5. Start the Node

`npm run start`

Your node is now running. To start additional nodes, repeat these steps in a new terminal.

## Docker Setup

Build and run the node using Docker:

1. **Build the Docker image:**
   `docker build -t ocean-node:mybuild .`

2. **Run the Docker container:**
   `docker run -e PRIVATE_KEY=your_private_key_here ocean-node:mybuild`

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
- [COmpute to Data V2](docs/C2DV2.md)
