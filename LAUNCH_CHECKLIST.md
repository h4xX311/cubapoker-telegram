# CubaPoker · Estado de preparación para lanzamiento

Análisis del estado real del proyecto y qué falta para operar en público.
Fecha: 4 de octubre de 2026.

---

## 0. Lo primero: la economía del campo no cierra

Esto va antes que todo lo demás porque condiciona el field manager. Si se
escribe el gestor de campos con estos números, hay que reescribirlo.

Los cuatro tiers tienen `premio = fieldSize × 1 CUP`, y el buy-in mínimo va de
200 a 2000:

| field | premio | buy-in mín. | se recauda | **RTP del jugador** |
|---|---|---|---|---|
| 50 | 50 | 200 | 10 000 | **0,50 %** |
| 100 | 100 | 500 | 50 000 | **0,20 %** |
| 300 | 300 | 1 000 | 300 000 | **0,10 %** |
| 500 | 500 | 2 000 | 1 000 000 | **0,05 %** |

La cuenta del operador sí cierra: el rake del 5 % del campo de 500 son 50 000
CUP contra un premio de 500, así que el operador gana. El problema es el
jugador, que pierde el 99,95 % de lo que pone. No es un juego con margen fino,
es una entrega de dinero, y nadie repite dos veces.

Para un RTP sano de ~95 % el buy-in tendría que ser **1,05 CUP en los cuatro
campos**. Con eso los cuatro campos son idénticos y el ladder se aplana: jugar
en el de 500 tardaría horas y daría lo mismo que el de 50.

### Las tres salidas

**A) Bajar el buy-in a ~1 CUP.** RTP sano, pero el rake de 5 % da 0,05 CUP por
mano: no cubre ni el gasto de infraestructura. Y el ladder pierde sentido.

**B) Que el premio salga de un fondo promocional, no del bote.** El RTP del
jugador pasa a ser 100 % por el premio, y el ingreso del operador es el rake.
Es lo que hacen CoinPoker y similares con los *guaranteed prize pools*. Además,
como el premio de los freerolls va a `balance.play` (no retirable), ese mismo
fondo puede alimentar los campos cash sin generar obligación de pago. Con esto
el campo de 500 con premio 500 CUP es un gancho promocional de bajo valor, que
es coherente con el producto, pero hay que decirlo así en la interfaz.

**C) Hacer que el premio crezca con el field.** `premio = field × buy-in × 0,95`.
El campo de 500 pagaría ~950 000 CUP: ya no es un premio promocional sino un
torneo serio, y exige una caja mucho mayor.

**Hay que elegir una antes de escribir el field manager.** El reparto por
posición, la tabla deliquidación y la estructura de premios dependen de ello.

Mientras tanto, `test-business-rules.js` falla **a propósito** en el bloque 2.
No es un test roto: es el aviso de que el producto no es jugable todavía.

---

## Resumen

| Área | Estado | Bloquea lanzamiento |
|---|---|---|
| Autenticación y seguridad | Completo | No |
| Flujo de pagos (simulado) | Completo | No |
| Multi-red USDT (5 cadenas) | Completo | No |
| Motor de poker | Completo y probado | No |
| Bots | Completo | No |
| Interfaz | Completo | No |
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

### 2.5 Verificación

| Prueba | Resultado |
|---|---|
| Build backend | limpio |
| Build frontend | 45 módulos, 203 kB |
| Cadenas y comisiones | 33/33 |
| Reglas de negocio | 47/48 — **el fallo es deliberado** (§0) |
| Motor de poker | 84/84 |
| Auth sin firma | 401 correcto |
| Flujo de pago completo | **no ejecutado** (sin MongoDB local) |

`npm test` compila y corre las tres suites mediante `scripts/run-tests.js`. Un
runner propio en lugar de `a && b && c` porque el fallo deliberado de las reglas
de negocio cortaría las pruebas del motor, que son las que cazan bugs reales.

Las del motor cubren: 7-max completo (7 sentados, 2 cartas cada uno, sobra
baraja), 2/3/6/7/9/23 jugadores llegando a `finished`, conservación de fichas
(lo entregado coincide con lo aportado), sin cartas repetidas ni `undefined`,
rotación de botón y ciegas, y que el motor se niegue a repartir 24.

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

`table.manager.ts` gestiona una sola mesa y aplica el premio al ganador de esa
mesa. Con `fieldSize` de 50 a 500 eso no sirve. Falta el servicio de campo:
inscripción, asignación de asientos, merge, mesa final y reparto por posición
(ver §1). Depende de la decisión económica de §0.

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
1. Economía del campo  ← §0: define el RTP y de dónde sale el premio
2. Legal               ← bloquea todo lo demás
3. Plan de pago Render ← sin esto las partidas se cortan
4. Panel de operador   ← sin esto los retiros se atascan
5. TRC20 real          ← la más simple, valida el circuito completo
6. Field manager       ← sin esto el campo de 500 no existe
7. Logros/rachas/VIP   ← honestidad con lo prometido
8. EnZona + QvaPay     ← requiere cuenta de empresa
9. Resto de cadenas
```

Los puntos 1, 2, 3, 4 y 5 son los mínimos para abrir a un grupo pequeño de
usuarios de prueba. El 6 es necesario para que el producto sea lo que promete;
hasta entonces, la opción honesta es mostrar 7-max de mesa única y quitar el
"campo de 500" de la interfaz.

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
npm run test:engine

# 3. Flujo completo (requiere MongoDB)
node scripts/test-payment-flow.js
```

Dentro de Telegram: Depositar → método y monto → continuar → "Simular pago" →
saldo acreditado en `real`.

El flujo completo de pagos está escrito (`test-payment-flow.js`) pero **no se ha
ejecutado**: no hay MongoDB ni Docker en esta máquina. Debe correr en un entorno
con base de datos antes de confiar en él.
