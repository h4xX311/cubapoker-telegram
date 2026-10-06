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
5. Base de datos real  ← sin esto el campo no se ha ejecutado nunca
6. Logros/rachas/VIP   ← honestidad con lo prometido
7. EnZona + QvaPay     ← requiere cuenta de empresa
8. Resto de cadenas
```

La economía del campo ya está resuelta (§0): el premio sale del bote y el RTP
es del 95 %. No bloquea.

---

## 3-bis. Estado de los cuatro bloqueantes (5 de octubre de 2026)

| # | Bloqueante | Estado | Qué falta de verdad |
|---|---|---|---|
| 1 | Legal | **Pendiente, no se puede hacer aquí** | Un abogado. Los borradores de T&C, juego responsable y privacidad están escritos (`LEGAL/`) pero NO son asesoría legal. |
| 2 | Plan de pago Render | **Hecho en código** | Pagar los 7 USDT/mes. `render.yaml` ya dice `plan: starter`. |
| 3 | Panel de operador | **Hecho en código** | Montarlo y probarlo. Rutas en `/api/admin`, protege con `ADMIN_API_KEY`. |
| 4 | TRC20 real | **Hecho en código** | La clave de TronGrid y una dirección TRON. Las otras 4 redes siguen sin soporte real. |

### El quinto bloqueante: una base de datos - RESUELTO, y encontro bugs de verdad

**Antes:** ninguna parte del campo se había ejecutado nunca. Las 395 pruebas eran
aritmética pura y las 31 llamadas a Mongo de `field.manager.ts` no se habían
ejecutado ni una vez.

**Ahora:** hay MongoDB real corriendo y un test de integración que lo ejecuta
(`scripts/test-e2e-field.js`, 26 comprobaciones). Está documentado en
`scripts/MONGODB-LOCAL.md`.

Los servidores de descarga de MongoDB están bloqueados en esta red (403 en
`fastdl.mongodb.org`, `downloads.mongodb.com`, `downloads.mongodb.org` y
`mongodb.com`), pero los mirrors del repo apt oficial sí responden. El servidor se
instala en WSL sin `sudo`, extrayendo el `.deb` con `dpkg-deb -x`.

### Lo que encontró el test: cuatro bugs que no se ven leyendo

1. **`openField` fallaba siempre.** Escribía `buyInUnits` en un campo que el modelo
   llamaba `buyIn`. Como es `required`, el primer registro de un jugador lanzaba
   `Field validation failed`. El producto no arrancaba.

2. **Los 300 jugadores jugaban en una mesa.** `trySeat` calculaba el número de
   mesas sobre `queue.length`, y la cola se vacía al sentar a la gente: la cuenta
   nunca pasaba de 1. Habia un segundo bug: no comprobaba que la mesa estuviera
   llena, así que todos se amontonaban en la primera. 300 jugadores en una mesa de
   7, con el pot repartido sobre un número de jugadores inexistente.

3. **Dreno: las fichas del eliminado volvían a su cartera.** Comprar entrada,
   ser eliminado con las fichas intactas y recuperar el buy-in. El rake se cobra por
   mano, así que un eliminado antes de la primera mano no pagaba nada: ciclo gratis.

4. **La liquidación creaba dinero.** Pagaba un premio calculado con
   `fieldPayout(buyIn, playersRemaining)` —un bote nuevo que no salía de ningún
   sitio— y además devolvía las fichas a `balance.real`. Con 300 jugadores de
   1 USDT, el campo terminaba con **129,25 USDT más** de los que tenía.

El 4 también lo detectó la prueba: repartía `swept` sin descontar el rake, así que
devolvía los ingresos de la plataforma. Ahora reparte `min(swept, buyIns − rake)` y
fija `rakeCollected` a `grossPot − repartido`, para que la contabilidad del campo no
pueda desviarse de la del dinero.

**La invariante que ahora se comprueba en cada ejecución:** el saldo total del
sistema tras liquidar es exactamente el inicial menos el rake. Ni un centavo más,
ni un centavo menos.

### Lo que el test de integración todavía no cubre

- Que el motor juegue bien **con los bots** a lo largo de un campo entero. Se
  liquida a mano: no se juega una sola mano.
- Las **merges** entre mesas.
- El apagado ordenado con un campo a medias.

Los tres se pueden cubrir con este mismo Mongo, llamando al motor de verdad. Ese es
el siguiente paso.

### Lo que se cerro en codigo y conviene no deshacer

Tres drenos y un fallo de infraestructura, con sus pruebas:

- **`standUp` devolvia el buy-in** a quien entraba en una mesa de campo y salia.
  Ahora `sitDown` y `standUp` rechazan cualquier mesa con `field.fieldId`.
- **`/game/sit` entraba a los campos por la puerta de atrás**, sin pasar por la
  cola: `playersRemaining` no se incrementaba y las posiciones se descuadraban. La
  interfaz usa ahora `/fields/:tierId/register`.
- **`settleWithdrawal` hacia `$inc` sin filtro.** El saldo se consume al aprobar,
  no al pedir, asi que entre pedir y aprobar el jugador puede jugar y vaciar su
  `balance.real`; el `$inc` lo dejaba en negativo y cada retiro era una forma de
  sacar doble. Ahora el filtro es `{ 'balance.real': { $gte: amount } }`.
- **El plan `free` de Render suspende a los 15 min.** Con un campo de 500
  jugadores en marcha, eso deja fichas bloqueadas y un webhook de pagos sin
  responder. Cambiado a `starter`.

---

## 3-bis-bis. Sesion del 6 de octubre: botes laterales y la liquidacion

Cuatro cosas. Las dos primeras son bugs de dinero ya cerrados con pruebas. Las
dos ultimas son hallazgos que quedan abiertos y que hay que decidir antes de
abrir al publico.

### 1. EL MOTOR REPARTIA EL BOTE ENTERO. Sin botes laterales. CERRADO

El motor dividia el bote a partes iguales entre los ganadores de la mejor mano,
sin mirar cuanto habia puesto cada uno. Eso es robar fichas en cuanto dos
jugadores stack distinto:

    A se all-in por 100    B se all-in por 500    C tiene 5 000 e iguala 500

    bote principal   100 x 3 =   300   elegibles A, B, C
    bote lateral     400 x 2 =   800   elegibles B, C

Si ganaba A se llevaba los 1 100 enteros, cuando solo puede tocar los 300. Un
all-in minimo se llevaba el bote de dos stacks cinco veces mayores.

En un campo esto no es una excepcion: los eliminados se all-in por fichas
pequenas y los que sobreviven acumulan stacks enormes. Medido en el test de
integracion, stacks de 5 630 contra eliminados con 11. **Cada eliminacion del
producto era un all-in minimo compitiendo por un bote enorme.**

Ahora `src/game/sidepots.ts` parte el bote en tramos segun lo aportado y cada
tramo lleva la lista de quien puede ganarlo. 27 pruebas, con 52 480 repartos
comprobados. Suite unitaria: 422.

Detalle que salio mal y quedo documentado: primero se sacaba al ganador de un
bote de los botes siguientes. Es intuitivo y es un error doble: da el lateral al
que no le toca, y deja el ultimo tramo sin dueño, con lo que esas fichas se
evaporan. La elegibilidad por tramo ya impide el robo sin necesidad de expulsar
a nadie.

### 2. LA LIQUIDACION NO BARRABA TODO EL DINERO, Y DISIMULABA LO QUE FALTABA. CERRADO

Cuatro fallos en `settleField`, del mismo tipo: se mira una parte del dinero y
se olvida de otra, y luego la diferencia se convierte en ingresos.

| # | Fallo | Como se manifestaba |
|---|---|---|
| 1 | `hand.pot` no se barreaba | El bote de una mano en curso no se pagaba ni se ponia a cero. Las fichas desaparecian. |
| 2 | `seat.bet` y `hand.pot` son las mismas fichas | Sumarlos contaba el bote dos veces. Creaba dinero. |
| 3 | `deadChips` no se ponia a cero | Se pagaba a los jugadores y el campo seguia diciendo que lo tenia dentro. Contaba dos veces. |
| 4 | `rake = bote - repartido` | Con fichas perdidas, la fuga se apuntaba como ingreso. |

El 4 es el que hacia parecer que el producto funcionaba. En el test de
integracion dio **un rake de 7 417 sobre un bote de 14 000: un 53 % en vez del 5 %
documentado**. El mes salia bien porque se estaba cobrando como rentabilidad una
fuga de dinero.

Convertir un bug en ingresos es lo peor que puede hacer la contabilidad: tapa el
problema y encima el numero mejora. Ahora el rake se queda en el 5 % real y la
falta se avisa como ERROR con las cifras.

El 2 tiene un detalle que hace que el arreglo rapido sea peor que el bug: no vale
anadir `hand.pot` al `seat.bet` de siempre, porque `syncEngineToTable` escribe
`seat.bet = player.bet` y `hand.pot = state.pot`, y el bote **es** la suma de lo
que puso cada uno. Hay que quedarse con el mayor de los dos, que es lo unico que
funciona en los tres estados posibles: mano en curso, mano recien terminada
(`endGame` vacia el bote pero `player.bet` sigue entero) y mesa en reposo.

`scripts/test-settle.js` monta este caso con las cifras exactas y lo liquida en
**30 segundos**, en vez de jugar un campo entero de 20 minutos para averiguar por
que no cuadraba. 18 comprobaciones, incluido el caso de fichas ausentes.

### 3. LAS MESAS CASH NO COBRAN RAKE. ABIERTO, HAY QUE DECIDIR

`finishHand` calcula el rake por mano desde `state.pot`, pero `endGame` ya lo
ha puesto a 0 antes de que se llame. Los dos caminos que ponen la fase en
`showdown` pasan por `endGame`. O sea que ese bloque **no se ejecuta nunca**:
`table.stats.rakeCollected` se queda en 0 y el panel de operador no muestra rake
de las mesas cash.

**Pero no es un bug de una linea**, y por dos motivos:

1. El motor reparte el bote **antes** de que la mesa pueda cobrar su parte. Para
   que el rake sea real hay que tomarlo dentro del motor, antes de formar los
   botes laterales. Si se toma despues, los botes laterales se forman sobre un
   bote que ya incluye el rake y el reparto sale mal.
2. `table.kind === 'cash'` en un campo significa "campo de pago", no "mesa de
   dinero". Es decir: ese bloque, si llegara a ejecutarse, cobraria rake por mano
   **y despues** `rakeOfField` cobraria el 5 % del campo entero. **Doble rake.**
   Por eso el codigo usa `max(collected, objetivo)` y no la suma.

O sea: el bloque muerto es lo que evita hoy un doble cobro, y una mesa cash
suelta no tiene ninguna via alternativa que cobre el rake. Hay que decidir el
modelo antes de tocarlo. **No se arregla sin decidir.**

### 4. SE PIERDEN JUGADORES DE LAS MESAS. ABIERTO

El bug mas grave que queda abierto, y el que mas afecta a un jugador de verdad:
**4 de los 14 jugadores de un campo desaparecen de las mesas sin que nadie los
recoja.** No tienen posicion adjudicada y no estan en ninguna mesa. Sus fichas
se van con ellos.

Lo que se sabe:

- No es al eliminar: los que desaparecen no tienen posicion adjudicada.
- Es al sentar, o justo despues.
- El reconciliador (`reconcileAliveCount`) lo detecta y avisa con los
  identificadores, pero **corrige el contador, no recupera al jugador**: el
  dinero sigue perdiendose.

En el ultimo test: 14 registrados, `vivos` decia 14 y habia 12 en las mesas; al
terminar, de 14 solo 10 accounted. El desfase de la contabilidad era de 6 577
unidades, y el bug 3 de la liquidacion lo disfrazaba de rake del 53 %.

**Es el siguiente paso.** Es tambien justo el problema para el que serviria leer
el modulo MTT de `masterai-top/TexasHoldem-Poker-Complete-Solution` como
referencia: ahi el conteo de vivos y la fusion de mesas estan hechos de otra
forma, y comparar las dos implementaciones diria cual de las dos se equivoca.

---

## 3-bis-tercis. Tarde del 6 de octubre: el dinero ya no se pierde

Tres bugs mas, los tres de dinero, y los tres encontrados por pruebas que corren en
menos de un minuto en vez de por el test de integracion de veinte minutos.

### 5. DOS JUGADORES CON EL MISMO INDICE DE ASIENTO. CERRADO

Tres sitios asignaban el indice de un asiento como `seats.length`: `buildSeat`,
`checkMerges` y `forceMergeIntoOne`. Eso solo vale si los indices son 0, 1, 2, 3...
sin huecos, y en un campo dejan de serlo en cuanto se libera un asiento: el eliminado
se marca `out`, `finishHand` lo quita del array, y los demas conservan su indice. Una
mesa de 7 sin el asiento 2 queda con [0, 1, 3, 4, 5, 6]: `seats.length` dice 6, pero
el 6 ya esta ocupado.

El indice de asiento es la IDENTIDAD del jugador dentro del motor. Con dos asientos en
el mismo indice, el motor registra dos jugadores con el mismo id, `performAction`
actua siempre sobre el primero (el segundo no juega nunca) y `syncEngineToTable`
escribe las fichas sobre el primero (las del segundo no se escriben). Ese asiento queda
huerfano: `isSeated` lo ve ocupado, nadie lo vuelve a sentar, y el campo se queda con
un jugador invisible y fichas quietas.

Visto jugando: la mesa final con los indices [1, 2, 3, 3, 4] y 12,98 USDT congelados
durante 2 500 rondas.

Arreglado con un unico sitio que decide el indice (`primerIndiceLibre`) y un aviso
con nivel ERROR si alguna vez se repite uno. No se renumera la mesa entera a proposito:
`field.results` guarda el indice de cada eliminado, y un resultado que apunta al
asiento 3 cuando ese 3 era otro jugador es peor que un hueco.

### 6. LAS FICHAS DE UN ELIMINADO SE BORRAN AL SOLTAR SU ASIENTO. CERRADO

El mas grave de los tres, y el mas dificil de ver.

`collectEliminations` deja **a proposito** las fichas del eliminado en su asiento. El
comentario del propio codigo lo dice: *"No se ponen a cero aqui: desaparecerian de la
contabilidad y el campo devolveria menos de lo que cobro."* La idea era que las
recogiera `settleField` al final.

Pero entre una cosa y otra el asiento se marca `out` y se suelta del array, y las
fichas se van con el. Para cuando le toca a `settleField` de barrer el bote, ya no
estan en ningun sitio.

**2 155 unidades de 14 000: el 15 % del bote se evaporaba.** Ocho eliminados, unos 270
cada uno. El campo se liquidaba igual y los premios se pagaban, asi que nadie se
enteraba: el dinero se perdia sin dejar rastro.

Que no lo detectaran los tests anteriores tiene una razon concreta: el fallo del rake
(que convertia la fuga en ingresos) tapaba exactamente esta parte. Arreglado uno, el
otro se ve.

Habia **dos** sitios que destruian fichas al soltar un asiento `out` (el del field
manager cuando la mesa esta en reposo, y el de `finishHand` al acabar la mano). Los
dos hacen ahora lo mismo: `liberarAsientosLiquidados` pasa las fichas a
`Field.deadChips` antes de quitar el asiento. Es lo que hace falta para que las fichas
del eliminado SEAN del bote, que es lo que decia el comentario original y nunca
ocurrio.

### 7. EN SIMULACION SE PODIA APROBAR UN RETIRO Y PAGARLO DE VERDAD. CERRADO

Este lo ha pedido el modo de lanzamiento elegido, y es el mas caro de los tres si se
produce.

`POST /api/admin/withdrawals/:orderId/approve` **no mueve dinero**: marca la orden
como pagada y descuenta el saldo, porque el envio lo hace el operador por fuera. En
simulacion no habia ninguna proteccion, y una orden simulada en el panel es
**indistinguible** de una de verdad. El operador veia "liquidado" y mandaba USDT.

Eso no es un descuadre contable: es dinero real pagado a cambio de nada.

El freno va en `settleWithdrawal` para que cubra cualquier llamante, y hacen falta
**dos** condiciones: `ALLOW_SIMULATED_WITHDRAWALS=true` en el entorno (deliberado, no
un efecto secundario de arrancar el sistema) y `confirmarSimulado: true` en cada
peticion. Con una sola, la otra se cumple sola.

Los depositos **no** llevan freno: acreditar saldo de prueba es justo lo que se quiere
en simulacion y no mueve nada.

---

### Donde estamos con el dinero

| Prueba | Que cubre | Tiempo |
|---|---|---|
| `scripts/run-tests.js` | 395 unitarias de aritmetica pura | 20 s |
| `scripts/test-sidepots.js` | 52 480 repartos de botes laterales | 5 s |
| `scripts/test-settle.js` | la liquidacion del campo | 30 s |
| `scripts/test-seat-index.js` | indices de asiento y fusiones | 30 s |
| `scripts/test-eliminado.js` | las fichas de un eliminado | 30 s |
| `scripts/test-sim-guard.js` | el freno de simulacion en retiros | 30 s |
| `scripts/test-e2e-field.js` | 26 comprobaciones contra Mongo | 2 min |
| `scripts/test-e2e-engine.js` | un campo entero jugado por bots | 20 min |

Los seis primeros tardan menos de un minuto cada uno. Los tres ultimos necesitan
MongoDB de verdad. La regla que se ha seguido: **si un fallo se puede montar con
cifras exactas, se prueba con cifras exactas, no jugando el campo entero.**

## 3-bis-cuarta. El campo se queda en 2 jugadores. Estado exacto

No es un balance de lo que funciona: es una nota de traspaso. Lo que se ha descartado,
lo que queda, y por donde seguir.

### LO QUE SI ESTA VERIFICADO

- **El dinero cuadra.** "Ninguna invariante se rompio en ninguna ronda", en las 12 000
  rondas del ultimo test. Nueve bugs de dinero cerrados y verificados.
- **El rake es el 5 % real**, no el 53 % que salia antes.
- **Las mesas cierran limpiamente** y liberan los asientos `out`.
- **La eliminacion funciona**: el campo baja de 14 jugadores a 2, con 12 de las 13
  posiciones adjudicadas sin repetir ninguna.
- **100 228 turnos de humano** con la IA de produccion, no atajos.

### EL ESTADO EXACTO

El campo se queda con 2 jugadores vivos y un tercero sentado marcado `eliminated` con
cero fichas, sin adjudicar:

    campo: status=final seated=14 vivos=2 eliminated=12 deadChips=0
      t1: 4:active:7704   0:ELIMINATED:0   1:active:6281     mano=11998  fase=idle
      t2: 5 asientos `out`, status=finished

### LO QUE SE HA DESCARTADO, Y COMO

| Hipotesis | Como se ha descartado |
|---|---|
| `startHand` no arranca la mano | Aviso instrumentado: 0 disparos en 8 000 ciclos |
| `startGame` devuelve false | Sale un ERROR en ese caso: 0 errores en todo el log |
| El bot no puede jugar y cuelga la mesa | Aviso instrumentado: 0 disparos. Corregido igualmente |
| `processTable` revienta antes de llegar | 0 "Error procesando mesa" |
| La IA es demasiado pasiva | 6,9 acciones por mano: las manos llegan al showdown |
| El reloj de los humanos les roba el turno | **Era cierto.** Corregido: 82 630 -> 100 228 turnos |
| El reconciliador resucita eliminados | **Era cierto.** Corregido: ya no sube el contador |
| Faltan fichas por el camino | Conservado en las 12 000 rondas |

### LO QUE QUEDA

Un unico hecho, y es el que bloquea: **el asiento `eliminated` con cero fichas no lo
recoge `collectEliminations`**. Si lo recogiera, el contador bajaria a 1 y
`checkCompletion` liquidaria.

Por que no lo recoge es lo que no esta resuelto. Las dos razonables:

1. `collectEliminations` se ejecuta sobre una copia de la mesa leida antes de que el
   gestor de mesas marcase el asiento `eliminated`, y para cuando vuelve a mirar ya no
   lo ve. Es una carrera entre los dos gestores, y es el mismo tipo de problema que las
   otras tres veces de hoy.
2. El filtro de asientos que usa `collectEliminations` exige algo mas que
   `status === 'eliminated'` (por ejemplo `hand.phase === 'idle'`, o que la mesa no
   tenga ninguna mano viva), y el asiento no lo cumple.

### POR DONDE SE SIGUE

Instrumentar `collectEliminations` con una linea por ciclo: cuantos asientos ve, cuantos
cualifican por cada filtro, y por que descarta el que queda. Es la misma tecnica que
destapo el bug del bot y el del reloj, y las dos veces fue una sola linea que decidia si
un asiento cuenta o no.

Alternativa, si se quiere atajar antes: **que `collectEliminations` no dependa de una
copia**. Que lea los asientos con una consulta dirigida a los que estan `eliminated` y
con cero fichas, en vez de recorrer las mesas que le llegaron antes.

### LO QUE NO SE DEBE HACER

No tocar los limites ni el reloj del test para que pase. El campo tarda del orden de
3 700 manos en dejar a un jugador en una mesa, con varianza enorme (la misma mesa ha
terminado en 39 manos y en 3 713). Subir el limite a ojo solo mueve el sitio donde
falla.

Y no volver a poner una red que escriba sobre el contador de otro gestor: las tres
regresiones de hoy han salido de ahi (`field.tables`, el reloj, y el reconciliador).
Una red que "corrige" al dueño de la fuente de verdad es la causa, no el remedio.

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
cifras exactas, se prueba con cifras exactas, no jugando el campo entero.**
