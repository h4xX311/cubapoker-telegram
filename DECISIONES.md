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

**El arranque.** Hoy el centroll exige 100 inscritos (`seated >= targetField`) y nadie lo
rellena con bots, así que con pocos jugadores reales no arranca nunca. El freeroll sí se
rellena con bots hasta el mínimo. Falta decidir si el centroll se rellena con bots (y con
qué regla para sus premios) o si arranca por tiempo con los inscritos que haya.