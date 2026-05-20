# Multi-stage Dockerfile for the NestJS API.
#
# Build:
#   docker build -f deploy/api.Dockerfile -t pstn-twilio-api:latest .
#
# Run:
#   docker run -p 3000:3000 --env-file .env pstn-twilio-api:latest

FROM node:22-bookworm-slim AS base
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY tsconfig.base.json tsconfig.json ./
# Build shared types first, then the NestJS API.
RUN pnpm --filter @pstn-twilio/shared build
RUN pnpm --filter @pstn-twilio/api prisma:generate
RUN pnpm --filter @pstn-twilio/api build
# Prune dev deps for the runtime image.
RUN pnpm --filter @pstn-twilio/api deploy --prod /out/api

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Install only the bare minimum CA certs for outbound TLS (Twilio + Neon + Upstash).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api/package.json ./package.json
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Run migrations on boot, then start the server. Use `prisma migrate deploy` so
# nothing about the schema can drift at runtime.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
