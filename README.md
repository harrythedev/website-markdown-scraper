# Fruiting Crawler

An AWS serverless pipeline that monitors [fruiting.co.kr](https://www.fruiting.co.kr) for new articles, renders each page with a headless browser, converts the content to Markdown, and stores it in S3.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AWS Cloud                                │
│                                                                 │
│  ┌──────────────┐     ┌─────────────────────┐                  │
│  │  EventBridge │────▶│ Entrypoint Lambda   │                  │
│  │  (every 1hr) │     │  (Node.js 20, zip)  │                  │
│  └──────────────┘     └────────┬────────────┘                  │
│                                │                                │
│                    1. GET /api/v1/list/all                       │
│                    (fruiting.co.kr API)                         │
│                                │                                │
│                    2. HeadObject per article                    │
│                       ┌────────▼────────┐                      │
│                       │   S3 Bucket     │                      │
│                       │  (output *.md)  │                      │
│                       └────────▲────────┘                      │
│                                │                                │
│                    3. InvokeCommand (async)                     │
│                    for each NEW article                        │
│                                │                                │
│                       ┌────────▼────────────────────┐          │
│                       │ Parser Lambda               │          │
│                       │ (Docker / x86_64)           │          │
│                       │                             │          │
│                       │  Puppeteer + Chromium       │          │
│                       │    → render page            │          │
│                       │  CSS selector / Readability │          │
│                       │    → extract content        │          │
│                       │  Pandoc                     │          │
│                       │    → HTML/text → Markdown   │          │
│                       │  S3 PutObject (*.md)        │          │
│                       └─────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### Flow summary

| Step | Component | Action |
|------|-----------|--------|
| 1 | EventBridge | Triggers Entrypoint every hour |
| 2 | Entrypoint Lambda | Fetches latest articles from Fruiting API |
| 3 | Entrypoint Lambda | Checks S3 for each article — skips if already exists |
| 4 | Entrypoint Lambda | Invokes Parser Lambda (async) for each new article |
| 5 | Parser Lambda | Renders page with Puppeteer + Chromium |
| 6 | Parser Lambda | Extracts content via CSS selector or Mozilla Readability |
| 7 | Parser Lambda | Converts to Markdown via Pandoc |
| 8 | Parser Lambda | Uploads `{article-id}.md` to S3 |

## Project structure

```
.
├── functions/
│   ├── entrypoint/          # Zip Lambda — article detection + dispatch
│   │   ├── index.js
│   │   └── package.json
│   └── parser/              # Docker Lambda — headless rendering + conversion
│       ├── app.js
│       ├── app.test.js
│       ├── Dockerfile
│       └── package.json
├── scripts/
│   └── hydrate.js           # One-off script to backfill all historical articles
├── template.yaml            # SAM infrastructure definition
├── samconfig.toml           # SAM deploy config (git-ignored — contains your account details)
├── .env.example             # Environment variable template
└── package.json             # Root dev dependencies + test scripts
```

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| AWS CLI | v2 | [docs.aws.amazon.com/cli](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) |
| AWS SAM CLI | latest | [docs.aws.amazon.com/serverless-application-model](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) |
| Docker | latest | [docker.com](https://www.docker.com/get-started) — required to build the Parser Lambda image |

## Setup from scratch

### 1. Clone the repo

```bash
git clone <repo-url>
cd poc
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in the values. The `FUNCTION_NAME` variable is only needed for the hydration script (see [Backfill historical articles](#backfill-historical-articles)) — you can fill it in after the first deploy.

### 3. Configure AWS credentials

```bash
aws configure
```

Enter your AWS Access Key ID, Secret Access Key, and default region (`us-east-1`).

### 4. Install dependencies

```bash
# Root dev dependencies (Jest, etc.)
npm install

# Entrypoint Lambda dependencies
cd functions/entrypoint && npm install && cd ../..
```

### 5. Create your SAM config

SAM deploy settings are stored in `samconfig.toml` which is git-ignored. Create it from the template below, replacing the ECR URI with your own public or private ECR repository for the Parser Lambda image.

```bash
cat > samconfig.toml << 'EOF'
version = 0.1

[default.deploy.parameters]
stack_name = "fruiting-crawler"
resolve_s3 = true
s3_prefix = "fruiting-crawler"
region = "us-east-1"
confirm_changeset = false
capabilities = "CAPABILITY_IAM"
image_repositories = ["ParserFunction=<your-ecr-repo-uri>"]

[default.global.parameters]
region = "us-east-1"
EOF
```

To create a public ECR repository:

```bash
aws ecr-public create-repository --repository-name web-to-markdown --region us-east-1
```

### 6. Build and deploy

```bash
# Build (compiles Entrypoint zip + builds Parser Docker image)
sam build

# Deploy (pushes Docker image to ECR, creates/updates CloudFormation stack)
sam deploy
```

On the first deploy, SAM will create:
- An S3 bucket named `fruiting-crawler-output-<account-id>`
- The Entrypoint Lambda
- The Parser Lambda (from Docker image)
- An EventBridge rule scheduled every hour

### 7. Run tests

```bash
npm test
```

## Backfill historical articles

After the first deploy, run the hydration script to process all existing articles instead of waiting for the hourly trigger:

```bash
# Get your deployed function name
aws cloudformation describe-stacks \
  --stack-name fruiting-crawler \
  --query "Stacks[0].Outputs[?OutputKey=='EntrypointFunctionArn'].OutputValue" \
  --output text

# Set it in your .env, then run:
source .env
npm run hydrate
```

The script loops through all pages of the Fruiting API and invokes the Entrypoint Lambda for each, with a 5-second delay between pages to avoid throttling.

## Tear down

```bash
# Delete the CloudFormation stack and all associated resources
sam delete --stack-name fruiting-crawler
```

> **Note:** The S3 bucket must be empty before deletion. Empty it first via the AWS Console or:
> ```bash
> aws s3 rm s3://fruiting-crawler-output-<account-id> --recursive
> ```
