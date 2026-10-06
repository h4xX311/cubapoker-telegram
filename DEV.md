# Desarrollo local

Cómo trabajar en CubaPoker sin desplegar y sin abrir el bot en Telegram cada vez.

## El problema que esto resuelve

Un Mini App de Telegram **solo** funciona dentro de Telegram. Sin `initData` no hay
forma de validar quién es el usuario, y sin esa validación cualquiera podría
suplantar cualquier cuenta. Por eso `App.tsx` rechaza la aplicación abierta en un
navegador, y hace bien.

El coste para quien desarrolla es que un cambio en la interfaz no se ve hasta que se
despliega y se abre el bot. Eso no es un ciclo de trabajo: es diez minutos por cambio.

## Cómo se resuelve

Por los dos lados, y **los dos tienen que estar de acuerdo**:

| Lado | Qué hace | Condición |
|---|---|---|
| Navegador (`mini-app/src/App.tsx`) | Si no hay `initData`, deja pasar en vez de negar | `import.meta.env.DEV` |
| Servidor (`src/middleware/telegramAuth.ts`) | Acepta la cabecera `x-dev-auth` | `NODE_ENV !== 'production'` **y** `DEV_AUTH_BYPASS === 'true'` |

Lo importante es que **decide el servidor**, no el navegador:

- `import.meta.env.DEV` lo incrusta Vite como `false` al compilar. En el build de
  producción **la rama desaparece entera**, y se puede comprobar: el bundle no
  contiene la cadena `x-dev-auth`.
- En Render hay `NODE_ENV=production`, así que aunque alguien enviara la cabecera a
  mano, el servidor la rechaza.

Es una puerta de atrás de la cocina, no un agujero en la fachada.

## Arrancar

Dos terminales, en la raíz del proyecto.

**Terminal 1 · el servidor** (puerto 3000)

```bash
npm run dev
```

**Terminal 2 · la interfaz** (puerto 5173)

```bash
cd mini-app
npm run dev
```

Y abre **http://localhost:5173**, no el de Telegram. El proxy de Vite (`vite.config.ts`)
manda `/api` a `localhost:3000`, así que no hace falta ninguna URL pública ni túnel.

> Si cambias `PORT` en el `.env`, cambia también el `target` del proxy en
> `vite.config.ts`. Están en sitios distintos y no se avisan.

## Usuario de desarrollo

Por defecto el usuario **`600000001`**. `/api/me` lo crea solo la primera vez con
saldo cero, así que no hay que sembrar nada.

Para cambiar de usuario, o para tener varios a la vez:

```
http://localhost:5173/?devUser=600000002
```

Cada usuario tiene su propio saldo, su propio campo y su propio historial. Útil para
probar el caso de "dos personas jugando a la vez".

Y para tener saldo con el que probar un depósito o una compra de entrada:

```bash
# Dale saldo real al usuario de desarrollo
mongosh "mongodb+srv://..." --eval 'db.users.updateOne({telegramId:600000001},{$set:{"balance.real":500000}})'
```

O, más fácil, usa los botones de **Depositar** de la propia interfaz: con
`SIMULATE_PAYMENTS=true` (por defecto) el depósito se acredita sin tocar la cadena.

## Lo que NO se puede probar aquí

**Un pago real.** Con `SIMULATE_PAYMENTS=true` las pasarelas no mueven dinero, que es
lo correcto. Y el circuito de TRC20 de verdad necesita `TRONGRID_API_KEY` y consultar la
cadena: eso solo se prueba con la clave puesta y una transacción real.

**El webhook de Telegram.** En desarrollo el bot va por polling, no por webhook
(`USE_WEBHOOK = NODE_ENV === 'production'`). El webhook solo existe en Render, y se
registra Visiting `/telegram/setup` una vez.

**La identidad real.** El bypass da un usuario fijo. Lo que dependa de que haya dos personas distintas, usa dos ventanas con `?devUser=` distintos.

## Comprobaciones antes de subir nada

```bash
npm test              # 395 unitarias de aritmetica pura
cd mini-app && npm run build
```

Y antes de commitear, mira que el bundle no se ha Filtrado el bypass:

```bash
grep -c x-dev-auth mini-app/dist/assets/*.js   # debe ser 0
```

Si sale algo, `import.meta.env.DEV` ha llegado al build de producción, y eso hay que
pararlo antes de desplegar.