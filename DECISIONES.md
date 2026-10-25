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

## 4 · El freeroll horario

**Decisión:** un freeroll cada hora, multi-mesa (hasta 300 jugadores en mesas de 7), gratis,
con registro tardío de 12 minutos. El premio va entero a **saldo de promoción**.

### Reglas

| | |
|---|---|
| Horario | Un slot por hora en punto (UTC). `claveSlot` = `YYYY-MM-DDTHH` |
| Entrada | Gratis. No cobra buy-in ni rake |
| Fichas | 1.000, ciegas 5/10 |
| Mínimo para arrancar | 2. Con 1 humano se rellena con bots hasta 2 |
| Sin nadie | Se cancela: no se paga un torneo de bots con dinero de la casa |
| Registro tardío | Hasta 12 minutos después del inicio, con las mismas 1.000 fichas |
| Premio | `FREEROLL_HOURLY_PRIZE_USDT` (1 USDT por defecto), reparto 50/30/20 |
| Destino | `balance.play` (promoción). No retirable directamente |

El campo lleva `tierId = freeroll-<clave>`. El índice único parcial
`un_campo_vivo_por_nivel` impide que dos peticiones simultáneas abran dos campos del mismo
slot.

### Por qué el premio va a promoción

Es dinero de la casa, no de otros jugadores. Si fuera retirable, cada hora habría una
extracción directa de 1 USDT sin que nadie hubiera puesto dinero. En promoción se juega y se
desbloquea con el mecanismo que ya existe (1 de cada 10). Queda registrado en
`stats.totalFreerollWon` para que el jugador lo vea.

### Por qué se cancela cuando no hay nadie

Rellenar con bots un torneo vacío y pagar el premio al bot ganador es pagar por nada. El
relleno con bots existe para que **un humano** no se quede esperando solo: con cero humanos
no hay a quién entretener.

### Lo que falta decidir

**El premio de 1 USDT por hora.** Son 24 USDT al día de la casa si se juegan todos los slots.
Es una decisión de producto y de presupuesto, no técnica: se cambia con
`FREEROLL_HOURLY_PRIZE_USDT` sin tocar código.

---

## 5 · Los centrolls

**Decisión:** un centroll de 0,01 USDT que consume saldo real y paga el premio entero a
**saldo de promoción**. Es la vía de ingresos que hace sostenible el freeroll: el jugador
compra con dinero real lo que en el freeroll ganaba gratis.

### Reglas

| | |
|---|---|
| Entrada | 0,01 USDT de `balance.real` (10 unidades internas). Solo saldo retirable |
| Fichas | 1.000 por jugador, ciegas 5/10 (100 ciegas grandes) |
| Campo objetivo | 100 jugadores; techo duro 300 |
| Reentradas | Hasta 5 por jugador, cada una a 0,01 USDT |
| Premio | 30 % del bote, reparto 50/30/20 |
| Destino | `balance.play` (promoción). No retirable directamente |
| Rake aparte | No: el margen de la casa es el 70 % del bote que no se reparte |

### Por qué 0,01 USDT

El buy-in de CoinPoker es de un centavo. Con `1 USDT = 1000` unidades internas, 0,01 USDT
son **10 unidades**, un entero: el motor no redondea a cero. El valor anterior de 1 USDT
venía de una conversión a CUP mal planteada y dejaba el centroll 100 veces más caro que el
modelo de referencia.

### Por qué las fichas no salen del buy-in

El buy-in es dinero; las fichas son de torneo. Si el stack saliera del buy-in (10 unidades),
las ciegas derivadas del stack serían 1/2 y cada jugador entraría con **5 ciegas grandes**:
todo el mundo all-in preflop. Con 1.000 fichas fijas y ciegas 5/10 el centroll es un torneo
de 100 BB. Las fichas no tocan el bote: el premio se calcula sobre `buyInsCollected`.

### Por qué el premio se muestra como porcentaje del bote

`prizeMultiplier = 30` es un **porcentaje**, no un multiplicador del buy-in: en un campo
lleno de 100 jugadores coincide con 30 veces la entrada, pero con el campo a medio llenar el
multiplicador real es menor. La UI muestra "30 % del bote" para que el número sea cierto en
cualquier momento del registro.

### La liquidación también es del centroll

`fieldManager.tick()` liquida todos los campos, y `settleField` solo distinguía `freeroll`
de todo lo demás. Un centroll caía en la rama de cash: rake del 5 %, reparto 45/25/15/9/6 y
pago a `balance.real`. Medido con `test-centroll-liquidacion.js`: un bote de 100 unidades
repartía 95 retirables y la casa se quedaba 5, cuando la regla es 30 a promoción y 70 de
margen. Ahora `settleField` tiene una rama `centroll` y el premio sale de la misma función
que muestra `centrollService.status()` (`centrollPrizeUnits`), para que la UI y el pago no
puedan divergir.

### Lo que falta decidir

**El arranque (resuelto el 24 de octubre).** El centroll ya no espera a 100 humanos. Cada
mesa se rellena con bots hasta `minPlayersPerTable: 2` y el campo arranca en cuanto hay un
humano. Los bots no pagan buy-in; si ganan, su parte del premio va a la casa, no a un jugador
que no existe. Los humanos que cobran reciben `balance.play` con el reparto 50/30/20.

Esto es lo mismo que ya hacía el freeroll: el relleno existe para que un humano no se quede
mirando una mesa vacía. La diferencia es que en el centroll el buy-in es dinero real y el
margen de la casa sale del 70 % del bote.

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

Las mesas de un campo (torneo, freeroll, centroll) no son cash ring y no usan esta regla: su
economía ya está definida por el campo.

### 6.3 · Retiro: 5 USDT fijos

El retiro cobra **5 USDT fijos**, como CoinPoker, con mínimo de 10 USDT y máximo de 25.000.
No es un porcentaje. Si el coste real de red es menor que 5 USDT, la diferencia queda en la
casa; si el importe es menor que la comisión, se cobra como máximo el importe disponible
(`min(amount, 5 USDT)`).

El fee de red es un **coste interno**, no un segundo cobro al jugador. La UI muestra comisión
y neto antes de confirmar.

### 6.4 · 3-Bet Club: rakeback semanal, no descuento de rake

Se abandona el descuento de rake. El VIP reparte un porcentaje del rake que el jugador generó:

| Plan | Precio | Duración | Rakeback | Power Ups | Torneos |
|---|---:|---:|---:|---:|---:|
| Mensual | 35 USDT | 30 días | 10 % | 6 | — |
| Trimestral | 100 USDT | 90 días | 10 % | 18 | −5 % |

Reglas de dinero:

- Solo cuenta el rake de **mesas cash ring**. Torneos, freerolls y centrolls no generan
  rakeback.
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

El job corre al arrancar y cada 6 horas. También se puede cobrar desde la pantalla VIP; ambos
caminos usan la misma operación idempotente.

### 6.5 · VIP Arena: una sala, no una membresía

En CoinPoker, **VIP Arena es una sala de cash**, no un plan que se compra. Se corrigió el modelo:
el plan `elite` desapareció del 3-Bet Club y VIP Arena pasó al lobby de cash.

- Ciegas **50/100 USDT**, buy-in **10.000 USDT** (100 BB) y formatos 7-max, 6-max y Heads-Up.
- No hay precio de acceso ni botón de compra. Se entra con el buy-in, como en cualquier mesa.
- Los jugadores reciben un **profit share semanal del 15 %** del rake que generaron en esa sala,
  pagado los lunes UTC a `balance.real`.
- Es un programa aparte del 3-Bet Club: un miembro del 3-Bet que juegue en Arena cobra su 10 %
  sobre todo el rake cash **y además** el 15 % del rake de Arena. Los pagos se guardan en
  `ArenaPayout`, con índice único `{telegramId, weekKey}`, separado de `RakebackPayout`.
- El reintento de Arena usa la clave `arena_profit_share:YYYY-MM-DD`, distinta de la del
  3-Bet. El mismo jugador puede cobrar ambos programas de la misma semana sin que uno bloquee
  al otro ni se acredite dos veces.
- El job de los lunes paga ambos programas. Un fallo en uno no cancela el otro.
- No hay lista de "miembros de Arena": la elegibilidad nace de haber generado rake en la sala.
  La selección curada de CoinPoker se puede añadir después con invitaciones, sin vender acceso.

### 6.6 · Lo que sigue siendo una decisión abierta

- PLO/PLO5/PLO6/Short Deck: requieren motor de variantes.
- Juegos de práctica con play chips y Level Up Freerolls: aún no implementados.
- Pasarelas reales de depósito/retiro: requieren cuenta de empresa y credenciales; hoy se
  simulan.
- Validación con Telegram real y token de @BotFather: pendiente.