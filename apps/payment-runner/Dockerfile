FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package.json
COPY tsconfig.json tsconfig.json
COPY src src
RUN npm install --omit=dev=false \
  && npx playwright install --with-deps chromium
ENV ATLAS_RUNNER_HTTP_ADDR=0.0.0.0:8091
EXPOSE 8091
CMD ["npx", "tsx", "src/index.ts"]
