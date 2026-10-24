# The relay as a container. Build from the repository root:
#   docker build -f server/Dockerfile -t derby-relay .
#   docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://derby.natwong.dev derby-relay
# No dependencies to install: the relay is plain TypeScript run by Bun.
FROM oven/bun:1-alpine
WORKDIR /app
COPY server ./server
COPY src ./src
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER bun
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["bun", "server/bun.ts"]
