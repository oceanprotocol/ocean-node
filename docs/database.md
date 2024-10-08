# Ocean Node Database Configuration

Ocean Node can be run with two types of databases: Elasticsearch or Typesense, or with no database at all (using a NoSQL setup). This flexibility allows you to configure the node based on your infrastructure needs.

## Database Configuration

Depending on the database type you choose, you will need to set specific environment variables. Ocean Node supports either Elasticsearch or Typesense as the database for storing the various node components.

### 1. Set the Environment Variables

    •	For Typesense, you need to set the following environment variables:

```bash
DB_TYPE=typesense
DB_URL="http://localhost:8108/?apiKey=xyz"  # Example URL when using Barge for Typesense
```

    •	For Elasticsearch, you need to set:

```bash
DB_TYPE=elasticsearch
DB_URL="http://localhost:9200"  # Example URL when using Barge for Elasticsearch
```

Ensure that the correct DB_TYPE is specified as either typesense or elasticsearch depending on your chosen setup.

### 2. Starting Ocean Barge

To run Ocean Node with the appropriate database, you need to start Barge with specific flags.

    •	To run Ocean Node with Typesense, use the following command:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d --with-typesense --no-elasticsearch
```

    •	To run Ocean Node with Elasticsearch, use the following command:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d
```

By specifying these flags, you can configure Ocean Node to work with either Typesense or Elasticsearch databases, depending on your requirements.
