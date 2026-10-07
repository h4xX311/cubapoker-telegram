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