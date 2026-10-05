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

export type FieldKind = 'cash' | 'freeroll';

export type FieldStatus =
  /** Aceptando inscripciones. No se juega todavia. */
  | 'filling'
  /** Las mesas estan repartiendo fichas. */
  | 'running'
  /** Queda una sola mesa: es la final. */
  | 'final'
  /** Liquidado. El premio esta repartido. */
  | 'finished';

export interface IField extends Document {
  /** Identificador del campo, como `cash-t500-a7f3k2` */
  fieldId: string;

  kind: FieldKind;

  /** Tier de cash, si aplica. Un freeroll usa `prizeTier`. */
  tierId?: string;
  /** Premio garantizado del escalon (freerolls). */
  prizeTier?: number;

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

  createdAt: Date;
  updatedAt: Date;
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
  telegramId: number;
  username?: string;
  /** Importe cobrado, en la moneda de la cuenta. */
  amount: number;
  /** Que mesa termino el jugador. */
  tableId?: string;
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
  },
  { _id: false },
);

const fieldSchema = new Schema<IField>(
  {
    fieldId: { type: String, required: true, unique: true, index: true },

    kind: { type: String, enum: ['cash', 'freeroll'], default: 'cash' },
    tierId: String,
    prizeTier: Number,

    status: {
      type: String,
      enum: ['filling', 'running', 'final', 'finished'],
      default: 'filling',
      index: true,
    },

    buyInUnits: { type: Number, required: true },

    targetField: { type: Number, required: true },

    waiting: { type: Number, default: 0 },
    seated: { type: Number, default: 0 },
    eliminated: { type: Number, default: 0 },
    playersRemaining: { type: Number, default: 0 },
    paidPositionsLeft: { type: Number, default: 0 },

    rakeCollected: { type: Number, default: 0 },
    buyInsCollected: { type: Number, default: 0 },

    tables: { type: [fieldTableSchema], default: [] },
    plannedTables: { type: Number, default: 0 },

    startedAt: Date,
    finishedAt: Date,

    results: { type: [fieldResultSchema], default: [] },
  },
  { timestamps: true },
);

// El gestor busca campos jugables por estado. Indice compuesto porque la
// consulta siempre filtra por kind y status y ordena por createdAt.
fieldSchema.index({ kind: 1, status: 1, createdAt: 1 });
fieldSchema.index({ status: 1, 'tables.tableId': 1 });

export const Field = model<IField>('Field', fieldSchema);

/** Vista publica del campo para la API y la UI. */
export const toPublicField = (field: IField) => ({
  fieldId: field.fieldId,
  kind: field.kind,
  tierId: field.tierId,
  prizeTier: field.prizeTier,
  status: field.status,
  buyIn: field.buyInUnits,
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
