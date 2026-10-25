FROM docker:29.9.2-cli AS docker
FROM node:24.15.0-bookworm-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY infra/local/runtime-broker.mjs /broker.mjs
CMD ["node","/broker.mjs"]
