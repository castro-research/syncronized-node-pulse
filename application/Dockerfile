# Builds the Crystal server (static binary) and copies just it and the front end into a minimal image.
FROM crystallang/crystal:latest-alpine AS build
RUN apk add --no-cache sqlite-dev sqlite-static
WORKDIR /src
COPY shard.yml shard.lock ./
RUN shards install --production
COPY src/server.cr src/server.cr
RUN crystal build src/server.cr --release --static --no-debug -o pulse

FROM alpine:3
# /data is the SQLite volume; created here already owned so a new volume inherits the permission
RUN adduser -D -H pulse && mkdir /data && chown pulse /data
WORKDIR /app
COPY --from=build /src/pulse pulse
COPY src/web web
ENV HOST=0.0.0.0 PORT=3000 WEB_DIR=/app/web DB_PATH=/data/pulse.db
USER pulse
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:3000/time || exit 1
CMD ["/app/pulse"]
