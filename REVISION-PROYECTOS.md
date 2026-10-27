# Revisión de los proyectos de referencia

Fecha: 27 de octubre de 2026.

Este documento es el mapa permanente de los proyectos descomprimidos en
`C:\Users\La'Roch\Desktop\proyectos-poker`. Los `.zip` no se abren ni se usan.
No es una lista de dependencias: es una separación entre **código que se puede
adaptar**, **ideas que se pueden estudiar** y **material que no se debe copiar**.

La regla de CubaPoker sigue siendo una sola: todo el trabajo combinado se
distribuye bajo **AGPL-3.0**. Si se adapta código de otro proyecto, se conserva
su copyright, se documenta en `NOTICE.md` y se mantiene la oferta de código
fuente en `/source`.

---

## 1. Resumen ejecutivo

| Proyecto | Stack | Licencia | ¿Copiar código? | Valor principal |
|---|---|---|---|---|
| `pokerth-stable` | C++/Qt/QML | AGPL-3.0 | Sí, con atribución | IA 4, evaluador, ciegas de torneo, arte y sonido |
| `qvapoker` | C++ Arena + web + docs | AGPL-3.0 | Sí, con atribución | Modelo CoinPoker, UX, historial, auditoría, errores reales |
| `poker-engine-ts` | TypeScript | MIT | Sí, conservando aviso | Máquina de estados, opciones legales, tests de propiedad |
| `cloudpoker` | React + Node | MIT solo en `server/src/poker-logic` | Solo esa subcarpeta, conservando aviso | Replay, hand history, parches de estado, straddle |
| `vintage-poker` | MERN | MIT | Sí, conservando aviso | Rebuy, sit-out, geometría de mesa, localización |
| `node-poker-stack` | Node/Pomelo | MIT en README | Sí, conservando aviso | Chat, amigos, reconexión, servicio de bots |
| `poker-game-main` | Node/Socket.IO | Sin licencia | **No** | Ideas de reconexión, estado saneado y QA visual |
| `TexasHoldEm-poker-multiplayer` | React + Node | Servidor ISC; cliente sin licencia | **No** | Rooms privadas y control del anfitrión, solo como idea |
| `ddpoker-main` | Java Swing + Spring | GPLv3; arte CC BY-NC-ND | **No** por decisión de producto | IA por zonas HOH, reloj de torneo, estadísticas |

### Lo que ya está claro

- **PokerTH y QvaPoker son las dos fuentes más valiosas**: comparten licencia
  AGPL y atacan los dos problemas difíciles, la IA y el dinero.
- **poker-engine-ts** es la mejor fuente para *probar* el motor, no para
  reemplazarlo. CubaPoker ya tiene un motor propio con side pots, rake y
  showdown; lo que falta es someterlo a invariantes más agresivas.
- **cloudpoker y vintage-poker** aportan producto y UX, no motores. Sus
  dependencias y su arte son antiguos; se adaptan ideas, no se importa la app.
- **poker-game-main, node-poker-stack y TexasHoldEm** sirven para contrastar
  reconexión, lobby y QA móvil. No se copia nada sin una licencia clara.
- **ddpoker** tiene una IA muy trabajada, pero su arte es CC BY-NC-ND y la
  decisión del proyecto es no mezclarlo. Se leen patrones, no se copia.

---

## 2. Proyecto por proyecto

### 2.1 `pokerth-stable` — AGPL-3.0

**Qué contiene**

- Motor C++/Qt con evaluación de manos, side pots, ciegas y showdown.
- `aiengine4.cpp`: la IA más avanzada de la carpeta.
- Plantillas de ciegas y torneos, además de perfiles de jugador.
- 25 avatares de personas, 64 avatares misceláneos, barajas SVG/PNG, mesas,
  sonidos y traducciones.
- `data/gfx/avatars/default` y `data/gfx/qml` contienen arte reutilizable bajo
  la licencia del proyecto, siempre que se mantenga la atribución.

**Qué aporta a CubaPoker**

1. **Rangos preflop por posición.** La IA abre distinto con cinco rivales
   detrás que en el botón. Esto es exactamente lo que falta para que los bots
   no parezcan todos el mismo jugador.
2. **Push-or-fold con stack corto.** Con 12 ciegas o menos, la IA deja de
   improvisar y decide entre all-in y retirada según el puesto.
3. **Modelo de rival.** Usa VPIP y agresividad observadas; si no hay datos,
   estima por el tamaño del bote. Se puede empezar por estadísticas por asiento
   y evolucionar a historial por jugador.
4. **Equity contra varios rivales.** No es una probabilidad contra una mano
   aleatoria: descuenta el rango del rival y el número de oponentes.
5. **Ciegas de torneo.** La subida puede ser por manos, por minutos o por una
   lista manual, con doble ciego o incremento fijo.
6. **Arte y sonido.** Barajas, mesas y avatares AGPL. No son obligatorios, pero
   permiten elevar la mesa sin depender de imágenes externas.

**Qué no hacer**

- No importar Qt/QML ni el servidor de PokerTH: CubaPoker es TypeScript y su
  cliente es una Mini App.
- No copiar el arte sin añadir el aviso de PokerTH y sin revisar que el tema
  concreto no tenga una licencia distinta.
- No usar nombres ni logos de PokerTH como marca de CubaPoker.

**Prioridad de adopción**

- **P0:** rangos preflop, push/fold y modelo de rival.
- **P1:** ciegas por nivel y reloj de torneo.
- **P2:** una baraja y una mesa de PokerTH como tema alternativo, con aviso.

---

### 2.2 `qvapoker` — AGPL-3.0

**Qué contiene**

- Documentación de producto muy completa: `COINPOKER-MODELO-NEGOCIO.md`,
  `UX-DESIGN-SYSTEM.md`, `ROADMAP.md`, `REFERENCIAS.md`.
- Arena: motor C++17, servidor HTTP/WebSocket, ledger append-only, journal de
  manos, caja, Club Qva y cliente PWA.
- Registro de errores reales encontrados al cablear dinero, timers, sockets y
  redacción de cartas.

**Qué aporta a CubaPoker**

1. **Modelo económico.** Rake 5 %, techos por ocupación, no flop/no drop,
   rakeback semanal, 3-Bet Club y VIP Arena. Ya está reflejado en CubaPoker.
2. **Historial de manos con redacción.** Cada jugador ve sus cartas siempre y
   las de los rivales solo si hubo showdown. Es una regla de seguridad, no una
   función cosmética.
3. **Journal append-only y auditoría.** Permite reconstruir una mano y comparar
   fichas de entrada con pagos más rake.
4. **Temporizador por mesa y entrega de la acción forzada.** Un timer que
   avanza el motor pero no avisa al cliente congela la mesa.
5. **Pruebas de última milla.** No basta con que la función devuelva bien: hay
   que comprobar que el mensaje llega al socket.
6. **Checklist de bugs de dinero.** Rake cobrado dos veces, rake perdido al
   levantarse, identificadores de asiento cruzados, jugadores fantasma.

**Qué no hacer**

- No portar el servidor C++ de Arena: la arquitectura de CubaPoker es Node,
   Mongoose y una Mini App.
- No copiar cifras de marketing sin volver a verificar la fuente.
- No usar el nombre QvaPoker ni su marca.

**Prioridad de adopción**

- **P0:** historial redactado, invariantes de fichas y pruebas de entrega.
- **P1:** reloj de torneo, caja y auditoría formal.
- **P2:** PWA, modo espectador y herramientas de operaciones.

---

### 2.3 `poker-engine-ts` — MIT

**Qué contiene**

- Motor event-sourced con snapshots, reducer, validación de intenciones y
  opciones legales.
- Tests de propiedad con `fast-check`: conservación de fichas, invariantes de
  ledger y fases.
- Documentación de estado y de replay.

**Qué aporta a CubaPoker**

1. **Conservación de fichas como propiedad.** En cada reducción válida, el
   total de fichas de la mesa debe ser el mismo. Es la prueba que más rápido
   encuentra un bug de dinero.
2. **Opciones legales generadas por el servidor.** El cliente no debe inventar
   si puede subir, igualar o retirarse. CubaPoker ya valida, pero conviene
   cubrir los casos de subida corta y reapertura de acción.
3. **Replay desde eventos.** Un historial de manos se puede reconstruir sin
   guardar cada snapshot.
4. **Separación entre estado y eventos.** Útil si más adelante se quiere
   auditar una mano paso a paso.

**Qué no hacer**

- No reemplazar el motor actual por una reescritura event-sourced. El motor de
  CubaPoker ya resuelve side pots, rake y showdown; una migración completa
  añadiría riesgo sin mejorar al jugador.
- Si se copia un test o una función, conservar el aviso MIT de sus autores.

**Prioridad de adopción**

- **P0:** test de propiedad de conservación de fichas y casos de acciones
  legales.
- **P1:** replay de una mano a partir de un historial compacto.
- **P2:** snapshots inmutables para auditoría.

---

### 2.4 `cloudpoker` — MIT solo en `server/src/poker-logic`

**Qué contiene**

- Servidor Node + Socket.IO y cliente React.
- `TableStateManager` y parches JSON para sincronizar la mesa.
- `replay.jsx`, `handHistory.jsx`, `gameLog.jsx`, `buyInLog.jsx`.
- Lógica de poker derivada de `node-poker`, con soporte de straddle.
- TODO con ideas: odds de all-in, run it twice, bomb pots y descarga del log.

**Qué aporta a CubaPoker**

1. **Replay de manos.** Un reproductor que avanza acción por acción hace que el
   jugador pueda revisar una mano y que soporte pueda auditar una queja.
2. **Hand history visible.** El historial no debe ser solo un log técnico.
3. **Parches de estado.** Si la mesa crece, enviar deltas en lugar de la mesa
   completa reduce tráfico. No es urgente con 7 asientos, pero es una salida
   limpia.
4. **Straddle y bomb pots.** Ideas de formato para mesas cash, no para el MVP.
5. **Buy-in log.** Transparencia de entradas y salidas de la mesa.

**Qué no hacer**

- No copiar el motor de poker: es antiguo y tiene decisiones de estado que
  CubaPoker ya resolvió mejor. Además, la licencia MIT solo está declarada en
  `server/src/poker-logic/license.txt`; el resto del repositorio no tiene una
  concesión clara.
- No copiar los componentes jQuery/React antiguos; se adapta el flujo, no el
  código de presentación.
- No importar `fast-json-patch` sin una razón de escala.

**Prioridad de adopción**

- **P1:** replay e historial visible.
- **P2:** deltas de estado, straddle y formatos especiales.

---

### 2.5 `vintage-poker` — MIT

**Qué contiene**

- MERN con autenticación, mesas, sockets y una mesa SVG.
- Rebuy, sit-out, sit-in, desconexión y mensajes de mesa.
- Localización y plantillas de correo.
- Side pots y una implementación didáctica de la mesa.

**Qué aporta a CubaPoker**

1. **Rebuy y sit-out.** Flujos que un jugador de cash espera y que hoy no están
   cerrados en la Mini App.
2. **Geometría de mesa.** Asientos alrededor de un SVG, cartas y fichas.
   CubaPoker ya tiene una mesa ovalada; se puede contrastar el reparto de
   asientos en móvil.
3. **Localización.** El producto es primero en español, pero la estructura de
   textos permite añadir inglés sin duplicar pantallas.
4. **Correo transaccional.** Útil para avisos de retirada o incidencias, nunca
   para datos de juego.

**Qué no hacer**

- No usar su estética vintage: CubaPoker va hacia un casino oscuro y limpio.
- No copiar el motor: usa `pokersolver` y side pots simplificados.
- No copiar las imágenes de reyes/reinas sin revisar la licencia de cada
  recurso.

**Prioridad de adopción**

- **P1:** rebuy, sit-out/sit-in y estados de desconexión.
- **P2:** localización y correo transaccional.

---

### 2.6 `node-poker-stack` — MIT declarada en README

**Qué contiene**

- Servidor Pomelo, cliente Backbone y bots como clientes separados.
- Chat, lista de amigos, historial y reconexión.
- Filtro de abuso muy básico y logs de partida.

**Qué aporta a CubaPoker**

1. **Chat de mesa y amigos.** Funciones sociales que aumentan retención, pero
   requieren moderación y rate limiting.
2. **Reconexión.** La mesa debe sobrevivir a que el jugador cierre Telegram y
   vuelva.
3. **Separación entre servicio de mesa y clientes.** Idea de arquitectura, no
   código.
4. **Historial de acciones.** Refuerza la necesidad de un log de mano.

**Qué no hacer**

- No copiar el filtro de abuso: es una sustitución de una palabra y no sirve
  para producción.
- No copiar el modelo de bots como cuentas con usuario y contraseña.
- No adoptar Pomelo: añade complejidad y no es necesario para el tamaño actual.

**Prioridad de adopción**

- **P2:** chat moderado, amigos y presencia.
- **P1:** reconexión, aunque se implemente con el modelo actual de Telegram.

---

### 2.7 `poker-game-main` — sin licencia

**Qué contiene**

- Juego Node/Express/Socket.IO con estado autoritativo, reconexión, asientos,
  amigos y pruebas.
- Documentación de QA visual, geometría de 375 px, `sanitizeState`, red y
  despliegue.
- Mockups de cinco direcciones visuales.

**Qué aporta a CubaPoker**

1. **`sanitizeState`.** La idea de que el servidor construye una vista pública
   y nunca manda el estado interno. CubaPoker ya lo hace con `toPublicTable`;
   sirve como lista de comprobación.
2. **Pruebas de geometría móvil.** Medir `getBoundingClientRect`, comprobar que
   los botones son pulsables y que nada se sale de 375 px.
3. **Reconexión y espectador.** Si el jugador vuelve, debe recuperar su asiento;
   si no está sentado, debe ver la mesa sin cartas privadas.
4. **Guardas de red.** Rate limiting, origen permitido y proxies de confianza.
5. **Mostrar cartas al terminar.** Solo las que el showdown permita.

**Qué no hacer**

- **No copiar código ni arte.** No hay licencia.
- No importar sus mockups: son referencia visual, no activos.

**Prioridad de adopción**

- **P1:** pruebas de geometría y reconexión.
- **P2:** espectador y guardas de red.

---

### 2.8 `TexasHoldEm-poker-multiplayer` — servidor ISC, cliente sin licencia

**Qué contiene**

- Rooms privadas por código, anfitrión que arranca la partida, lobby y
  showdown con `pokersolver`.
- Estado en memoria, sin reconexión ni autoridad fuerte.

**Qué aporta a CubaPoker**

1. **Rooms privadas.** Un modo “mesa de amigos” con código puede ser un
   diferenciador, pero no debe mezclarse con el dinero real sin control.
2. **Control del anfitrión.** Idea de quién crea y arranca una mesa privada.
3. **Showdown sencillo.** La UI de reparto de bote y mano ganadora.

**Qué no hacer**

- No copiar nada: el cliente no declara licencia y el servidor es demasiado
  débil para dinero.
- No usar su lógica de turnos: el cliente puede forzar acciones.

**Prioridad de adopción**

- **P3:** rooms privadas sin dinero real.

---

### 2.9 `ddpoker-main` — GPLv3 y arte CC BY-NC-ND

**Qué contiene**

- Juego Java Swing completo, servidor Spring, portal y base de datos.
- IA con modelo de oponente, zonas HOH, perfiles y simulación.
- Perfiles de torneo con niveles, antes, rebuys, addons y premios.
- Estadísticas, historial y guardado de partidas.

**Qué aporta a CubaPoker**

1. **Zonas HOH.** La idea de agrupar el stack en verde, amarillo, naranja y
   rojo para cambiar la estrategia según la profundidad. Se puede implementar
   sin copiar código.
2. **Reloj de torneo.** Niveles con antes, descansos y ajuste de ciegas.
3. **Modelo de oponente.** Estadísticas y tendencias para que la IA no sea
   estática.
4. **Simulación de manos.** Útil para probar una IA antes de producción.

**Qué no hacer**

- No copiar código: la decisión del proyecto es no incorporar GPL de terceros
  cuando ya hay una base propia y una obligación AGPL más simple.
- **No copiar arte, textos ni nombres**: son CC BY-NC-ND 4.0, no permiten uso
  comercial ni obras derivadas.
- No usar su marca ni sus pantallas.

**Prioridad de adopción**

- **P1:** zonas HOH y reloj de torneo como ideas.
- **P2:** simulación de IA y estadísticas avanzadas.

---

## 3. Qué falta en CubaPoker, ordenado por impacto

### P0 — dinero y confianza

1. **Conservación de fichas con test de propiedad.** Adaptar la idea de
   `poker-engine-ts` al motor actual. Es barato y detecta regresiones de dinero.
2. **Historial de manos redactado.** Ideas de QvaPoker y cloudpoker. El jugador
   ve sus cartas; las de un rival retirado no viajan nunca.
3. **Pruebas de entrega.** Una acción forzada por tiempo debe llegar al cliente
   y no solo cambiar el motor.
4. **Conciliación de rake y rakeback.** Ya existe separación 3-Bet/Arena;
   falta una prueba de invariante de extremo a extremo con varias manos.

### P0 — que los bots parezcan jugadores

1. **Rangos preflop por posición** (PokerTH AI 4).
2. **Push/fold con stack corto** (PokerTH).
3. **VPIP y agresividad por asiento** (PokerTH y ddpoker como idea).
4. **Tamaño de apuesta por bote, no por ciegas** (PokerTH).

### P1 — torneos y cash completos

1. **Niveles de ciegas con reloj** (PokerTH, ddpoker y QvaPoker).
2. **Time bank** y timeout visible por humano.
3. **Rebuy y sit-out** (vintage-poker).
4. **Replay de manos** (cloudpoker).
5. **Pruebas de geometría móvil** (poker-game-main).

### P2 — producto social y operación

1. Chat de mesa con moderación y rate limiting.
2. Amigos, presencia y mesas privadas.
3. Modo espectador.
4. Temas de mesa y barajas AGPL de PokerTH.
5. PWA y notificaciones.

---

## 4. Reglas para no contaminar el proyecto

1. **Código AGPL** (PokerTH, QvaPoker): se puede adaptar. Añadir autor,
   archivo de origen, cambios realizados y conservar la licencia.
2. **Código MIT** (poker-engine-ts, cloudpoker, vintage-poker,
   node-poker-stack): se puede adaptar conservando copyright y permiso.
3. **Sin licencia** (poker-game-main, cliente de TexasHoldEm): solo ideas.
   No se copian líneas, nombres de clases ni arte.
4. **Arte CC BY-NC-ND** (ddpoker): no se usa.
5. **Arte de PokerTH/QvaPoker**: solo si el recurso concreto está cubierto por
   la licencia del repositorio y se añade atribución. Ante la duda, no se usa.
6. **Nunca** se copia una imagen, sonido o fuente desde un proyecto sin
   licencia, aunque el código sea libre.
7. Todo recurso externo que se incorpore debe quedar registrado en `NOTICE.md`
   y, si es código, con su aviso en el archivo.

---

## 5. Estado de la revisión

- [x] Inventario de las 9 carpetas descomprimidas; los `.zip` quedan fuera.
- [x] Lectura de licencias y README de los 9 proyectos.
- [x] Revisión de motores, IA, side pots, lobby y mesa.
- [x] Revisión de documentación de producto de QvaPoker.
- [x] Revisión de arte y sonido de PokerTH.
- [x] Contraste con el estado actual de CubaPoker.
- [ ] Implementar el bloque P0 de IA y el test de conservación de fichas.
- [ ] Implementar historial redactado y niveles de ciegas.
- [ ] Validar en Telegram real y con pasarelas reales.

Este documento se actualiza cuando se adopte o descarte una pieza. La revisión
no se considera terminada solo por haber leído los README: cada incorporación
tiene que pasar por tests y por `NOTICE.md`.
