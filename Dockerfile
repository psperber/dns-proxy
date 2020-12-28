FROM node:14

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY src src
COPY babel.config.js babel.config.js

RUN npm run build

RUN npm ci --only=production
RUN rm -rf src

VOLUME /etc/dns-proxy

CMD [ "node", "dist/server.js" ]
