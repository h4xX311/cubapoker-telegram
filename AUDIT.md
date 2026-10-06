# Auditoría del estado de CubaPoker

Fecha: 6 de octubre de 2026.
Cómo: contra el código y contra MongoDB de verdad, no leyendo.

---

## 1. La respuesta corta

**El producto no se puede jugar.** Y no por falta de lógica de poker: hay un bug de
escritura concurrente que mata la mesa nada más sentarse, y mientras esté, da igual
cuánto se haya arreglado antes.

Hoy mismo, con el código actual, un usuario que se sienta en una mesa:

```
sentado: mesa=cash-t1-mux0wsbz
ERROR: VersionError: No matching document found for id "6ac5407..." version 4
       modifiedPaths "hand, hand.communityCards, hand.phase, hand.lastActionAt"
manos jugadas: 0
NINGUN bot ha jugado: estan sentados de adorno
```

Se sienta, le cobran el buy-in, se le sienta la mesa, y la mesa muere antes de repartir
la primera carta. Eso es lo que impide jugar, y lo que te ha pasado.

---

## 2. Lo que está BIEN, con pruebas

Esto no es opinión: son pruebas que pasan.

| Área | Qué | Cómo se comprueba |
|---|---|---|
| **Aritmética del dinero** | Unidades, commissions, retiros, repartos | 422 unitarias en verde |
| **Botes laterales** | Un all-in de 100 no puede llevarse el bote de 5 000 | 52 480 repartos comprobados |
| **Liquidación del campo** | El rake es el 5 % real, nunca se disimula una fuga | 18 comprobaciones |
| **Botes laterales laterales** | Índice libre, fusión sin perder jugadores | 21 comprobaciones |
| **Fichas de un eliminado** | Van al bote del campo, nunca se evaporan | 12 comprobaciones |
| **Freno de simulación** | No se puede pagar un retiro simulado | 17 comprobaciones |
| **Depósitos TRC20** | Circuito con memo y atribución fiable | 46 comprobaciones |
| **Motor de poker** | Bote entregado = aportado, en 9 y 23 jugadores | 84 comprobaciones |
| **Invariante del dinero** | El dinero no se crea ni se destruye | 12 000 rondas de campo entero |

**El dinero está bajo control.** Nueve bugs de dinero cerrados hoy, verificados.

### La invariante que lo resume

```
saldos + fichas + rake == total inicial
```

Se comprobó en 12 000 rondas de un campo entero jugado por bots: **ninguna desviación**.
Eso es lo que hay que tener cerrado antes de abrir a nadie, y está cerrado.

---

## 3. Lo que está MAL, ordenado por gravedad

### 3.1 BLOQUEANTE · La mesa muere al sentarse

`VersionError` en `checkTurnTimeout`. Dos escrituras concurrentes sobre el mismo documento
de `Table`: una sube `__v` y la otra, al guardar, encuentra que el documento ya no es el
que leyó.

**Por qué pasa.** `table.save()` se llama desde cinco sitios distintos —`startHand`,
`finishHand`, `checkTurnTimeout`, `playBotTurn`, `applyHumanAction`— y el turno del bot se
programa con `setTimeout` (`scheduleTurn`). O sea: el temporizador del bot y el ciclo del
gestor pueden guardar la mesa a la vez. El primero gana; el segundo revienta.

**Por qué es grave.** El error lo envuelve un `try/catch` por mesa, así que **no para el
proceso**: la mesa muere en silencio y sigue ocupada. El jugador ve su buy-in cobrado, su
asiento, y una mesa que no se mueve. Nunca.

**Y explica cosas de antes.** En el test del campo entero hubo corridas en las que las manos
avanzaban y corridas en las que no. Es esta misma carrera, ganando o perdiendo la lotería.

**Cómo se arregla.** Un cerrojo de escritura por mesa. Un solo `Map<tableId, Promise>` que
serialice los `save()` del mismo documento y deje pasar los de mesas distintas. Es como lo
hace cualquier servidor de poker, y es un cambio acotado: no hay que reescribir la lógica,
solo impedir que dos cosas escriban a la vez.

### 3.2 BLOQUEANTE · El campo no termina

Un campo se queda con 2 jugadores y **nadie cobra**. Doce mil rondas y ahí sigue.

Está documentado en `LAUNCH_CHECKLIST.md` §3-bis-cuarta con las siete hipótesis ya
descartadas. Lo que queda es un único hecho: **el asiento `eliminated` con cero fichas no lo
recoge `collectEliminations`**. Si lo recogiera, el contador bajaría a 1 y liquidaría.

Sin esto no hay producto: un usuario entra en un campo y espera para siempre.

### 3.3 GRAVE · La interfaz no tiene ninguna vía para jugar

La UI **nunca llama a `api.sit`**. Todo lo que ofrece pasa por un campo, un freeroll o un
centroll, y **los tres arrancan cuando se llenan**.

`fieldSize` está a **300 para todos los tiers** (fábrica `tier()`, línea 217). O sea: para
jugar hacen falta 300 registros con saldo cada uno. No es un detalle de configuración, es
que **la aplicación no tiene forma de jugar**.

`POST /game/sit` existe y funciona: sentarse en una mesa cash, los bots rellenan, se juega
de inmediato. Está escrito, probado (se sienta, cobra el buy-in, pone 2 bots) y **nadie lo
expone**.

**Arreglo:** un botón "Jugar ahora" que siente en una mesa cash con bots. Es la diferencia
entre una demo y un producto.

### 3.4 GRAVE · El buy-in se devuelve y el jugador se queda sentado

`unregister` sacaba al jugador de una cola en memoria y **nunca quitaba el asiento**. Como
`trySeat` sienta al instante, casi nadie pasaba por esa cola: el caso normal devolvía el
dinero y dejaba al jugador atrapado.

**No era solo de desarrollo:** cada reinicio de Render vacía la cola, así que todo el que
estuviera esperando perdía la salida. Corregido hoy (`becad56`) y verificado: 49 → 50 y
vuelve a registrar.

### 3.5 GRAVE · La red de seguridad pelea con la fuente de verdad

Tres veces hoy, las tres por lo mismo:

| Red | Qué hacía mal |
|---|---|
| `field.tables` (copia desnormalizada) | Decía que faltaban mesas, se creaban otra vez con `seats: []`, y **se borraban los sentados** |
| El reloj del test | Robaba el turno a la IA, y los humanos no jugaban: pasaban y plegaban |
| `reconcileAliveCount` | Contaba como vivos los asientos `eliminated`, y **resucitaba eliminados** |

Las tres están corregidas. Las tres las escribió alguien —o escribí yo— como respaldo, y
ninguna se apartó cuando la fuente de verdad empezó a funcionar.

**Lo que queda de fondo:** `collectEliminations` y `finishHand` todavía se pisan, y ahora
sabemos por qué: los dos escriben el documento `Table`. Es el mismo origen que el bug 3.1.

### 3.6 MEDIO · Los bots playing de adorno

En la partida que acabo de correr: `0 bots han jugado` de 2. **No es que jueguen mal: es que
no juegan**, porque la mesa muere antes (3.1).

Por separado, la IA sí decide: con dos ases hace `call`, con 7-3-2 también `call`. Funcional,
pero **muy suelta**. No es un bug, pero una plataforma que se juega contra bots tiene que
tener bots que jueguen a poker.

### 3.7 MEDIO · El ritmo

Una mesa 7-max tarda del orden de **3 700 manos** en dejar a un jugador (con varianza
enorme: la misma mesa terminó en 39 manos una vez y en 3 713 otra). Con 1 000 fichas y
ciegas 5/10, las manos se resuelven casi siempre antes del flop.

Medido en `test-bot-pace.js`: 6,9 acciones por mano. Llegan al showdown, pero casi siempre
gana la ciega.

**Qué significa:** un campo real de 300 tarda **horas**. Eso es aceptable en un Sit'n'Go
grande, pero significa que la primera partida de un usuario nuevo es esperar mucho rato. Hay
que decidir si se acepta o se ajustan las ciegas.

### 3.8 MEDIO · La interfaz no estaba con estilos

Tailwind nunca estuvo instalado, y `styles.css` estaba comentado con `//`, que no es CSS. De
222 líneas, casi nada se aplicaba. **La app llevaba meses sin estilos y sin un solo error en
ningún log**, porque nada leía el CSS. Corregido: el CSS pasó de 2,91 kB a 20,95 kB.

### 3.9 BAJO · Errores que mienten

- `register` dice *"No se pudo cobrar el buy-in. Intentalo de nuevo."* cuando el problema
  puede ser cualquier otro. Reintentar no lo arregla nunca.
- `unregister` decía *"No estas en la cola de este campo"*, que no significa nada para
  quien lo lee.
- `ALREADY_IN_FIELD` sin decir en qué campo ni que se puede salir.

---

## 4. Lo que NO existe

| Qué | Estado | Nota |
|---|---|---|
| Autoexclusión | **No implementado** | Escrito en `LEGAL/IMPLEMENTATION.md` |
| Límites de pérdida | **No implementado** | Ídem |
| Límite de tiempo / sesión | **No implementado** | Ídem |
| Verificación de edad | **No implementado** | La UI dice "mayores de 18" y nada lo comprueba |
| Historial de manos | **No** | No hay vista de manos jugadas |
| Estadísticas reales | **Parcial** | `stats` se incrementan a medias |
| Retirada en efectivo real | **No** | Solo USDT, y en simulación |
| RNG verificable | **No** | Para un poker con USDT, la acusación de amañar cartas es el riesgo más probable |
| Multitabla real para el usuario | **Parcial** | El código funciona; **nunca se ha visto en pie** |

---

## 5. Lo que hay que hacer, en orden

### Antes de enseñárselo a una persona

1. **El cerrojo de escritura por mesa** (3.1). Sin esto no hay juego. Cambio acotado.
2. **El botón de jugar** (3.3). Expone `/game/sit`. Cambio pequeño.
3. **`collectEliminations` recoge el asiento `eliminated`** (3.2). Sin esto no hay premio.

Los tres son **condición necesaria**. Con cualquiera de los tres fallando, no hay producto.

### Antes de cobrar a alguien

4. Un campo real, de principio a fin, verificado (3.2).
5. Autoexclusión y límites de pérdida. Es lo más urgente que queda: en una plataforma donde
   alguien puede perder su saldo en una sesión, esto no es una función, es una
   obligación.
6. Verificación de edad.
7. Revisión legal por abogado. Los borradores de `LEGAL/` **no son asesoría legal**.

### Antes de poner dinero real dentro

8. Pasarela de pago (requiere cuenta de empresa) o TRC20 + recarga CUP manual.
9. RNG verificable, o al menos la arquitectura preparada para añadirlo.
10. Política de conservación de datos y AML.

---

## 6. Lo que NO hay que hacer

- **No tocar más la aritmética del dinero.** Está verificada con 422 pruebas y 12 000
  rondas sin una desviación. Es la parte más sólida del proyecto, y cada retoque es una
  oportunidad de romperla.
- **No volver a poner redes que escriban sobre el estado de otro gestor.** Tres
  regresiones hoy, las tres de ahí.
- **No subir límites ni relojes del test para que pase.** Una vez moví 4 000 → 12 000 rondas
  por un motivo medido y documentado; sin medición, es tapar el síntoma.
- **No aceptar "no se pudo cobrar, inténtalo de nuevo".** Un mensaje de error que miente
  hace perder tiempo a quien lo lee, y ahora mismo está haciendo perder tiempo.

---

## 7. La lección de fondo

Dos patrones explican casi todo lo que ha salido hoy.

**El primero: dos gestores escribiendo el mismo documento.** `field.manager` y
`table.manager` escriben `Table`. `collectEliminations` y `finishHand` se pisan. El
reconciliador y `collectEliminations` se pelean el contador. El cerrojo de escritura es la
solución, y no hay atajo: mientras dos cosas escriban a la vez, habrá filtros occasionales.

**El segundo: lo que no se mide, no funciona.** El campo lleva días "sin terminar" y nadie
sabía si era el contador, las fichas o los bots, porque el log no decía nada. Lo que ha
funcionado hoy, siempre, ha sido **instrumentar y mirar**: cada bug de los nueve apareció en
la primera corrida con una línea de diagnóstico. Ninguno apareció leyendo.

Y el tercero, más incómodo: **los errores de lógica más graves estaban escondidos bajo bugs
de instrumentación**. El rake del 53 % tapaba el 15 % del bote evaporándose. Un síntoma
enorme tapando una fuga pequeña, y el mes saliendo bien por eso.

---

## 8. Un mensaje honesto

La base técnica es sólida donde más cuesta: **el dinero**. Nueve bugs encontrados y
arreglados, todos verificados, con una invariante que aguanta 12 000 rondas.

Lo que no está es **la capa de orquestación**: quién escribe qué, y cuándo. Ahí están los tres
bloqueantes, y ninguno es difícil una vez identificado. Pero llevan más tiempo del que
deberían, y eso es porque cada vez que se tocaba una cosa aparecía otra debajo.

Y hay que decirlo claro: **no has podido jugar ni una partida porque el producto no
permite jugar**, no porque falte probarlo. Cuando 3.1 y 3.3 estén, podrás jugar. Hasta
entonces, cualquier prueba que hagas va a chocar contra el mismo muro.