import { Schema, Document, model, Types } from 'mongoose';

/**
 * Un campo: el torneo multi-mesa completo.
 *
 * ------------------------------------------------------------------
 * POR QUE ESTO ES UNA COLECCION APARTE Y NO UN CAMPO DENTRO DE `Table`
 *
 * El estado del campo es AGREGADO sobre sus mesas: cuantos jugadores quedan,
 * cuantas plazas pagadas se han repartido, que mesa es la final. Consultar eso
 * requiere mirar N documentos de `Table` y reducir en memoria, lo cual no se
 * puede hacer de forma atomica. Con dos ticks del gestor a la vez se
 * adjudicarian dos veces la misma plaza o se contarian mal los jugadores.
 *
 * En una coleccion propia, una actualizacion con filtro condicional
 * (`{ _id, playersRemaining: { $gte: n } }`) resuelve el caso. Es lo que permite
 * que un campo se liquide sin fear de pagar dos veces el primer puesto.
 *
 * ------------------------------------------------------------------
 * EL CAMPO ES UN TORNEO, NO UNA MESA
 *
 * La distincion con las mesas cash actuales es essencial y costaba hacer
 * explicita. En `table.manager.ts`, al cerrar cada mano, las fichas de un humano
 * vuelven a su monedero (`$inc: { 'balance.real': seat.chips }`) y el jugador
 * vuelve a comprar. Eso es una mesa de cash: se entra y se sale cuando uno
 * quiere.
 *
 * En un campo no. El buy-in se cobra UNA vez al registrarse, las fichas se
 * quedan bloqueadas en la mesa hasta que el jugador queda eliminado o hasta
 * que gana el campo, y la posicion final se decide por orden de eliminacion.
 * Sin ese cambio, cada mano devolveria el dinero al monedero y el "campo de
 * 500" seria 500 partidas sueltas de una mesa.
 */

/**
 * Tipos de campo activos.
 *
 * `cash` se conserva por compatibilidad con documentos antiguos; el producto
 * actual solo abre freerolls y torneos.
 */
export type FieldKind = 'cash' | 'freeroll' | 'tournament';

/**
 * Formato de un campo pagado.
 *
 * `standard` es un torneo programado con reparto por posiciones.
 * `spingo` es un 3-max que arranca al llenarse y paga solo al ganador.
 */
export type FieldFormat = 'standard' | 'spingo';

export type FieldStatus =
  /** Aceptando inscripciones. No se juega todavia. */
  | 'filling'
  /** Las mesas estan repartiendo fichas. */
  | 'running'
  /** Queda una sola mesa: es la final. */
  | 'final'
  /** Liquidado. El premio esta repartido. */
  | 'finished'
  /**
   * Cancelado antes de terminar. El dinero se devolvio segun la regla de `DECISIONES.md`.
   *
   * Es distinto de `finished` a proposito: en `finished` hubo un ganador y se pago un premio;
   * en `cancelled` se devolvieron buy-ins y nadie gano. Mezclarlos haria que el informe
   * contara como "campos jugados" unos que no se jugaron, y que la conciliacion buscara un
   * premio que no existe.
   */
  | 'cancelled';

export interface IField extends Document {
  /** Identificador del campo, como `cash-t500-a7f3k2` */
  fieldId: string;

  kind: FieldKind;

  /** Tier de cash, si aplica. Un freeroll usa `prizeTier`. */
  tierId?: string;
  /** Premio garantizado del escalon (freerolls). */
  prizeTier?: number;

  /** Evento del catalogo de torneos, si aplica. */
  eventId?: string;
  /** `standard` o `spingo`. Ausente en cash y freeroll. */
  format?: FieldFormat;

  status: FieldStatus;

  /**
   * Buy-in por jugador, en UNIDADES INTERNAS (1 USDT = 1 000).
   *
   * ------------------------------------------------------------------
   * POR QUE EL NOMBRE LLEVA EL SUFIJO Y NO ES SOLO `buyIn`
   *
   * Este campo se llamaba `buyIn` y el gestor escribia `buyInUnits`. Como mongoose
   * no avisa de las claves que sobran en un `create()`, el campo `buyIn` se
   * quedaba sin rellenar, `required` lo rechazaba, y `openField` fallaba SIEMPRE.
   *
   * No se encontró leyendo el codigo. Se encontró el primer dia que se ejecuto
   * `openField` contra un Mongo de verdad (ver `scripts/test-e2e-field.js`), que
   * es la razon de que ese test exista.
   *
   * El nombre lleva el sufijo porque el sufijo es lo que evita la confusion de
   * unidades. Un campo llamado `buyIn` invita a Assignarle USDT (1000) donde
   * deberia ir unidades (1000_000), que es un error de mil veces. El mismo
   * criterio que obliga a `withdrawal.rules.ts` a convertir los limites en el
   * modulo en vez de confiar en la comparacion.
   */
  buyInUnits: number;

  /**
   * PREMIO DE UN FREEROLL, en unidades internas. Lo pone la casa.
   *
   * ------------------------------------------------------------------
   * POR QUE NO SE PUEDE DEDUCIR DEL BOTE
   *
   * En un campo de cash el premio sale de `buyInsCollected`: cada jugador paga su entrada y
   * ese dinero es el bote. En un freeroll nadie paga, asi que `buyInsCollected` es 0 y el
   * bote, por definicion, tambien. El premio es un GASTO DE ADQUISICION del operador, no
   * una suma de entradas.
   *
   * Sin este campo, `settleField` repartiria 0 y el freeroll no pagaria nada. Y el error no
   * seria visible: el campo terminaria `finished`, sin errores y con todos los premios a
   * cero.
   * ------------------------------------------------------------------
   */
  prizePoolUnits?: number;

  /**
   * Reparto por posiciones de un torneo pagado.
   *
   * En un torneo programado suma 100 y se reparte entre las cinco primeras
   * plazas. En un Spin & Go es `[100]`: el ganador se lo lleva todo. No se
   * reutiliza `FREEROLL_PAYOUT` porque el freeroll no cobra entrada y su
   * reparto (50/30/20) no tiene por que ser el mismo.
   */
  payoutTable?: number[];

  /**
   * Diferencia que pone la casa cuando el premio garantizado supera el bote
   * de las entradas. Se guarda para poder auditarlo; no es dinero de ningun
   * jugador.
   */
  overlayUnits?: number;

  /**
   * Hora a la que se cierra la inscripcion y arranca el campo.
   *
   * Un freeroll NO arranca al llenarse: arranca a su hora, como un torneo programado. Si
   * arrancara al llenarse, el jugador que se apunta temprano no sabria cuando empieza y el
   * que llega tarde se lo pierde sin aviso.
   */
  scheduledStartAt?: Date;

  /**
   * Hasta cuando se puede entrar con el torneo ya empezado (registro tardio).
   *
   * Se apunta en el documento y no se calcula al vuelo con `scheduledStartAt + 12 min`
   * porque esa regla acabaria escrita en dos sitios (aqui y en la UI) y un dia dirian cosas
   * distintas.
   */
  lateRegUntil?: Date;

  /** Fichas con las que empieza cada jugador. Solo freeroll. */
  startChips?: number;

  /**
   * Ciegas del freeroll, ya calculadas al abrirlo.
   *
   * Se guardan aqui porque `createFieldTable` las pedia al tier de cash (`getTier`), y un
   * freeroll no tiene tier. Sin esto, la mesa no se puede crear y el campo se queda vacio.
   */
  smallBlind?: number;
  bigBlind?: number;

  /**
   * Participantes objetivo para arrancar. Al llenarse, `status` pasa a
   * `running`. Para el cash son los `fieldSize` del tier; para un freeroll,
   * `FREEROLL_TARGET_FIELD`.
   */
  targetField: number;

  /**
   * Jugadores inscritos que AUN NO tienen mesa.
   * Es la cola de espera: en cuanto una mesa tiene hueco, se le asigna uno.
   */
  waiting: number;

  /**
   * Jugadores con mesa asignada. NO son los que siguen en juego: los que
   * quedan vivos se calculan como `seated - eliminated`.
   */
  seated: number;

  /** Jugadores ya liquidados (eliminados o ganadores). */
  eliminated: number;

  /**
   * Jugadores VIVOS en todo el campo.
   * Es el contador que decide la posicion de cada eliminacion: si quedan 48
   * vivos, el que cae es el 48º. Se descuenta con filtro condicional para
   * que dos eliminaciones simultaneas no resten dos del mismo jugador.
   */
  playersRemaining: number;

  /**
   * Cuantas plazas pagadas quedan por repartir.
   * Baja conforme se adjudication. Cuando llega a 0, el resto del campo juega
   * por el bote pero no cobra, que es la norma.
   */
  paidPositionsLeft: number;

  /** Rake acumulado del campo entero. */
  rakeCollected: number;

  /**
   * Fichas de jugadores ya eliminados que ya no estan en ninguna mesa.
   *
   * ------------------------------------------------------------------
   * POR QUE HACE FALTA
   *
   * Cuando un jugador se elimina, sus fichas siguen siendo del campo: no vuelven
   * a su cartera (ver `collectEliminations`). Para que el asiento se libere y las
   * mesas puedan fusionarse, el asiento se borra de la mesa. Pero si las fichas se
   * borran con el, el dinero desaparece del libro de cuentas y la invariante de
   * conservacion falla.
   *
   * Asi que las fichas se salen de la mesa y entran aqui. `settleField` barre esta
   * cifra ademas de las mesas, y el total repartido sale de las dos.
   *
   * Sin esto, los asientos de los eliminados ocupaban plaza para siempre,
   * `seatsFree` daba 0 y ninguna mesa podia fusionarse: el campo se quedaba con
   * variosockets de jugadores vivos y no llegaba nunca a la mesa final. Lo
   * encontrado jugando un campo entero con el motor de verdad
   * (`scripts/test-e2e-engine.js`).
   */
  deadChips: number;

  /** Buy-ins cobrados, para cuadrar contra el rake. */
  buyInsCollected: number;

  /** Mesas que forman parte de este campo. */
  tables: FieldTable[];

  /** Numero de mesas de 7 que tendra el campo al llenarse. */
  plannedTables: number;

  /** Cuando arranco a jugarse (no cuando se abrio). */
  startedAt?: Date;

  /** Cuando se liquido. */
  finishedAt?: Date;

  /** Resultados del reparto, para el informe y para "mis premios". */
  results?: FieldResult[];

  /**
   * QUIEN PAGO, Y POR CUANTO.
   *
   * ------------------------------------------------------------------
   * POR QUE EXISTE ESTO
   *
   * `register()` cobraba el buy-in y subia un contador:
   *
   *     await this.chargeBuyIn(telegramId, buyIn);
   *     await Field.updateOne({_id}, { $inc: { waiting: 1, buyInsCollected: buyIn } });
   *
   * Un contador no tiene dueno. Cuando el campo se cancelaba no habia a quien devolverle
   * nada, porque el documento no guardaba ni un solo `telegramId`.
   *
   * Medido: tres jugadores, 3.000 unidades cobradas, campo cancelado, **0 devueltas**.
   *
   * Y peor: el contador se podia subir sin que hubiera nadie detras. El campo
   * `cash-t1-muwyjj37` tenia `buyInsCollected: 3000` y ningun deposito que lo explicara.
   *
   * Aqui se anota cada cobro con su `telegramId`. `buyInsCollected` sigue siendo la suma,
   * pero deja de ser la unica verdad: si los dos no cuadran, es que hay un fallo, y el
   * proximo test lo dira con el numero.
   */
  registrations: FieldRegistration[];

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Una entrada cobrada del campo.
 *
 * El `status` es lo que hace posible la regla de devolucion que se decidio en
 * `DECISIONES.md`:
 *
 *   - `waiting`    apuntado, aun sin asiento
 *   - `seated`     jugando
 *   - `eliminated` sus fichas fueron al bote; NO se le devuelve si el campo tiene premio real
 *   - `refunded`   ya se le devolvio el buy-in
 *
 * Sin este estado no se puede aplicar la regla B: habria que adivinar quien sigue vivo
 * mirando las mesas, y un jugador puede estar entre dos mesas durante una fusion.
 */
export interface FieldRegistration {
  telegramId: number;
  username?: string;
  /** Clave del catálogo de avatares, copiada al inscribirse. */
  avatar?: string;
  /** Lo que pago, en unidades internas. Se guarda aparte por si el buy-in cambia. */
  buyIn: number;
  status: 'waiting' | 'seated' | 'eliminated' | 'refunded';
  at: Date;
}

/** Referencia a una mesa del campo. */
export interface FieldTable {
  tableId: string;
  /** Asientos ocupados en esta mesa. */
  seated: number;
  /** Jugadores eliminados aqui. */
  eliminated: number;
  /**
   * Si esta mesa se fusiono con otra, donde termino su contenido.
   * Se conserva el registro para no perder la traza de que existio.
   */
  mergedInto?: string;
  createdAt: Date;
}

export interface FieldResult {
  /** Posicion final, 1-based. 1 = ganador del campo. */
  position: number;
  /**
   * Identificador del jugador humano. Para bots es 0: no tienen cuenta ni
   * saldo, y nunca se les paga. El campo `isBot` es el que los distingue.
   */
  telegramId: number;
  username?: string;
  /** Importe cobrado, en la moneda de la cuenta. */
  amount: number;
  /** Que mesa termino el jugador. */
  tableId?: string;
  /**
   * Identidad estable dentro del campo. Para humanos es el telegramId en
   * texto; para bots, el id del perfil. Sirve para no adjudicar dos veces la
   * misma posicion cuando `telegramId` vale 0 en todos los bots.
   */
  playerId?: string;
  /** true si la posicion la ocupa un bot de relleno. Nunca se paga. */
  isBot?: boolean;
}

const fieldTableSchema = new Schema<FieldTable>(
  {
    tableId: { type: String, required: true },
    seated: { type: Number, default: 0 },
    eliminated: { type: Number, default: 0 },
    mergedInto: String,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const fieldResultSchema = new Schema<FieldResult>(
  {
    position: { type: Number, required: true },
    telegramId: { type: Number, required: true },
    username: String,
    amount: { type: Number, required: true },
    tableId: String,
    playerId: String,
    isBot: { type: Boolean, default: false },
  },
  { _id: false },
);

const fieldRegistrationSchema = new Schema<FieldRegistration>(
  {
    telegramId: { type: Number, required: true },
    username: String,
    avatar: String,
    buyIn: { type: Number, required: true },
    status: {
      type: String,
      enum: ['waiting', 'seated', 'eliminated', 'refunded'],
      default: 'waiting',
    },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const fieldSchema = new Schema<IField>(
  {
    fieldId: { type: String, required: true, unique: true, index: true },

    kind: {
      type: String,
      enum: ['cash', 'freeroll', 'tournament'],
      default: 'cash',
    },
    tierId: String,
    prizeTier: Number,
    eventId: String,
    format: { type: String, enum: ['standard', 'spingo'] },

    status: {
      type: String,
      enum: ['filling', 'running', 'final', 'finished', 'cancelled'],
      default: 'filling',
      index: true,
    },

    buyInUnits: { type: Number, required: true },

    // Premio del freeroll o garantizado de un torneo. En el segundo caso la
    // casa solo lo completa si las entradas no llegan.
    prizePoolUnits: { type: Number, default: 0 },
    payoutTable: { type: [Number], default: undefined },
    overlayUnits: { type: Number, default: 0 },
    // Hora de arranque y fin del registro tardio. Los dos, para no repetir la regla.
    scheduledStartAt: Date,
    lateRegUntil: Date,
    // Fichas iniciales y ciegas del freeroll, ya calculadas.
    startChips: Number,
    smallBlind: Number,
    bigBlind: Number,

    targetField: { type: Number, required: true },

    waiting: { type: Number, default: 0 },
    seated: { type: Number, default: 0 },
    eliminated: { type: Number, default: 0 },
    playersRemaining: { type: Number, default: 0 },
    paidPositionsLeft: { type: Number, default: 0 },

    rakeCollected: { type: Number, default: 0 },
    deadChips: { type: Number, default: 0 },
    buyInsCollected: { type: Number, default: 0 },

    tables: { type: [fieldTableSchema], default: [] },
    plannedTables: { type: Number, default: 0 },

    startedAt: Date,
    finishedAt: Date,

    results: { type: [fieldResultSchema], default: [] },

    // Quien pago. Sin esto no se puede devolver un campo cancelado (ver `FieldRegistration`).
    registrations: { type: [fieldRegistrationSchema], default: [] },
  },
  { timestamps: true },
);

// El gestor busca campos jugables por estado. Indice compuesto porque la
// consulta siempre filtra por kind y status y ordena por createdAt.
fieldSchema.index({ kind: 1, status: 1, createdAt: 1 });
fieldSchema.index({ status: 1, 'tables.tableId': 1 });

// ----------------------------------------------------------------------
// UN SOLO CAMPO ABIERTO POR NIVEL, GARANTIZADO POR LA BASE
//
// `openField()` era un check-then-act: `findOne` y si no hay ninguno, `create`. Dos
// registros simultaneos leen ambos que no hay campo, y los dos crean uno. Medido:
//
//     20 registros concurrentes  ->  18 campos abiertos a la vez
//     cobrado de las carteras       20.000 unidades
//     dice el campo principal       2.000
//     DESAPARECIDO                18.000 unidades
//     waiting                       -1
//
// Y el `buyInsCollected: 3000` sin ningun deposito detras que se encontro en produccion
// no era un numero de pruebas: eran tres registros concurrentes peleandose el mismo
// campo, cada uno sumando mil, y el `field.save()` de uno pisando al otro.
//
// El indice unico parcial es lo unico que lo arregla de verdad: no es codigo que "se
// acuerde" de no hacerlo, es que la base NO DEJA. Y aguanta varios procesos a la vez,
// cosa que un cerrojo en memoria no.
//
// Solo aplica a los campos VIVOS (`filling`, `running`, `final`). Los terminados pueden
// convivir cuantos se quiera, que es lo que se quiere: el historico.
// ----------------------------------------------------------------------
fieldSchema.index(
  { tierId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['filling', 'running', 'final'] } },
    name: 'un_campo_vivo_por_nivel',
  },
);

export const Field = model<IField>('Field', fieldSchema);

/** Vista publica del campo para la API y la UI. */
export const toPublicField = (field: IField) => ({
  fieldId: field.fieldId,
  kind: field.kind,
  tierId: field.tierId,
  prizeTier: field.prizeTier,
  eventId: field.eventId,
  format: field.format,
  status: field.status,
  buyIn: field.buyInUnits,
  prizePoolUnits: field.prizePoolUnits ?? 0,
  payoutTable: field.payoutTable ?? [],
  scheduledStartAt: field.scheduledStartAt,
  lateRegUntil: field.lateRegUntil,
  startChips: field.startChips,
  smallBlind: field.smallBlind,
  bigBlind: field.bigBlind,
  targetField: field.targetField,
  waiting: field.waiting,
  seated: field.seated,
  eliminated: field.eliminated,
  playersRemaining: field.playersRemaining,
  paidPositionsLeft: field.paidPositionsLeft,
  tables: field.tables
    .filter(t => !t.mergedInto)
    .map(t => ({ tableId: t.tableId, seated: t.seated })),
  plannedTables: field.plannedTables,
  rakeCollected: field.rakeCollected,
  startedAt: field.startedAt,
  finishedAt: field.finishedAt,
});
