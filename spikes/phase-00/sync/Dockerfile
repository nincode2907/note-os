FROM node:22.21.1-bookworm-slim
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "test"]
