FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:20

# Install system dependencies for Chromium and Pandoc
RUN dnf install -y \
    nss \
    alsa-lib \
    at-spi2-atk \
    at-spi2-core \
    atk \
    cups-libs \
    libdrm \
    libxkbcommon \
    libXcomposite \
    libXdamage \
    libXrandr \
    mesa-libgbm \
    pango \
    xdg-utils \
    wget \
    tar \
    gzip \
    && dnf clean all

# Install Pandoc (amd64)
RUN wget -q https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-amd64.tar.gz \
    && tar xzf pandoc-3.6.4-linux-amd64.tar.gz \
    && mv pandoc-3.6.4/bin/pandoc /usr/local/bin/ \
    && rm -rf pandoc-3.6.4-linux-amd64.tar.gz pandoc-3.6.4 \
    && pandoc --version

# Set Puppeteer environment variables (optional for @sparticuz/chromium)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY app.js ./

# Set the Lambda handler
CMD ["app.handler"]
