# Certificados adicionais para o build

Qualquer arquivo `.crt` colocado aqui e adicionado as ancoras de confianca
**durante o build da imagem**.

Isso existe porque redes universitarias e corporativas costumam fazer inspecao
TLS: o proxy reassina o trafego com uma CA propria, e o `npm ci` dentro do
contentor falha com `SELF_SIGNED_CERT_IN_CHAIN` — de forma silenciosa, criando
diretorios vazios em `node_modules` em vez de dar um erro claro.

Em uma rede comum, esta pasta fica vazia e nada muda.

O `make up` copia automaticamente o certificado apontado por `NODE_EXTRA_CA_CERTS`
ou `SSL_CERT_FILE`, se alguma dessas variaveis estiver definida.

Os `.crt` nao entram no versionamento (ver `.gitignore`).
