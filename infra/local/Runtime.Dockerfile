FROM debian:bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN target_arch="$(dpkg --print-architecture)"; case "${TARGETARCH:-$target_arch}" in arm64) target=aarch64-unknown-linux-musl; checksum=826f1852189fe76dbf1860d73d3fceb2cbe5d6cc58714bb9c64941f42ffa09a1;; amd64) target=x86_64-unknown-linux-musl; checksum=3547ab00a5af77b76e7feedc852c733c69a178cc3e961f689cb66eb56ab4bcf9;; *) exit 1;; esac; curl -fsSL "https://github.com/zeroclaw-labs/zeroclaw/releases/download/v0.8.6/zeroclaw-${target}.tar.gz" -o /tmp/runtime.tar.gz && echo "$checksum  /tmp/runtime.tar.gz" | sha256sum -c - && tar xzf /tmp/runtime.tar.gz -C /usr/local/bin zeroclaw && rm /tmp/runtime.tar.gz
RUN useradd -u 1000 -m agent
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/zeroclaw"]
