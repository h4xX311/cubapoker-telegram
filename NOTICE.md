# Licencia y atribuciones

## CubaPoker

Copyright (C) 2026 CubaPoker y colaboradores.

CubaPoker se distribuye bajo la **GNU Affero General Public License, versión 3
(AGPL-3.0)**. El texto completo está en [`LICENSE`](./LICENSE).

Esto significa, entre otras cosas:

- Cualquiera puede ejecutar, estudiar, modificar y redistribuir este programa.
- Si se ejecuta una versión modificada en un servidor y se ofrece a otras
  personas a través de una red (por ejemplo, una Telegram Mini App), hay que
  ofrecerles el código fuente correspondiente.
- Las obras derivadas y la obra combinada deben distribuirse bajo AGPL-3.0 y
  mantener los avisos de autoría.

## PokerTH

Una parte de la lógica de juego, de la inteligencia de los jugadores y de la
experiencia de mesa de CubaPoker está basada en **PokerTH**, el motor de póker
de código abierto:

- Proyecto: https://github.com/pokerth/pokerth
- Sitio: https://www.pokerth.net
- Copyright (C) 2006-2026 los autores de PokerTH.
- Licencia: GNU Affero General Public License, versión 3.

PokerTH se distribuye bajo AGPL-3.0. CubaPoker, al incorporar obras derivadas
de PokerTH, se distribuye bajo la misma licencia. Los archivos que contienen
código portado o adaptado de PokerTH conservan una cabecera con el crédito
correspondiente y una nota de modificaciones.

Hasta la fecha, las piezas adaptadas o portadas son:

- La estructura de decisión de los jugadores automáticos y sus perfiles de
  estilo (inspirada en el motor de IA de PokerTH).
- El flujo de all-in con runout completo, la opción de la ciega grande y la
  comprobación de que un all-in corto no reabra la apuesta (inspirado en
  `src/engine/local_engine/localhand.cpp`).
- La idea de separar la evaluación de la mano del reparto de botes laterales
  (inspirada en `src/engine/local_engine/cardsvalue.cpp` y en el flujo de
  showdown de PokerTH).

No se ha copiado ningún archivo binario, tema gráfico ni baraja de PokerTH en
esta versión. Si se incorporan en el futuro, quedarán cubiertos por la misma
licencia y se listarán aquí con su ruta y su autoría.

## Proyectos estudiados y referencias

Además de PokerTH, CubaPoker ha revisado los siguientes proyectos para decidir
qué se puede adaptar y qué debe quedarse como idea. Esta sección no implica que
todo su código esté incorporado: solo documenta el origen de una influencia y
evita atribuciones ambiguas.

| Proyecto | Licencia | Uso en CubaPoker |
|---|---|---|
| [poker-engine-ts](https://github.com/Ge-limin/poker-engine-ts) | MIT, Copyright (c) 2026 Limin Ge | La propiedad de conservación de fichas se adaptó al motor propio en `scripts/test-chip-conservation.js`. No se copió el reducer ni el modelo event-sourced. |
| [QvaPoker](https://github.com/h4xX311/qvapoker) | AGPL-3.0 | Referencia de producto, auditoría de dinero, historial redactado y errores de timers. No se incorporó su servidor C++ en esta versión. |
| `cloudpoker` | MIT solo en `server/src/poker-logic` | Ideas de replay, historial y parches de estado. El resto del repositorio no se copia. |
| `vintage-poker` | MIT | Ideas de rebuy, sit-out y geometría de mesa. No se copió su motor ni su arte. |
| `node-poker-stack` | MIT declarada en el README | Ideas de chat, amigos y reconexión. No se copió su arquitectura Pomelo. |
| `poker-game-main` | Sin licencia | Solo ideas de reconexión, estado saneado y QA móvil. No se copió código ni arte. |
| `TexasHoldEm-poker-multiplayer` | Servidor ISC; cliente sin licencia | Solo ideas de salas privadas. No se copió código del cliente. |
| `ddpoker` | GPLv3; arte CC BY-NC-ND 4.0 | Solo ideas de IA por zonas y reloj de torneo. No se copió código ni arte. |

La revisión completa, con el detalle de cada proyecto y el orden de adopción,
está en [`REVISION-PROYECTOS.md`](./REVISION-PROYECTOS.md).

## Oferta de código fuente

El código fuente completo de CubaPoker, incluidas las modificaciones, está
disponible en el repositorio del proyecto. La aplicación debe mostrar un enlace
visible a ese repositorio (o a una copia descargable) a cualquier usuario que
acceda al servicio por red, conforme al artículo 13 de la AGPL-3.0.

## Garantía

Este programa se distribuye **sin garantía alguna**, ni implícita ni explícita,
incluida la garantía de comerciabilidad o de idoneidad para un fin determinado.

CubaPoker es una plataforma de póker que utiliza USDT como unidad de cuenta.
El operador es responsable de las pasarelas de pago, de las obligaciones
fiscales y de cumplir la normativa que le sea aplicable en su jurisdicción. El
software no constituye asesoría legal ni sustituye las licencias o permisos que
correspondan al operador.
