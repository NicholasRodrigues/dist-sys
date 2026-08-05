# Uma imagem para todos os servicos.
#
# O monorepo compila uma vez e cada servico e apenas um comando diferente sobre
# o mesmo artefato. A alternativa seria sete Dockerfiles com sete `npm install`
# quase identicos — mais lento, mais facil de divergir, e sem ganho nenhum: os
# servicos ja sao processos separados em tempo de execucao, que e o que importa
# para a arquitetura.
#
# Um unico `npm ci` no estagio de build, com `npm prune` no fim para descartar
# as dependencias de desenvolvimento. Instalar duas vezes (uma para compilar,
# outra para rodar) e o erro obvio aqui: dobra o tempo e nao economiza nada.

FROM node:22-alpine AS build
WORKDIR /app

# Ancoras de confianca adicionais, se houver. Redes com inspecao TLS reassinam
# o trafego com uma CA propria, e sem ela o `npm ci` falha com
# SELF_SIGNED_CERT_IN_CHAIN — pior ainda, falha em silencio, deixando
# diretorios vazios em node_modules. Em rede comum a pasta esta vazia e este
# passo nao faz nada.
COPY docker/ca/ /tmp/ca/

COPY package.json package-lock.json ./
RUN set -e; \
    if ls /tmp/ca/*.crt >/dev/null 2>&1; then \
      cat /tmp/ca/*.crt > /tmp/extra-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; \
      echo "usando CA adicional para o download das dependencias"; \
    fi; \
    npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# Descarta typescript, vitest e companhia: eles nao vao para a imagem final.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web

# Sem privilegio: o usuario `node` ja vem na imagem base.
USER node

# O servico e escolhido pelo comando no docker-compose.
CMD ["node", "dist/services/edge/index.js"]
