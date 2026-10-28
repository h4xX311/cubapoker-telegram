import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type { FreerollCampo, FreerollSlot } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { fmtUsdt, fmtStake } from '../components/Balance';
import { fmtCuenta, horaLocal, segundosHasta } from '../lib/tiempo';

interface Props {
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
  onPlay: (tableId: string) => void;
}

const POSICIONES = ['1.º', '2.º', '3.º', '4.º', '5.º'];

/**
 * FREEROLLS MULTIMESA
 * ===================
 *
 * Cuatro ediciones al día, gratis, con premio en saldo de promoción. Cada una
 * reparte un premio distinto: 50, 20, 10 y 5 USDT. La página hace tres cosas:
 *
 *   1. Cuenta atras real hasta el inicio. Sin ella, el jugador no sabe si le da tiempo.
 *   2. Inscribe y desinscribe. El boton cambia de estado segun si ya esta dentro.
 *   3. Entra a la mesa cuando el torneo ya empezo. Si el jugador cierra la app y vuelve,
 *      aqui tiene el camino de vuelta.
 *
 * La cuenta atras se calcula en el cliente con la hora ISO del servidor. El servidor no
 * manda "faltan 12 minutos" porque ese numero caduca en cuanto sale de la respuesta.
 */
export function Freeroll({ onBack, onBalanceChange, onPlay }: Props) {
  const [datos, setDatos] = useState<{
    abierto: FreerollCampo | null;
    enJuego: FreerollCampo[];
    proximos: FreerollSlot[];
  } | null>(null);

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  const cargar = async () => {
    try {
      const res = await api.freerolls();
      setDatos({
        abierto: res.abierto ?? null,
        enJuego: res.enJuego ?? [],
        proximos: res.proximos ?? [],
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudieron cargar los freerolls.',
      );
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    cargar();
    // Cada 10 s se refresca el numero de inscritos. La cuenta atras va por su cuenta.
    const timer = setInterval(cargar, 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Cuando la cuenta atras llega a cero, el torneo esta arrancando. Se recarga para que el
  // campo abierto pase a "en juego" sin que el jugador tenga que hacer nada.
  const segundosAlInicio = segundosHasta(datos?.abierto?.inicio, ahora);
  useEffect(() => {
    if (!datos?.abierto || segundosAlInicio > 0) return;
    const timer = setTimeout(cargar, 1500);
    return () => clearTimeout(timer);
  }, [segundosAlInicio, datos?.abierto?.fieldId]);

  const inscribir = async (fieldId: string) => {
    setOcupado(fieldId);
    setError('');
    try {
      await api.registerFreeroll(fieldId);
      await onBalanceChange?.();
      await cargar();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo inscribir.',
      );
    } finally {
      setOcupado(null);
    }
  };

  const salir = async (fieldId: string) => {
    setOcupado(fieldId);
    setError('');
    try {
      await api.leaveFreeroll(fieldId);
      await cargar();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo cancelar.',
      );
    } finally {
      setOcupado(null);
    }
  };

  const entrarAMesa = async (fieldId: string) => {
    setError('');
    try {
      const r = await api.myTables();
      const mesa = (r?.tables ?? []).find(
        (t) => t.field?.fieldId === fieldId,
      );
      if (mesa?.tableId) {
        onPlay(mesa.tableId);
      } else {
        setError(
          'Tu mesa se esta preparando. Espera unos segundos y vuelve a intentarlo.',
        );
      }
    } catch {
      setError('No se pudo abrir tu mesa. Intentalo de nuevo.');
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn lg:px-0">
      <PageHeader title="Freerolls" onBack={onBack} />

      {/* Explicacion del producto, en una linea. */}
      <div
        className="rounded-2xl p-4 mb-5"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,215,0,0.12) 0%, rgba(255,183,0,0.04) 100%)',
          border: '1px solid rgba(255,215,0,0.3)',
        }}
      >
        <div className="flex items-start gap-3">
          <span className="text-2xl">🎁</span>
          <div>
            <p className="text-sm font-bold text-[#ffd700] mb-1">
              Cuatro torneos gratis al día
            </p>
            <p className="text-xs text-[#a0a0b0] leading-relaxed">
              Ediciones multimesa con premios de 50, 20, 10 y 5 USDT. El premio
              es saldo de promoción: se juega y se desbloquea 1 USDT por cada 10
              USDT jugados a saldo retirable.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-sm text-[#ff8a94]">{error}</p>
        </div>
      )}

      {cargando ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* ---------------- Proximo torneo ---------------- */}
          {datos?.abierto && (
            <div className="lg:col-span-2">
              <TarjetaProximo
                campo={datos.abierto}
                segundos={segundosAlInicio}
                ocupado={ocupado === datos.abierto.fieldId}
                onInscribir={() => inscribir(datos.abierto!.fieldId)}
                onSalir={() => salir(datos.abierto!.fieldId)}
              />
            </div>
          )}

          {/* ---------------- En juego, registro tardio ---------------- */}
          {datos?.enJuego?.map((campo) => {
            const restante = segundosHasta(campo.finRegistro, ahora);
            return (
              <article
                key={campo.fieldId}
                className="card relative overflow-hidden"
                style={{ borderColor: 'rgba(0,210,106,0.45)' }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <span className="badge badge-success text-[10px]">
                      EN JUEGO
                    </span>
                    <h3 className="font-bold text-white mt-2">
                      Freeroll de las {campo.inicio ? horaLocal(campo.inicio) : ''}
                    </h3>
                    <p className="text-xs text-[#a0a0b0] mt-1">
                      {campo.jugadoresVivos} jugadores vivos · premio{' '}
                      {fmtUsdt(campo.premioUsdt)} USDT
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] text-[#a0a0b0] uppercase">
                      Tardío cierra en
                    </p>
                    <p className="text-lg font-bold text-[#00d26a] tabular-nums">
                      {fmtCuenta(restante)}
                    </p>
                  </div>
                </div>

                {campo.inscrito ? (
                  <button
                    onClick={() => entrarAMesa(campo.fieldId)}
                    className="w-full btn btn-primary py-2.5 text-sm"
                  >
                    Entrar a mi mesa
                  </button>
                ) : (
                  <button
                    onClick={() => inscribir(campo.fieldId)}
                    disabled={ocupado === campo.fieldId}
                    className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50"
                  >
                    {ocupado === campo.fieldId
                      ? 'Entrando…'
                      : 'Entrar ahora (registro tardío)'}
                  </button>
                )}
              </article>
            );
          })}

          {/* ---------------- Proximas ediciones ---------------- */}
          {datos?.proximos && datos.proximos.length > 0 && (
            <section className="lg:col-span-2">
              <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
                Próximas ediciones
              </h2>
              <div className="grid gap-2 lg:grid-cols-2">
                {datos.proximos.map((slot) => (
                  <div
                    key={slot.clave}
                    className="flex items-center justify-between rounded-xl px-4 py-3"
                    style={{
                      background: '#151525',
                      border: '1px solid #2a2a4a',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg">🕐</span>
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {horaLocal(slot.inicio)}
                        </p>
                        <p className="text-[10px] text-[#a0a0b0]">
                          Gratis · {fmtUsdt(slot.premioUsdt)} USDT de premio
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] text-[#6c6c80]">
                      {fmtCuenta(segundosHasta(slot.inicio, ahora))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!datos?.abierto && !datos?.enJuego?.length && (
            <div className="card text-center py-8 lg:col-span-2">
              <p className="text-3xl mb-2">🕐</p>
              <p className="text-sm text-white font-semibold">
                El próximo freeroll se abre en un momento
              </p>
              <p className="text-xs text-[#a0a0b0] mt-1">
                Cuatro ediciones al día, cada seis horas.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** La tarjeta del proximo torneo: la cuenta atras es el elemento principal. */
function TarjetaProximo({
  campo,
  segundos,
  ocupado,
  onInscribir,
  onSalir,
}: {
  campo: FreerollCampo;
  segundos: number;
  ocupado: boolean;
  onInscribir: () => void;
  onSalir: () => void;
}) {
  const lleno = campo.inscritos >= campo.tamanoMaximo;

  return (
    <article
      className="rounded-2xl p-5 relative overflow-hidden animate-slideUp"
      style={{
        background: 'linear-gradient(150deg, #2a2410 0%, #151525 60%, #0f0f1a 100%)',
        border: '1px solid rgba(255,215,0,0.35)',
      }}
    >
      <div
        className="absolute -top-10 -right-10 w-36 h-36 rounded-full opacity-20"
        style={{ background: '#ffd700' }}
      />

      <header className="relative flex items-start justify-between mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#ffd700] font-bold">
            Próximo torneo
          </p>
          <h2 className="text-2xl font-bold text-white mt-1">
            {campo.inicio ? horaLocal(campo.inicio) : '—'}
          </h2>
          <p className="text-xs text-[#a0a0b0] mt-1">
            {campo.inscritos} de {campo.tamanoMaximo} inscritos · mesas de{' '}
            {campo.maxPorMesa}
          </p>
        </div>
        {campo.inscrito && (
          <span className="badge badge-success text-[10px]">APUNTADO</span>
        )}
      </header>

      {/* Cuenta atras */}
      <div className="relative text-center py-4 mb-4 rounded-xl" style={{ background: 'rgba(0,0,0,0.35)' }}>
        <p className="text-[10px] text-[#a0a0b0] uppercase tracking-widest mb-1">
          Empieza en
        </p>
        <p className="text-4xl font-bold text-[#ffd700] tabular-nums leading-none">
          {fmtCuenta(segundos)}
        </p>
      </div>

      {/* Premio y reparto */}
      <div className="relative mb-4">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
            Premio total
          </span>
          <span className="text-xl font-bold text-[#00d26a]">
            {fmtUsdt(campo.premioUsdt)} USDT
          </span>
        </div>
        <div className="flex gap-2">
          {campo.reparto.map((pct, i) => (
            <div
              key={i}
              className="flex-1 text-center p-2 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            >
              <p className="text-[9px] text-[#a0a0b0]">
                {POSICIONES[i] ?? `${i + 1}.º`}
              </p>
              <p className="text-xs font-bold text-white">
                {fmtStake((campo.premioUsdt * pct) / 100)}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="relative flex gap-2">
        {campo.inscrito ? (
          <>
            <button
              onClick={onSalir}
              disabled={ocupado}
              className="flex-1 btn btn-outline py-2.5 text-sm disabled:opacity-50"
            >
              {ocupado ? 'Cancelando…' : 'Cancelar inscripción'}
            </button>
            <button
              onClick={onInscribir}
              disabled
              className="flex-1 btn btn-primary py-2.5 text-sm opacity-60"
            >
              Estás dentro
            </button>
          </>
        ) : (
          <button
            onClick={onInscribir}
            disabled={ocupado || lleno}
            className="w-full btn btn-gold py-3 text-sm disabled:opacity-50"
          >
            {lleno
              ? 'Campo completo'
              : ocupado
                ? 'Inscribiendo…'
                : 'Inscribirme gratis'}
          </button>
        )}
      </div>
    </article>
  );
}
