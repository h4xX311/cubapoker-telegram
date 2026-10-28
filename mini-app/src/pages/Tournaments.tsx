import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';
import { fmtUsdt } from '../components/Balance';
import { fmtCuenta, horaLocal, segundosHasta } from '../lib/tiempo';
import type { TournamentLobbyEntry } from '../lib/types';

interface Props {
  onBack: () => void;
  onPlay: (tableId: string) => void;
}

/**
 * TORNEOS Y SPIN & GO
 * ===================
 *
 * El buy-in y el premio van emparejados. El calendario profesional tiene un
 * Main diario de 500 USDT, cuatro High de 300, cuatro Medios de 200, ocho Low
 * de 100 y microtorneos cada hora con garantizados de 50, 20, 10 y 5 USDT.
 * Si el campo no se llena, la casa completa la garantía; el jugador no tiene
 * que esperar a que se llene para saber cuánto hay en juego.
 *
 * Los torneos programados arrancan con dos jugadores o se cancelan con
 * devolución del buy-in. Un Spin & Go es un 3-max que arranca al llenarse; si
 * no se llena, se completa automáticamente a los 6 minutos en algunos campos y
 * se reembolsa como máximo a los 9.
 */
export function Tournaments({ onBack, onPlay }: Props) {
  const [torneos, setTorneos] = useState<TournamentLobbyEntry[]>([]);
  const [spin, setSpin] = useState<TournamentLobbyEntry[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [filtro, setFiltro] = useState('todos');

  const cargar = async () => {
    try {
      const data = await api.tournaments();
      setTorneos(data.torneos ?? []);
      setSpin(data.spin ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los torneos.');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargar();
    const reloj = setInterval(() => setNow(Date.now()), 1000);
    const refresco = setInterval(() => void cargar(), 15000);
    return () => {
      clearInterval(reloj);
      clearInterval(refresco);
    };
  }, []);

  const entrar = async (entry: TournamentLobbyEntry) => {
    setBusy(entry.id);
    setError('');
    try {
      const result = await api.registerTournament(entry.id);
      if (result?.fieldId) onPlay(result.fieldId);
      else await cargar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo inscribir.');
    } finally {
      setBusy(null);
    }
  };

  const salir = async (entry: TournamentLobbyEntry) => {
    if (!entry.fieldId) return;
    setBusy(entry.id);
    setError('');
    try {
      await api.leaveTournament(entry.fieldId);
      await cargar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cancelar la inscripcion.');
    } finally {
      setBusy(null);
    }
  };

  const categoria = (entry: TournamentLobbyEntry): string => {
    if (entry.id === 'daily-main') return 'main';
    if (entry.id === 'high-300') return 'high';
    if (entry.id === 'medium-200') return 'medio';
    if (entry.id === 'daily-micro') return 'low';
    if (entry.id.startsWith('micro-')) return 'micro';
    return 'especial';
  };

  const visibles =
    filtro === 'todos'
      ? torneos
      : torneos.filter((entry) => categoria(entry) === filtro);

  const Tarjeta = ({ entry }: { entry: TournamentLobbyEntry }) => {
    const inicio = entry.startsAt ? segundosHasta(entry.startsAt, now) : 0;
    const registroAbierto = entry.status === 'running'
      ? segundosHasta(entry.lateRegUntil, now) > 0
      : entry.status === 'filling' || entry.status === 'scheduled';
    const puedeEntrar = !entry.inscrito && registroAbierto;
    const premio = Math.max(
      entry.premioGarantizadoUsdt,
      entry.premioActualUsdt,
    );
    const esperandoSpin =
      entry.kind === 'spingo' && entry.status === 'filling';
    const reembolsoEn =
      esperandoSpin && entry.spinRefundAt
        ? Math.max(0, segundosHasta(entry.spinRefundAt, now))
        : 0;

    return (
      <div className="card p-4" style={{ background: '#16213e' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-white">{entry.label}</h3>
              {entry.kind === 'spingo' && (
                <span className="text-[9px] px-2 py-0.5 rounded-full font-bold"
                  style={{ background: 'rgba(255,215,0,0.15)', color: '#ffd700' }}>
                  3-MAX
                </span>
              )}
              {entry.inscrito && (
                <span className="text-[9px] px-2 py-0.5 rounded-full font-bold"
                  style={{ background: 'rgba(0,210,106,0.15)', color: '#00d26a' }}>
                  INSCRITO
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#a0a0b0] mt-1 leading-relaxed">
              {entry.description}
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] text-[#a0a0b0]">BUY-IN</div>
            <div className="text-lg font-bold text-[#ffd700]">{fmtUsdt(entry.buyInUsdt)}</div>
            <div className="text-[9px] text-[#a0a0b0]">USDT</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
          <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="text-[9px] text-[#a0a0b0]">PREMIO GARANTIZADO</div>
            <div className="text-sm font-bold text-[#00d26a]">{fmtUsdt(premio)} USDT</div>
          </div>
          <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="text-[9px] text-[#a0a0b0]">JUGADORES</div>
            <div className="text-sm font-bold text-white">
              {entry.jugadores}/{entry.fieldSize}
            </div>
          </div>
          <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="text-[9px] text-[#a0a0b0]">PUNTOS</div>
            <div className="text-sm font-bold text-white">
              {entry.startingChips.toLocaleString('es-ES')}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mt-3 text-[10px] text-[#a0a0b0]">
          <span>
            {entry.scheduled && entry.startsAt
              ? `Empieza ${horaLocal(entry.startsAt)} · faltan ${fmtCuenta(inicio)}`
              : 'Arranca cuando se llenen las 3 plazas'}
          </span>
          <span>{entry.payout.map((p) => `${p}%`).join(' / ')}</span>
        </div>

        {esperandoSpin && (
          <p className="text-[10px] text-[#ffd700] mt-2 leading-relaxed">
            {entry.jugadores > 0
              ? `Esperando jugadores (${entry.jugadores}/3). Si no se completa, la entrada se devuelve en ${fmtCuenta(reembolsoEn)}.`
              : 'Mesa abierta: arranca en cuanto se ocupen las tres plazas.'}
          </p>
        )}

        <div className="flex gap-2 mt-3">
          {entry.inscrito ? (
            <>
              {entry.fieldId && (
                <button
                  className="flex-1 py-2 rounded-xl font-bold text-sm"
                  style={{ background: '#00d26a', color: '#07120c' }}
                  onClick={() => onPlay(entry.fieldId!)}
                >
                  Ir a mi mesa
                </button>
              )}
              {entry.status === 'filling' && entry.fieldId && (
                <button
                  className="px-4 py-2 rounded-xl text-sm font-bold"
                  style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }}
                  disabled={busy === entry.id}
                  onClick={() => void salir(entry)}
                >
                  Cancelar
                </button>
              )}
            </>
          ) : (
            <button
              className="flex-1 py-2 rounded-xl font-bold text-sm disabled:opacity-50"
              style={{
                background: puedeEntrar ? '#00d26a' : 'rgba(255,255,255,0.08)',
                color: puedeEntrar ? '#07120c' : '#a0a0b0',
              }}
              disabled={!puedeEntrar || busy === entry.id}
              onClick={() => void entrar(entry)}
            >
              {busy === entry.id
                ? 'Entrando…'
                : entry.status === 'running'
                  ? 'Entrar (registro tardio)'
                  : `Jugar por ${fmtUsdt(entry.buyInUsdt)} USDT`}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 pb-24 animate-fadeIn lg:px-0">
      <PageHeader title="Torneos" onBack={onBack} />

      <div className="rounded-xl p-3 mb-5"
        style={{ background: 'rgba(0,210,106,0.08)', border: '1px solid rgba(0,210,106,0.25)' }}>
        <p className="text-[11px] text-[#a0a0b0] leading-relaxed">
          El buy-in depende del premio: cuanto mayor es la garantía, mayor es la
          entrada. Los premios se pagan en USDT retirable. El stack de la mesa
          son puntos del torneo, no dinero de tu monedero.
        </p>
      </div>

      {error && (
        <div className="rounded-xl p-3 mb-4 text-[12px]"
          style={{ background: 'rgba(255,80,80,0.12)', color: '#ff8a8a' }}>
          {error}
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3">
        {[
          ['todos', 'Todos'],
          ['main', 'Main'],
          ['high', 'High'],
          ['medio', 'Medio'],
          ['low', 'Low'],
          ['micro', 'Micro'],
          ['especial', 'Especial'],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFiltro(id)}
            className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold transition-colors"
            style={
              filtro === id
                ? { background: '#00d26a', color: '#07120c' }
                : { background: '#151525', color: '#a0a0b0' }
            }
          >
            {label}
          </button>
        ))}
      </div>

      <SectionLabel>Spin & Go · 3-max</SectionLabel>
      <div className="grid gap-3 mb-6 lg:grid-cols-2 xl:grid-cols-3">
        {spin.map((entry) => <Tarjeta key={entry.id} entry={entry} />)}
      </div>

      <SectionLabel>Torneos programados</SectionLabel>
      {cargando ? (
        <p className="text-[#a0a0b0] text-sm">Cargando torneos…</p>
      ) : visibles.length === 0 ? (
        <p className="text-[#a0a0b0] text-sm">No hay torneos de esta categoría ahora mismo.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {visibles.map((entry) => <Tarjeta key={entry.id} entry={entry} />)}
        </div>
      )}

      <p className="text-[10px] text-[#a0a0b0] mt-6 leading-relaxed">
        Los torneos programados arrancan con dos jugadores como mínimo. Si no se
        llenan, se cancelan y se devuelve el buy-in. La garantía se completa con
        overlay de la casa; no se paga con el saldo de otros jugadores.
      </p>
    </div>
  );
}
