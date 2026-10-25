FROM node:24.15.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /opt/orloj
COPY . .
RUN pnpm install --frozen-lockfile --filter @orloj/stellar-registry --filter @orloj/skills-marketplace
RUN pnpm --filter @orloj/stellar-registry build
FROM base AS app
RUN pnpm --dir packages/app install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1 DATABASE_SSL=false BETTER_AUTH_SECRET=build-time-only-not-a-runtime-secret-0000
RUN pnpm --dir packages/app build
RUN mkdir -p /agents && chown -R node:node /agents
USER root
ENTRYPOINT ["sh","/opt/orloj/infra/local/service-entrypoint.sh"]
WORKDIR /opt/orloj/packages/app
CMD ["sh","-c","node scripts/migrate-local.mjs && pnpm start --hostname 0.0.0.0"]
FROM base AS registry
USER root
ENTRYPOINT ["sh","/opt/orloj/infra/local/service-entrypoint.sh"]
WORKDIR /opt/orloj/packages/stellar-registry
CMD ["sh","-c","node dist/src/cli.js migrate && node dist/src/cli.js serve"]
FROM base AS signer
USER root
ENTRYPOINT ["sh","/opt/orloj/infra/local/service-entrypoint.sh"]
WORKDIR /opt/orloj/packages/stellar-registry
CMD ["sh","-c","node dist/src/cli.js migrate && node dist/src/managed-signer.js"]
