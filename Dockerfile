# One image for the API or the worker: docker build --build-arg APP=api .
# Runs as a non-root user. Configuration comes only from environment
# variables at run time; no secret is baked into the image (docs/11).
FROM node:26-alpine AS build
RUN npm install -g pnpm@12.14.0
WORKDIR /repo
COPY . .
# Generating the Prisma client never connects; this placeholder is build-only.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile
ARG APP=api
RUN pnpm --filter ./apps/${APP}... build

FROM node:26-alpine AS run
ARG APP=api
ENV NODE_ENV=production APP=${APP}
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/${APP}
EXPOSE 3000
CMD ["sh", "-c", "node --env-file-if-exists=../../.env dist/main.js"]
