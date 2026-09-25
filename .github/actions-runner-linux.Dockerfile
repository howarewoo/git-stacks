# Debian provides native ARM64 Chromium; Ubuntu's chromium-browser requires Snap.
FROM debian:bookworm-slim

ARG RUNNER_UID=1000
ARG RUNNER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        chromium \
        curl \
        file \
        git \
        iproute2 \
        libicu72 \
        gh \
        jq \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        sudo \
        unzip \
        util-linux \
        xz-utils \
        zip \
    && rm -rf /var/lib/apt/lists/*

RUN group_name="$(getent group "${RUNNER_GID}" | cut -d: -f1 || true)"; \
    if [ -z "${group_name}" ]; then \
        groupadd --gid "${RUNNER_GID}" runner; \
        group_name=runner; \
    fi; \
    if ! getent passwd "${RUNNER_UID}" >/dev/null; then \
        useradd --uid "${RUNNER_UID}" --gid "${RUNNER_GID}" --create-home --shell /bin/bash runner; \
    fi; \
    printf 'runner ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/pullfrog-runner; \
    chmod 0440 /etc/sudoers.d/pullfrog-runner


# a named volume mounted at /runner inherits this directory's ownership, so the
# runner user — not root — must own it or every job starts unable to write.
RUN mkdir -p /runner && chown "${RUNNER_UID}:${RUNNER_GID}" /runner
WORKDIR /runner
USER runner
ENV HOME=/home/runner
ENTRYPOINT ["/runner/run.sh"]
