# CubaPoker · Estado de preparación para lanzamiento

Análisis del estado real del proyecto y qué falta para operar en público.
Fecha: 4 de octubre de 2026.

---

## 0. La economia del campo (resuelta)

**El premio sale del bote.** Es un Sit'n'Go clasico: cada jugador mete su
buy-in, el rake del 5 % se descuenta de los botes de cada mano, y el 95 %
restante se reparte a las primeras posiciones (45/25/15/9/6 %). RTP del 95 %, el
estandar de poker. Sin bolsa, sin pasivo, sin tope de gasto: el bote escala
solo con cuantos jugadores jueguen.

| field | buy-in | bote bruto | rake | bote neto | 1º lugar |
|---|---|---|---|---|---|
| 50 | 200 | 10 000 | 500 | 9 500 | 4 275 |
| 100 | 500 | 50 000 | 2 500 | 47 500 | 21 375 |
| 300 | 1 000 | 300 000 | 15 000 | 285 000 | 128 250 |
| 500 | 2 000 | 1 000 000 | 50 000 | 950 000 | 427 500 |

(Estimaciones a campo lleno. El bote real depende de la ocupacion.)

### Correccion: un calculo de RTP que estaba mal

En una iteracion anterior calcule el RTP como

```
premio / (fieldSize x buyIn)
```

y salia un 0,05 %, con lo que conclui que el producto era "una entrega de dinero"
y arme tres alternativas economicas con el codigo correspondiente. **El
calculo era erroneo**: esa expresion supone que el jugador recupera solo el
premio, cuando en un campo recupera su buy-in en fichas menos el rake.

```
RTP = 1 - rake% + premio / (field x buyIn)
```

Con estos numeros da 95,50 / 95,20 / 95,10 / 95,05 %. El producto es viable
tal como estaba. Las tres alternativas (buy-in de 1 CUP, bolsa promocional,
premio proporcional) eran trabajo para un problema inexistente, y la bolsa
promocional se ha eliminado.

Las pruebas de `test-payout.js` imprimen las dos formulas, la correcta y la
erronea, para que el error no se repita al tocar los numeros.

### Lo que queda dicho en la interfaz

El premio va a `balance.play`, que no es retirable. Es una decision de negocio
(ya tomada antes para los freerolls), no una consecuencia de la aritmetica, y
la UI lo dice: "El premio sale del bote del campo... se abona como saldo de
promocion, que sirve para jugar en cualquier campo y no se puede retirar."

Sin ese texto, "premio garantizado" es publicidad engañosa. En Cuba, sin marco
legal de juego online, un reclamo por publicidad falsa es el riesgo mas
probable del proyecto.

## Resumen

| Área | Estado | Bloquea lanzamiento |
|---|---|---|
| Autenticación y seguridad | Completo | No |
| Flujo de pagos (simulado) | Completo | No |
| Multi-red USDT (5 cadenas) | Completo | No |
| Motor de poker | Completo y probado | No |
| Bots | Completo | No |
| Economía del campo | Resuelta (premio del bote, RTP 95 %) | No |
| Reparto del bote | Completo y probado | No |
| Interfaz | Completo | No |
| **Field manager multi-mesa** | **Pendiente** | **Sí** |
| **Pasarelas reales** | **Pendiente** | **Sí** |
| **Panel de operador** | **Pendiente** | **Sí** |
| **Infraestructura 24/7** | **Pendiente** | **Sí** |
| **Cumplimiento legal** | **Pendiente** | **Sí** |
| Modelo económico doble saldo | Completo | No |

---

## 1. Mesa física 7-max, field multi-mesa

Dos números que se confundían y que hay que mantener separados:

| Concepto | Valor | Qué es |
|---|---|---|
| `SEATS_PER_TABLE` | **7** | Personas sentadas en una mesa. Una mesa de poker real. |
| `fieldSize` | 50 / 100 / 300 / 500 | Participantes del **campo** completo (multi-mesa). |

Un campo de 500 no es una mesa de 500: son `ceil(500 / 7) = 72` mesas de 7 que
se van fusionando mano a mano hasta que queda una mesa final de 7. Es un
Sit'n'Go multi-mesa, como el que hacen CoinPoker y similares.

```
Campo de 500
  ┌─ mesa 1: 7 jugadores ─┐
  ├─ mesa 2: 7 jugadores ─┤  72 mesas al inicio
  ├─ ...                 ─┤
  └─ mesa 72: 7 jugadores┘

  al bajar de 4 jugadores, la mesa se fusiona con la siguiente
  cuando solo queda 1 mesa -> mesa final -> reparto del premio por posición
```

El error de la iteración anterior fue anunciar "mesa de 500 jugadores" y
obligar al motor a repartir 23 por tanda para disimularlo. `table.manager.ts`
ya no hace tandas: con 7-max entran todos los activos en cada mano.

**Techo matemático de seguridad:** `(52 - 5 comunitarias) / 2 = 23`. Con 7-max
nunca se acerca, pero la guarda se mantiene para que una configuración rara no
reparta cartas `undefined` y tumbe la mesa.

### Lo que falta: el field manager

`table.manager.ts` gestiona **una** mesa. Aplicaba el premio al ganador de esa
mesa, lo cual es incompatible con un field de 500: el premio es del campo
completo y se reparte por posición final. Falta el gestor de campo:

1. Campo con `registeredCount / fieldSize`, repartido en mesas de 7.
2. Asignación de asiento → mesa; al caer fichas, el hueco pasa al siguiente de
   la cola de espera.
3. **Merge**: cuando una mesa baja de 4 jugadores y hay espera, se fusiona con
   la siguiente.
4. **Mesa final**: cuando queda 1 mesa, se congela el campo y se reparte el
   premio por posición (`FIELD_PAYOUT` = 45/25/15/9/6 %).
5. Tope práctico del freeroll: `FREEROLL_TARGET_FIELD = 300` para arrancar,
   `FREEROLL_MAX_FIELD = 900` como techo duro. "Ilimitado" no puede ser
   ilimitado de verdad.

El modelo `Table.field` ya tiene los campos necesarios (`fieldId`, `tableNumber`,
`targetField`, `registered`, `seated`, `paidPositions`, `fieldStatus`); falta el
servicio que los lea y escriba.

**El reparto de un field NO sale del bote de la última mesa**: con 7 jugadores en
la mesa final, el bote nunca llega a 500 CUP. El premio es una bolsa aparte del
operador (ver §0).

---

## 2. Lo que quedó resuelto en esta iteración

### 2.1 Cuatro bugs que rompían el juego

**El motor limitaba a 6 jugadores.** `addPlayer` tenía `if (players.length >= 6)
return false`, un tope heredado de un 6-max. Con el producto anunciando 500
participantes, ninguna mesa grande arrancaba: `startGame` se quedaba con 2
jugadores y devolvía `false`. El tope ahora es `maxSeats` de cada mesa.

**El botón nunca rotaba.** `startGame` fijaba `dealerIndex = 0`,
`smallBlindIndex = 1`, `bigBlindIndex = 2` en cada mano, para siempre. Quien
occupara el asiento 0 tenía ventaja permanente y las ciegas eran siempre las
mismas. Ahora `startGame(startingDealerIndex)` recibe dónde empezar, y
`TableManager` lo mantiene en `table.hand.dealerSeat` (que ya existía en el
modelo y nunca se usaba) avanzando al siguiente asiento ocupado.

**El bote perdía fichas en cada mano.** El reparto era
`Math.floor(pot / winners.length)` a cada ganador, y el resto se quedaba en el
bote sin destino. Con 2-3 ganadores impares eso evaporaba 1-2 CUP del sistema
por mano. Con el tiempo las fichas de la mesa llegan a 0 para todo el mundo.
Ahora el reparto asigna el resto explícitamente a los primeros ganadores y hay
una prueba de conservación: lo entregado debe coincidir exactamente con lo
aportado.

**El flop repartía cartas `undefined`.** `advancePhase` hacía
`communityCards.push(deck.pop()!)` con el `!` de TypeScript silenciando que
`pop()` devuelve `Card | undefined`. Con mazo agotado, el evaluador reventaba
con `Cannot read properties of undefined (reading 'suit')` y **tumbaba la mesa
entera**. Ahora `dealCommunity()` verifica y detiene la mano, y `MAX_DEALABLE_PLAYERS`
impide llegar a esa situación.

### 2.2 7-max: `fieldSize` en vez de `maxPlayers`

`TableTier.maxPlayers` pasó a llamarse `fieldSize` para que el nombre no
siguiera sugiriendo "500 personas en una mesa". Los sitios que importaban:

- `SEATS_PER_TABLE = 7` como constante única; `maxSeats` de cada mesa sale de ahí.
- `BOT_CONFIG.maxBotsPerTable` pasó de 60 a `SEATS_PER_TABLE - 1`. El 60 era
  imposible en una mesa de 7 y además habría convertido cualquier campo pequeño
  en una mesa de solo bots.
- `DEFAULT_MAX_PLAYERS` del motor: de 500 a 7.
- `FIELD_PAYOUT = [45, 25, 15, 9, 6]` para el reparto por posición del campo.
- La UI muestra "Campo 500 · 72 mesas · 7-max" en vez de "Mesa de 500".
- Los tests de business rules se reescribieron contra `fieldSize`, y el motor se
  prueba con 2/3/6/7/9/23 jugadores.

### 2.3 Avisos de turno en lugar de spam

Antes el bot mandaba el estado completo de la mesa (bote, comunitarias, lista de
rivales) en **cada** acción de **cada** mesa. Con varios jugadores eso es un
volumen de mensajes insostenible y además filtraba las cartas del rival al
cliente.

Ahora el gestor de mesas expone `setNotifier()` y solo emite un aviso cuando le
toca a un humano: sus dos cartas, el bote, cuánto tiene que poner y el plazo.
Deduplicado por turno, así que el mismo asiento en la misma calle recibe un solo
mensaje.

`chatId` se guardó en el modelo `User` (el bot ahora lo persiste en `/start`,
solo en chat privado: en un grupo el aviso "te toca" se leería en voz alta).

### 2.4 Saldo doble: `real` vs `play`

Decisión ya implementada y ahora respetada en **todas** las rutas de dinero:

| Origen | Destino | ¿Retirable? |
|---|---|---|
| Depósito | `balance.real` | Sí |
| Retiro | consume solo `real` | — |
| Premio de freeroll | `balance.play` | **No** |
| Logro / racha | `balance.play` | **No** |
| Bonus de referido | `balance.play` | **No** |
| Comisión de referido (rake) | `balance.real` | Sí |
| Compra de VIP | consume `real` | — |

El punto crítico: **un retiro solo puede consumir `balance.real`**. Si se dejara
usar `play`, un usuario podría ganar 5-50 CUP en freerolls repetidamente y
drenar la plataforma sin depositar nunca. La comprobación está en
`payment.service.ts` con un mensaje que explica la diferencia en lugar de un
genérico "saldo insuficiente".

Al sentarse en una mesa cash se consume `play` primero, preservando `real` para
retiro.

### 2.5 Reparto del bote sin descuadres

`settleFreeroll` repartía con `Math.floor(pot * pct / 100)` por posición. Ese
reparto tiene dos fallos:

- **Se queda corto**: un bote de 5 CUP con 50/30/20 daba 2+1+1 = 4. Con botes de
  miles, decenas de CUP sin dueño en cada liquidación.
- **Se pasa**: "floor + resto repartido a partes iguales" daba 4 CUP de un bote
  de 3, es decir crear dinero.

`payout.service.ts` centraliza el reparto con `splitPrize()`, que recorre con
un acumulador del resto y ajusta el último tramo para que la suma sea exacta por
construcción. La prueba verifica los 2 000 botes de 1 a 2 000 CUP: cuadran
todos, ninguno negativo, ninguno mayor que el bote.

El reparto ingenuo queda medido en el test (falla en 1 500 de 2 000 botes) para
que quede constancia de que el test prueba lo que dice probar.

### 2.6 Verificación

| Prueba | Resultado |
|---|---|
| Build backend | limpio |
| Build frontend | 45 módulos, 203 kB |
| Cadenas y comisiones | 33/33 |
| Reglas de negocio | 54/54 |
| Reparto y RTP | 49/49 |
| Motor de poker | 84/84 |
| Auth sin firma | 401 correcto |
| Flujo de pago completo | **no ejecutado** (sin MongoDB local) |

`npm test` compila y corre las cuatro suites mediante `scripts/run-tests.js`.
Un runner propio en lugar de `a && b && c` porque si una suite falla por un
motivo concreto, las demás no llegan a ejecutarse, y las del motor son las que
cazan bugs reales.

Las del motor cubren: 7-max completo (7 sentados, 2 cartas cada uno, sobra
baraja), 2/3/6/7/9/23 jugadores llegando a `finished`, conservación de fichas
(lo entregado coincide con lo aportado), sin cartas repetidas ni `undefined`,
rotación de botón y ciegas, y que el motor se niegue a repartir 24.

Las de reparto cubren: cuadre exacto de los 2 000 botes de 1 a 2 000 CUP, rake
con tope por mano y su versión sin tope para campo, RTP del 95 % con la fórmula
correcta y a la vista la errónea, campo a media ocupación, y que la
transparencia de la UI mencione el bote y la no-retirabilidad.

---

## 3. Lo que falta para lanzar

### 3.1 Pasarelas de pago reales — BLOQUEA

Hoy `SIMULATE_PAYMENTS=true` (por defecto). Ninguna pasarela mueve dinero real.

Para pasar a producción hay que implementar contra la interfaz `PaymentGateway`
(`src/services/payment/gateway.ts`), una clase por proveedor:

| Trabajo | Esfuerzo |
|---|---|
| `EnZonaGateway` — crear orden, webhook de confirmación | ~4 h |
| `QvaPayGateway` — ídem | ~3 h |
| `USDTGateway` — monitorear 5 cadenas, confirmar incoming | ~12 h |

La parte difícil es USDT: hay que escuchar ERC-20 (logs), TRC20 (API de Tron),
BEP20/Polygon (RPC) y Solana (RPC + SPL token accounts). Recomendación:
arrancar solo con TRC20, que es la más barata para el usuario y la más simple
de monitorear.

Al conectar las reales, se cambia `SIMULATE_PAYMENTS=false` y desaparece la
pantalla de prueba.

### 3.2 Panel de operador — BLOQUEA

Ahora no hay forma de aprobar un retiro porque no existe interfaz de gestión.
Sin ella, si alguien pide un retiro, el dinero queda retenido sin salida.

Necesario:
- Listado de retiros pendientes
- Aprobar (ejecuta el pago, descuenta saldo) / Cancelar (devuelve saldo)
- Ver órdenes de depósito y su estado
- Estadísticas de negocio

Existe la lógica de servidor (`settleWithdrawal`, `cancelWithdrawal`); falta la
interfaz y exponer las rutas con `ADMIN_API_KEY`.

### 3.3 Infraestructura 24/7 — BLOQUEA

El plan gratuito de Render **suspende el servicio a los 15 minutos de inactividad**.
Los webhooks ya están implementados (`NODE_ENV=production` los usa), pero eso no
evita la suspensión: sin tráfico entrante constante, el proceso se congela y las
manos en curso se pierden.

Además, el estado de una mano vive **en memoria** (`table.manager.ts` mantiene el
motor en un `Map`). Al suspender y reanudar el proceso, las manos en vuelo se
devuelven a los jugadores, pero el juego queda cortado.

Opciones:
- Plan de pago (~$7/mes). Es lo mínimo para no perder partidas.
- VPS propio (DigitalOcean, Hetzner) con `pm2`. Más control, algo más de
  trabajo inicial.

### 3.4 Cumplimiento legal — BLOQUEA

Poker con dinero real está regulado en la mayoría de jurisdicciones, y Cuba no
es la excepción en cuanto a pagos. Antes de operar:

- Licencia o autorización para juegos de azar online
- Verificación de edad (el bot da acceso a menores sin comprobación)
- Términos y condiciones visibles y aceptados
- Política de juego responsable
- Autobloqueo
- Reporte de operaciones sospechosas (KYC/AML)
- Política de privacidad

Nada de esto está implementado. **No lanzar sin consultar a un abogado.**

### 3.5 Field manager multi-mesa — BLOQUEA el formato de campo

`table.manager.ts` gestiona una sola mesa. Con `fieldSize` de 50 a 500 eso no
sirve: falta el servicio de campo con inscripción, asignación de asientos, merge,
mesa final y reparto por posición (ver §1).

Lo que **ya está hecho** y le sirve:

- `Table.field` con `fieldId`, `tableNumber`, `targetField`, `registered`,
  `seated`, `paidPositions`, `fieldStatus`.
- `payout.service.ts`: `fieldPayout(buyIn, players)` devuelve bote bruto, rake,
  bote neto y el reparto por posición ya redondeado y cuadrando. La liquidación
  del campo es una llamada a esa función.
- `Table.hand.dealerSeat` persistido y rotando, que es lo que hace que el merge
  de mesas no claque el botón.

Lo que **no** está: el servicio que reparte jugadores entre mesas, decide el
merge cuando una mesa baja de 4 con cola de espera, y congela el campo cuando
queda una sola mesa.

### 3.6 Integridad del juego — no bloquea pero conviene

- **Rake VIP no se aplica.** La página VIP promete 3%/2%/0%, el código cobra 5%
  fijo. Un usuario VIP que lo compruebe pierde la confianza.
- **Logros y rachas no se disparan.** No hay hook que los active al ganar.
- **Colusión.** Nada impide que dos cuentas coordinen. En poker de dinero real
  eso vacía la plataforma. En un campo de 500 el problema es peor: hacen falta
  varios complicados, no dos.

### 3.7 Bots en un campo de 500

`BOT_CONFIG.botRatio` es 0,6 y el tope son 6 bots por mesa de 7. En un campo de
500 son 72 mesas, así que podrían llegar a actuar ~430 bots a la vez. Con
`winRate` entre 0,42 y 0,48 no vacían la plataforma, pero **en un campo los bots
se eliminan entre ellos**: sobreviven más los humanos, así que la mesa final
tiende a ser humana. Eso es lo correcto, pero conviene medirlo, porque el
jugador ve "derrotado por un bot" en la primera partida y vuelve si comprueba que
no es siempre.

---

## 4. Orden de ejecución recomendado

```
1. Legal               ← bloquea todo lo demás
2. Plan de pago Render ← sin esto las partidas se cortan
3. Panel de operador   ← sin esto los retiros se atascan
4. TRC20 real          ← la más simple, valida el circuito completo
5. Field manager       ← sin esto el campo de 500 no existe
6. Logros/rachas/VIP   ← honestidad con lo prometido
7. EnZona + QvaPay     ← requiere cuenta de empresa
8. Resto de cadenas
```

La economía del campo ya está resuelta (§0): el premio sale del bote y el RTP
es del 95 %. No bloquea.

Los puntos 1 a 4 son los mínimos para abrir a un grupo pequeño de usuarios de
prueba. El 5 es necesario para que el producto sea lo que promete; hasta
entonces, la opción honesta es mostrar 7-max de mesa única y quitar el "campo de
500" de la interfaz.

---

## 5. Cómo probar el flujo ahora

```bash
# 1. Levantar con simulación
SIMULATE_PAYMENTS=true DEV_AUTH_BYPASS=true npm run dev

# 2. Suites sin base de datos
npm test

# Suites por separado
npm run test:chains
npm run test:rules
npm run test:payout
npm run test:engine

# 3. Flujo completo (requiere MongoDB)
node scripts/test-payment-flow.js
```

Dentro de Telegram: Depositar → método y monto → continuar → "Simular pago" →
saldo acreditado en `real`.

El flujo completo de pagos está escrito (`test-payment-flow.js`) pero **no se ha
ejecutado**: no hay MongoDB ni Docker en esta máquina. Debe correr en un entorno
con base de datos antes de confiar en él.
