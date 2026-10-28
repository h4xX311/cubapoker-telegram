# Decisiones tomadas · 7 de octubre de 2026

Dos decisiones que cambian el producto y que **no se pueden volver a interpretar después**.
Están aquí para que la siguiente sesión no las vuelva a preguntar ni las deshaga sin querer.

---

## 1 · Las ganancias hechas con saldo de promoción SÍ son retirables

**Decisión:** el saldo de promoción (`balance.play`) **no se puede retirar**. Pero **lo que ganas usándolo sí**.

Es el modelo estándar de un bonus con *wagering*: lo que te dan de regalo no se retira, pero
lo que produces con él es tuyo.

```
Compras fichas de promoción  →  no retirable
Ganas con esas fichas        →  RETIRABLE, al 100 %
```

Y ya hay una parte de esto funcionando: al usar fichas de promoción para comprar entrada, se
desbloquea 1 de cada 10 al saldo real (`splitBuyIn` + `unlock.service`). Eso convierte
"no retirable" en "retirable por uso", que es el mismo modelo.

### Por qué está en `LEGAL/IMPLEMENTATION.md`

Porque **esto cambia lo que se promete al usuario**. Un texto que dice "el saldo de promoción
no es retirable" y otro que dice "el saldo de promoción no es retirable, pero lo que ganas
con él sí" **no son lo mismo**, y el segundo es el que hay que publicar.

Anotado como pendiente de verificación: hay que comprobar que el camino del **premio** (no el
de la compra) acredita a `balance.real`. Hoy solo se ha verificado el lado de la compra.

---

## 2 · "Campos cash" pasan a ser Ring tables

**Decisión:** las mesas de cash son **ring tables**, como en CoinPoker. Los torneos van aparte.

### Lo que significa

| | Antes | Después |
|---|---|---|
| **Cash** | "Campos cash": un **campo de 300 jugadores** al que te apuntas y esperas | **Ring table por nivel**: te sientas, compras fichas, juegas, te levantas |
| **Torneos** | Mezclados en el mismo sitio | Pestaña propia |
| **Freerolls** | Junto a todo lo demás | Pestaña propia |

### Por qué

Porque una ring table **ya funciona**: `cash-t1` es exactamente eso, y el jugador ya se sentó
y jugó una partida contra bots dentro de Telegram.

Lo que sobra es **presentarla como un campo de 300**. El efecto en el jugador era el siguiente:
entendía que compraba una mesa y estaba entrando en un torneo que no se llenaba nunca. De ahí
el "sentando y más nada".

Es también lo que hace CoinPoker, donde Cash Games son ring tables por nivel y los torneos
tienen su propia sección.

### Cómo queda el lobby

```
CUBA POKER                        [ Depositar ]  [ 4,986 USDT ]

[ Cash Games ]   [ Torneos ]   [ Freerolls ]

CASH GAMES
 ┌──────────────────────────────────────────────────────────────┐
 │ 5/10     buy-in 1 USDT    4/6 jugadores     Bote medio 35     Jugar │
 │ 25/50    buy-in 5 USDT    3/6 jugadores                       Jugar │
 │ 125/250  buy-in 25 USDT   2/6 jugadores                       Jugar │
 └──────────────────────────────────────────────────────────────┘
```

Con un botón **"Estás jugando aquí →"** arriba, que es lo que hoy **no existe** y por eso el
jugador no sabe si está sentado ni cómo volver.

### Lo que falta decidir todavía

**Las ciegas de los niveles.** Ahora la mesa es `5/10` con buy-in de 1 USDT: son 0,005/0,01
USDT de ciegas, muy bajo para poker real. CoinPoker empieza en **1/2 USDT** con buy-in de
~100. Es una decisión de producto y de dinero, no técnica.

---

## 3 · Qué pasa con el dinero cuando un campo se cancela

**Decisión del 7 de octubre.** Depende de si el campo tiene premio real:

### Campo de práctica (sin premio real) → **A: recupera todo el mundo**

Sentados y eliminados por igual.

El campo no repartía nada real, así que no hay premio que respetar y nadie tiene por qué
perder. Es un ensayo: si se interrumpe, no pasa nada.

### Campo con premio real → **B: respeta el poker**

- Los que **siguen sentados** recuperan su buy-in.
- Los **eliminados no**: sus fichas ya fueron al bote.

Es la regla de un torneo de verdad. Un jugador que sale eliminado en la calle 3 no puede
quedar además con el buy-in intacto, porque el bote se quedaría corto y el premio se
pagaría con dinero que no salió de él.

### Por qué se decide por campo y no siempre igual

Porque en el caso A **no hay nada en juego**. Regalar el dinero a todos en un torneo de
práctica es lo correcto. Regalar el dinero a todos en un torneo con premio es fabricar dinero
y la plataforma paga de su bolsillo.

Que el campo diga cuál de los dos es, en el propio campo, y no lo que adivine el código.

### Follow the rake

Pendiente de decidir: el `rakeCollected` de un campo cancelado, ¿se queda la plataforma o se
devuelve con las fichas? No se ha tocado.

---

## 4 · Freerolls

**Decisión:** cuatro freerolls diarios, multi-mesa y gratuitos, con premios de
**5, 10, 20 y 50 USDT** según la franja UTC. El premio se reparte 50/30/20 entre
las tres primeras posiciones y va entero a **saldo de promoción**.

### Reglas

| | |
|---|---|
| Horario | 00:00, 06:00, 12:00 y 18:00 UTC |
| Entrada | Gratis. No cobra buy-in ni rake |
| Fichas | 1.000, ciegas 5/10 |
| Aforo | Hasta 900 jugadores en mesas multi-mesa |
| Mínimo para arrancar | 2. Con un humano se rellena la mesa hasta 2 |
| Sin nadie | Se cancela: no se paga un torneo de bots con dinero de la casa |
| Registro tardío | Hasta 12 minutos después del inicio |
| Premio | `premioDelSlot()`: 5, 10, 20 o 50 USDT |
| Reparto | 50 % / 30 % / 20 % (`FREEROLL_PAYOUT`) |
| Destino | `balance.play` (promoción), no retirable directamente |

El campo lleva `tierId = freeroll-<clave>`. El índice único parcial
`un_campo_vivo_por_nivel` impide que dos peticiones simultáneas abran dos campos
del mismo slot.

### Por qué el premio va a promoción

Es dinero de la casa, no de otros jugadores. Si fuera retirable, cada franja
sería una extracción directa sin que nadie hubiera puesto dinero. En promoción
se juega y se desbloquea con el mecanismo existente (1 de cada 10). Queda
registrado en `stats.totalFreerollWon` para que el jugador lo vea.

### Por qué se cancela cuando no hay nadie

Rellenar con bots un torneo vacío y pagar el premio al ganador es pagar por
nada. El relleno con bots existe para que **un humano** no se quede esperando
solo: con cero humanos no hay a quién entretener.

### Presupuesto

Las cuatro franjas suman **85 USDT diarios** en premios. Es un gasto de la casa
y se controla desde `FREEROLL_PRIZES`; si cambia el presupuesto, cambia el
catálogo, no la lógica de pago.

---

## 5 · Centrolls (retirados)

**Decisión:** el producto ya no ofrece centrolls. El catálogo visible solo abre
**torneos y freerolls**, y no queda ninguna ruta pública para crear un campo de
centroll, cobrar su buy-in ni liquidarlo.

Los centrolls fueron útiles para validar el bucle de entrada y el pago a saldo
de promoción, pero competían con los freerolls, añadían una tercera economía y
hacían más difícil explicar el producto. Su código, sus pruebas y sus comandos
se retiraron en la iteración del 28 de octubre de 2026.

Los torneos usan buy-in en USDT y premios garantizados; los freerolls son
gratuitos y reparten 5, 10, 20 o 50 USDT según la franja UTC. El cash y la VIP
Arena conservan su propia economía y su propio rake.

---

## 6 · Actualización del 24 de octubre de 2026

### 6.1 · Cash: tres formatos por sala

Cada sala y nivel tiene **NLH 7-max, NLH 6-max y Heads-Up**. Son ring tables, no campos: el
jugador se sienta y se levanta cuando quiere. PLO, PLO5, PLO6 y Short Deck quedan fuera hasta
que exista un motor de variantes; prometerlos antes sería vender una mesa que no se puede
jugar.

`formatId` viaja en la mesa y en `/game/sit`. Las mesas antiguas sin `formatId` se tratan
como 7-max para no romper datos.

### 6.2 · Rake cash: 5 % con tope por sala y solo con flop o 3-bet

El rake de las ring tables es el **5 % del bote**, pero no se cobra en una mano resuelta
preflop con un raise normal: solo si hubo flop o una 3-bet preflop, como CoinPoker. El tope
es por mano y depende de la sala y de cuántos jugadores recibieron cartas (heads-up, 3-4,
5+). Se toma de la tabla pública de CoinPoker.

Sin esto, el tope global de 100 unidades (0,10 USDT) convertía las mesas altas y VIP Arena en
mesas sin rake: un bote de 20.000 USDT pagaba 0,10 USDT. Los topes ahora son:

| Sala | Ciegas USDT | HU | 3-4 | 5+ |
|---|---:|---:|---:|---:|
| Micro | 0,005 / 0,01 | 0,025 | 0,06 | 0,10 |
| Bajo | 0,025 / 0,05 | 0,13 | 0,30 | 0,50 |
| Medio | 0,125 / 0,25 | 0,50 | 1,20 | 2,00 |
| Alto | 0,50 / 1,00 | 1,25 | 3,00 | 5,00 |
| VIP Arena | 50 / 100 | 50 | 60 | 60 |

Las mesas de un campo (torneo o freeroll) no son cash ring y no usan esta regla: su
economía ya está definida por el campo.

### 6.3 · Retiro: 5 USDT fijos

El retiro cobra **5 USDT fijos**, como CoinPoker, con mínimo de 10 USDT y máximo de 25.000.
No es un porcentaje. Si el coste real de red es menor que 5 USDT, la diferencia queda en la
casa; si el importe es menor que la comisión, se cobra como máximo el importe disponible
(`min(amount, 5 USDT)`).

El fee de red es un **coste interno**, no un segundo cobro al jugador. La UI muestra comisión
y neto antes de confirmar.

### 6.4 · QVA-Bet Club: membresía con rakeback, no descuento de rake

`QVA-Bet Club` es el **programa de membresía**, igual que el 3-Bet Club de CoinPoker. El club
no se compra: se activa un **plan** dentro de él. El plan mensual se llama `QVA Member`; el
trimestral se llama `QVA Premium` y nunca `VIP Premium`.

Se abandona el descuento de rake. La membresía reparte un porcentaje del rake que el jugador
generó:

| Plan | Precio | Duración | Rakeback | Power Ups | Torneos |
|---|---:|---:|---:|---:|---:|
| Mensual (QVA Member) | 35 USDT | 30 días | 10 % | 6 | — |
| Trimestral (QVA Premium) | 100 USDT | 90 días | 10 % | 18 | −5 % |

Reglas de dinero:

- Solo cuenta el rake de **mesas cash ring**. Torneos y freerolls no generan rakeback.
- El rake de cada mano se atribuye a los humanos en proporción a lo que aportaron al bote
  (`seat.totalBet`). Los bots no generan rakeback.
- Se paga la **semana anterior**, los lunes UTC, a `balance.real` (retirable).
- `RakebackPayout` tiene índice único `{telegramId, weekKey}`. Un jugador no puede cobrar dos
  veces la misma semana, ni con dos clics ni con dos procesos.
- El registro se crea `pending` antes de acreditar. El crédito y la marca de la semana se
  escriben en el **mismo** `findOneAndUpdate` sobre `User.payoutCredits`; por eso un pago
  `pending` o `failed` se puede reintentar sin pagar dos veces. Si el proceso murió después
  de acreditar, el reintento lo detecta y solo marca `paid`. Los registros anteriores a
  `creditKey` no se reintentan solos: sin la clave no se puede demostrar que el dinero no
  entró.
- Una membresía que venció esta semana **todavía cobra** la semana pasada. No se borra el
  documento al vencer; borrarlo era perder el pago del lunes.
- Renovar suma días al final; no reinicia el periodo que le quedaba.
- El porcentaje contratado se guarda en la membresía y no se cambia retroactivamente si
  mañana cambian los planes.

El job corre al arrancar y cada 6 horas. También se puede cobrar desde la pantalla Membresía;
ambos caminos usan la misma operación idempotente.

### 6.5 · VIP Arena: una sala, no una membresía

En CoinPoker, **VIP Arena es una sala de cash**, no un plan que se compra. Se corrigió el modelo:
el plan `elite` desapareció de QVA-Bet Club y VIP Arena pasó al lobby de cash.

- Ciegas **50/100 USDT**, buy-in **10.000 USDT** (100 BB) y formatos 7-max, 6-max y Heads-Up.
- No hay precio de acceso ni botón de compra. Se entra con el buy-in, como en cualquier mesa.
- Los jugadores reciben un **profit share semanal del 15 %** del rake que generaron en esa sala,
  pagado los lunes UTC a `balance.real`.
- Es un programa aparte de QVA-Bet Club y las dos bolsas no se suman: el 10 % de la membresía
  se paga solo sobre mesas cash normales, y el 15 % de Arena se paga solo sobre el rake de esa
  sala. Un miembro que juegue Arena recibe el 15 %, no el 25 %. Los pagos se guardan en
  `ArenaPayout`, con índice único `{telegramId, weekKey}`, separado de `RakebackPayout`.
- El reintento de Arena usa la clave `arena_profit_share:YYYY-MM-DD`, distinta de la de
  QVA-Bet Club. El mismo jugador puede cobrar ambas bolsas la misma semana sin que una bloquee
  a la otra ni se acredite dos veces.
- El job de los lunes paga ambos programas. Un fallo en uno no cancela el otro.
- No hay lista de "miembros de Arena": la elegibilidad nace de haber generado rake en la sala.
  La selección curada de CoinPoker se puede añadir después con invitaciones, sin vender acceso.
- En la Mini App son dos pantallas distintas y con nombres distintos: `/membership` es la
  membresía QVA-Bet Club y `/vip` es la sala VIP Arena. La primera vende planes; la segunda
  solo explica la sala, muestra el profit share y enlaza al lobby de cash. Ninguna pantalla
  presenta Arena como un plan ni la membresía como acceso a la sala.

### 6.6 · Torneos pagados y Spin & Go

El buy-in va ligado al premio garantizado, como en CoinPoker:

| Evento | Buy-in | Garantizado | Plazas | Reparto |
|---|---:|---:|---:|---|
| Daily Micro | 1 USDT | 100 USDT | 120 | 45/25/15/9/6 |
| Daily Main | 5 USDT | 500 USDT | 150 | 45/25/15/9/6 |
| Weekly Major | 25 USDT | 2.500 USDT | 180 | 45/25/15/9/6 |
| Spin & Go | 1 / 5 / 25 USDT | 2,85 / 14,25 / 71,25 USDT | 3 | 100 % |

- Los stacks y las ciegas internas se muestran como **puntos del torneo**; el buy-in y el
  premio se muestran en **USDT**. El jugador nunca compra puntos con el monedero.
- El premio se paga en `balance.real` (retirable). La garantía se calcula con las entradas
  cobradas menos el 5 % de rake; si no se cubre, la diferencia es **overlay de la casa** y se
  registra en `Field.overlayUnits`. El overlay es un gasto, no saldo inventado.
- Los torneos pagados **no se rellenan con bots**. Arrancan a su hora con dos humanos como
  mínimo; un Spin & Go arranca al llenar sus tres plazas. Si al cerrar el registro tardío (12
  minutos) no hay dos humanos, se cancela y se devuelve el buy-in.
- El registro tardío sienta con el stack inicial completo y se cobra una sola vez.
- El plan QVA Premium anuncia un 5 % de descuento en torneos. Se aplica al cobrar la entrada;
  el importe realmente cobrado se guarda en `registrations.buyIn` y es el que se devuelve si
  el torneo se cancela.

### 6.7 · Multimesa, relojes y replay del all-in

- Un jugador puede tener varias mesas cash abiertas. La fuente de verdad son los asientos;
  `activeTableId` solo sirve como pista de reconexión. `GET /game/my-tables` devuelve stack,
  fase, ciegas, bote y plazos de cada mesa, y la barra superior permite entrar con un toque.
- Cada avatar muestra el tiempo de decisión del jugador que tiene el turno, no solo el propio.
  El plazo viaja a todos los espectadores de la mesa y el timeout ejecuta una acción real del
  motor, no una acción simulada por el cliente.
- Entre manos hay una pausa de 6 s (12 s si hubo all-in), configurable con `HAND_PAUSE_MS` y
  `ALLIN_HAND_PAUSE_MS`, para que se vean ganador, muck y showdown.
- En un all-in se muestran las cartas y la equidad por calle. Las probabilidades son Monte
  Carlo con semilla determinista; en el river el ganador sale al 100 % y el perdedor al 0 %,
  con la carabelita. Si hay empate, el 100 % se reparte entre los ganadores.

### 6.8 · Lo que sigue siendo una decisión abierta

- PLO/PLO5/PLO6/Short Deck: requieren motor de variantes.
- Juegos de práctica con play chips y Level Up Freerolls: aún no implementados.
- Pasarelas reales de depósito/retiro: requieren cuenta de empresa y credenciales; hoy se
  simulan.
- Validación con Telegram real y token de @BotFather: pendiente.

---

## 7 · Bots y salida de mesa: reglas que no se tocan

### 7.1 · Los bots no se anuncian

`toPublicTable` no envía `kind`, `botProfile` ni identificadores internos del
asiento. La vista pública solo lleva nombre, avatar, fichas, apuesta, estado y
acciones. Los bots usan nombres y avatares del catálogo común; nunca un avatar
exclusivo de miembro ni una etiqueta que insinúe que son bots.

### 7.2 · Deciden con precio, no con una lista fija

La IA usa fuerza de mano, **pot odds** y proyectos de color/escalera:

- Aire contra un bote grande se retira; 7-2 no paga cualquier cosa.
- Una pareja débil o un proyecto no se trata como aire: puede igualar o
  semi-farolear.
- Una mano fuerte no se retira por precio; con un bote grande puede meter el
  stack para que el torneo avance.
- Con pocos jugadores sube la presión y se amplía el rango de subida.
- El retardo de decisión sigue siendo variable; no hay un metrónomo.

El objetivo no es que los bots ganen, sino que no se puedan leer en dos órbitas.
La prueba `test-bot-pace.js` mide el ritmo y las decisiones; la de `test-cash`
mide que el dinero de las manos cuadre.

### 7.3 · No se quita un asiento a mitad de mano

`standUp` rechaza con 409 mientras `hand.phase` no sea `idle` o
`idle-awaiting`, aunque la apuesta viva sea cero. Quitar el asiento y
reindexar la mesa dejaría al motor en memoria apuntando a índices viejos y la
mano seguiría con los jugadores equivocados.

Los timers de bots releen la mesa dentro del cerrojo y comprueban que la mano
no haya cambiado. Sin eso, un `setTimeout` guardaba una copia vieja y producía
`VersionError` justo cuando el jugador se levantaba o el tick avanzaba.

### 7.4 · Freerolls y torneos también se procesan

`tableManager.tick()` consulta `cash`, `freeroll` y `tournament`. Antes solo
buscaba `cash`, así que un freeroll se llenaba de jugadores y se quedaba en
`idle` para siempre, sin repartir una sola carta. El relleno automático de bots
sigue limitado a ring cash; en los campos los pone el gestor del campo al
arrancar.

---

## 8 · Unidades enteras y conservación de fichas

**Decisión:** las ciegas, los stacks, las apuestas y el rake son **unidades
enteras**. No existe media ficha. El motor rechaza una mesa con ciegas
fraccionarias al construirla, en lugar de aceptarla y descubrir el descuadre
cuando ya hay dinero dentro.

### 8.1 · Por qué

Las unidades internas son milésimas de USDT. Una ciega de 12,5 unidades no es
representable en el ledger: cualquier división posterior produce fracciones y
el reparto deja de cuadrar. La primera versión del test de conservación generó
por error una ciega pequeña de 12,5 y encontró el síntoma; el motor ahora lo
rechaza en la puerta.

El rake ya se calcula con `Math.floor`: **nunca se redondea hacia arriba**.
Cobrar una unidad de más en una mano es un bug de dinero; cobrar una de menos
es una decisión conservadora y se queda en la casa. El tope por mesa se aplica
después del redondeo.

### 8.2 · Invariante

Para cada mano:

1. El total inicial es la suma de los stacks de todos los jugadores.
2. Después de cualquier acción legal:

   `suma(chips de jugadores) + bote = total inicial`

3. Al cerrar la mano:

   `suma(chips de jugadores) + rake = total inicial`

4. El bote queda en cero y ningún jugador puede tener fichas negativas.

La prueba `scripts/test-chip-conservation.js` ejecuta 240 manos aleatorias con
2–7 jugadores, ciegas variadas, stacks desiguales, all-in y rake, además de
casos límite de heads-up, all-in múltiple y botes laterales. Está en el runner
estándar y también se puede ejecutar sola con `npm run test:fichas`.

### 8.3 · Qué se toma de otros proyectos

- La **propiedad** de conservación de fichas está inspirada en
  `poker-engine-ts` (MIT). El motor, el reducer y el modelo de eventos no se
  copiaron: CubaPoker conserva su motor y solo adopta la invariante y la forma
  de probarla.
- La idea de que una acción forzada por tiempo también debe **entregarse** al
  cliente viene de los errores documentados de QvaPoker (AGPL). No se copió su
  servidor C++.
- La separación entre rake y saldo del jugador viene de la misma fuente: el
  rake no es una transferencia de la cuenta del jugador, es una parte del bote
  que no se reparte.