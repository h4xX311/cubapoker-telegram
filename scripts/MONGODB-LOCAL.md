# MongoDB local para el test de integración

El test de integración (`scripts/test-e2e-field.js`) necesita un MongoDB de verdad.
Esta guía explica cómo montarlo en una máquina donde **los servidores de descarga
de MongoDB están bloqueados**.

---

## El problema

`fastdl.mongodb.org`, `downloads.mongodb.com`, `downloads.mongodb.org` y
`mongodb.com` devuelven **403** en la red de esta máquina. Es un bloqueo por IP de
origen, no por protocolo ni por versión de Mongo:

- Se probaron las versiones 7.0.14, 7.0.5 y 6.0.14: las tres dan 403.
- Con `curl -4` (IPv4 forzado): 403.
- Con un `User-Agent` de navegador en vez del de curl: 403.
- `mongodb-memory-server` no puede descargar nada y falla.

Lo que **sí** responde:

| Servidor | Estado |
|---|---|
| `registry.npmjs.org` | 200 |
| `github.com` y `raw.githubusercontent.com` | 200 |
| `pgp.mongodb.com` | 200 |
| `archive.ubuntu.com` | 200 |
| `mirrors.tuna.tsinghua.edu.cn/mongodb/` | **200** |
| `mirror.nju.edu.cn/mongodb/` | **200** |
| `mirrors.aliyun.com/mongodb/` | **200** |

Los mirrors llevan una copia del repo apt oficial de MongoDB. Con la clave GPG de
`pgp.mongodb.com` (que sí responde) se puede instalar el servidor desde ahí.

---

## Montaje en WSL (sin ser root)

No hace falta `sudo`, y por tanto **no hace falta la contraseña**. El truco es
extraer el `.deb` con `dpkg-deb -x`, que no necesita privilegios, y ejecutar
`mongod` desde el directorio resultante.

```bash
# 1. El .deb del servidor, desde el mirror
MIRROR=https://mirrors.tuna.tsinghua.edu.cn/mongodb/apt/ubuntu
curl -fsSL "$MIRROR/dists/jammy/mongodb-org/8.0/multiverse/binary-amd64/Packages" -o /tmp/Packages

FILENAME=$(awk '/^Package: mongodb-org-server$/{f=1} f&&/^Filename: /{print $2; exit}' /tmp/Packages)
curl -fsSL "$MIRROR/$FILENAME" -o /tmp/mongod.deb

# 2. Extraer en el home
mkdir -p ~/mongodb
dpkg-deb -x /tmp/mongod.deb ~/mongodb

# 3. Arrancar
mkdir -p ~/mongo-data
~/mongodb/usr/bin/mongod \
  --dbpath ~/mongo-data \
  --port 37017 \
  --bind_ip 127.0.0.1 \
  --logpath ~/mongo-data/mongod.log &

# 4. Comprobar
~/mongodb/usr/bin/mongod --version
```

Quedará escuchando en `127.0.0.1:37017`. El puerto 37017 y no el 27017 a propósito:
si alguien tiene un Mongo de servicio en el 27017, este no lo pisa.

> **Nota sobre el repo `jammy`:** se usa el de Ubuntu 22.04 aunque el sistema sea
> otro. El `.deb` es el mismo binario y funciona igual. Los mirrors de MongoDB no
> publican un directorio por versión de Ubuntu.

---

## Ejecutar el test

Node tiene que poder llegar a ese Mongo. En esta máquina, el Node de Windows **no**
llega al puerto de WSL (son pila de red distintas), así que el test se ejecuta con
el Node **de dentro de WSL**:

```bash
cd ~/ruta/al/proyecto          # ojo si la ruta tiene apostrophe: usa ~/cp
npm run build
MONGODB_URI=mongodb://127.0.0.1:37017/cubapoker_e2e node scripts/test-e2e-field.js
```

Con `MONGODB_URI` apuntando a otro sitio (Atlas, un Mongo de otra máquina), el
mismo test funciona sin cambios.

### El problema del apóstrofe en la ruta

La ruta de este proyecto es `C:\Users\La'Roch\...`, y el apóstrofo rompe el
quoting de bash en cuanto se pone entre comillas. Se evita con un enlace simbolico:

```bash
ln -s /mnt/c/Users/*/cubapoker/telegram-bot ~/cp
cd ~/cp
```

El glob evita escribir el apóstrofo, y a partir de ahí `cd ~/cp` funciona en todos
los scripts.

---

## Qué hay que tener en cuenta

- **La base se borra al empezar y al terminar.** El test usa `cubapoker_e2e` y no
  toca ninguna otra. Aun así, no apuntes `MONGODB_URI` a una base con datos reales.
- **El test tarda unos 30 segundos** con 300 jugadores: hace 300 registros, uno a
  uno, contra Mongo real.
- **Si `mongod` no responde**, el test falla al conectar en la sección 0. Es el
  primer sitio donde mirar.

---

## Por qué este test existe

Antes de esto, las 395 pruebas eran aritmética pura y **el gestor de campos nunca
se había ejecutado**. El primer día que se ejecutó contra un Mongo real encontró
cuatro bugs que no se pueden ver leyendo el código:

1. `openField` escribía `buyInUnits` en un campo que el modelo llamaba `buyIn`, y
   como es `required`, **el registro de un jugador fallaba siempre**.
2. `trySeat` calculaba el número de mesas sobre la cola, que se vacía al sentar a
   la gente: los 300 jugadores acababan **amontonados en una sola mesa de 300
   asientos**.
3. `collectEliminations` **devolvía a `balance.real` las fichas del eliminado**.
   Comprar entrada, perderla y recuperar el buy-in era un ciclo gratis.
4. `settleField` **pagaba un premio calculado desde la nada y además devolvía las
   fichas**: el campo creaba 129,25 USDT de la nada con 300 jugadores de 1 USDT.

Ninguno de los cuatro se ve leyendo. Por eso el test existe, y por eso hay que
ejecutarlo antes de abrir a un solo usuario.