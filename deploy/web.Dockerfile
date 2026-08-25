FROM node:22-alpine AS build

WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./

# Empty means "same origin": the browser calls /api/... and nginx proxies it.
ARG VITE_LOCAL_API_BASE=""
ENV VITE_LOCAL_API_BASE=$VITE_LOCAL_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
