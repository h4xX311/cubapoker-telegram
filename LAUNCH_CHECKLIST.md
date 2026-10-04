# CubaPoker · Estado de preparación para lanzamiento

Análisis del estado real del proyecto y qué falta para operar en público.
Fecha: 4 de octubre de 2026.

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

## 1. Límite físico de una mesa: 23 por mano

Esto condiciona todo el diseño de mesas y conviene tenerlo claro antes de
tocar nada más.

Una baraja son 52 cartas. Cada jugador recibe 2 y la mesa necesita 5 comunitarias:

```
(52 - 5) / 2 = 23
```

**23 es el máximo absoluto de jugadores en una mano simultánea.** Con 24 el flop
haría `pop()` sobre un mazo ya vacío.

El producto ofrece mesas de 50, 100, 300 y 500 participantes. Eso **no puede ser
una sola mano**. No existe "una mesa cash de 500 jugadores" en el poker: una mano
es una cosa que hacen 2 a 9 jugadores normalmente.

Lo que sí hacen CoinPoker y plataformas similares es una **sala** donde todos
permanecen sentados y se juega **por tandas** de hasta 23, rotando hasta que
quedan pocos. Es exactamente lo que hace `TableManager.selectHandSeats()`: cada
mano juega el grupo que toca según `hand.handNumber`, de modo que los grupos se
turnan y nadie se queda fuera indefinidamente.

```
Mesa de 500
  ┌─ tanda 1: jugadores 1-23    ┐
  │  ronda de texas hasta el     │
  │  showdown, bote y rake       │
  ├─ tanda 2: jugadores 24-46   │  una mano cada vez
  ├─ tanda 3: jugadores 47-69   │
  └─ ...                         ┘
```

Consecuencias asumidas:

- El rake se cobra **por mano**, no por mesa. En una mesa de 500 el rake total
  se repite por cada tanda, así que el rake efectivo por jugador es mayor que en
  una mesa de 9.
- El "premio garantizado" de 500 CUP significa **5 manos completas** de 23
  jugadores, no una.
- Los tiempos de espera de un turno pueden ser largos: hay hasta 23 actuantes
  entre una decisión suya y la siguiente.

**Si no es aceptable, la alternativa es cambiar el producto**: mesas de 9
jugadores (mesa final) o formato de torneo. Eso es una decisión de negocio, no
técnica, y por eso queda planteada en lugar de resuelta por mi cuenta.

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

### 2.2 Avisos de turno en lugar de spam

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

### 2.3 Saldo doble: `real` vs `play`

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

### 2.4 Verificación

| Prueba | Resultado |
|---|---|
| Build backend | limpio |
| Build frontend | 45 módulos, 201 kB |
| Cadenas y comisiones | 33/33 |
| Reglas de negocio | 36/36 |
| Motor de poker | 72/72 |
| Auth sin firma | 401 correcto |
| Flujo de pago completo | **no ejecutado** (sin MongoDB local) |

`npm test` compila y corre las tres suites. Las del motor cubren lo que
importa: que la mano llegue a `finished` con 2, 3, 6, 9 y 23 jugadores; que el
bote cuadre con lo aportado; que no haya cartas repetidas ni `undefined`; que el
botón y las ciegas roten; y que el motor se niegue a repartir 24 jugadores.

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

### 3.5 Integridad del juego — no bloquea pero conviene

- **Rake VIP no se aplica.** La página VIP promete 3%/2%/0%, el código cobra 5%
  fijo. Un usuario VIP que lo compruebe pierde la confianza.
- **Logros y rachas no se disparan.** No hay hook que los active al ganar.
- **Torneos no se ejecutan.** La lógica base existe; falta asignación de mesas ni
  reparto de premios.
- **Colusión.** Nada impide que dos cuentas coordinen. En poker de dinero real
  eso vacía la plataforma.

### 3.6 Rake en mesas grandes

Con el modelo de tandas (§1), el rake se cobra 5% **por mano**. Una mesa de 500
cobra 5% unas 22 veces sobre los mismos fichas. Conviene decidir si el rake debe
aplicarse solo a las últimas tandas, para que el coste efectivo por jugador no
crezca con el tamaño anunciado de la mesa.

---

## 4. Orden de ejecución recomendado

```
1. Legal               ← bloquea todo lo demás
2. Plan de pago Render ← sin esto las partidas se cortan
3. Panel de operador   ← sin esto los retiros se atascan
4. TRC20 real          ← la más simple, valida el circuito completo
5. Logros/rachas/VIP   ← honestidad con lo prometido
6. EnZona + QvaPay     ← requiere cuenta de empresa
7. Resto de cadenas
8. Torneos             ← solo si se mantiene el formato de sala grande
```

Los puntos 1, 2, 3 y 4 son los mínimos para abrir a un grupo pequeño de usuarios
de prueba.

---

## 5. Cómo probar el flujo ahora

```bash
# 1. Levantar con simulación
SIMULATE_PAYMENTS=true DEV_AUTH_BYPASS=true npm run dev

# 2. Suites sin base de datos
npm test

# 3. Flujo completo (requiere MongoDB)
node scripts/test-payment-flow.js
```

Dentro de Telegram: Depositar → método y monto → continuar → "Simular pago" →
saldo acreditado en `real`.

El flujo completo de pagos está escrito (`test-payment-flow.js`) pero **no se ha
ejecutado**: no hay MongoDB ni Docker en esta máquina. Debe correr en un entorno
con base de datos antes de confiar en él.
